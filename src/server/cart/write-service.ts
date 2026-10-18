import { z } from 'zod';
import { contentHash, type AdapterPrincipal } from '../contracts/guards.js';
import { evaluateCandidate } from '../domain/eligibility.js';
import { evaluatePlan, planCoverage } from '../domain/group.js';
import { normalizeItemDetail, normalizeListingItem } from '../domain/normalize.js';
import { knownRestrictions, type PurchaseState } from '../domain/purchase.js';
import { allocateCosts } from '../domain/purchase-costs.js';
import { addCents, multiplyCents } from '../domain/money.js';
import type { IfoodLinkService, OperationalContext, Operation } from '../links/service.js';
import { CartError, assertMutationConfirmation, confirmedTotals, id, parseCreatedCart, parseItem, parseSnapshot, payload, type CartGateway, type Snapshot } from './contracts.js';
import type { CartContractGate } from './write-contract.js';
import { CartWriteStore, type Head, type HumanCartCommand, type Intent, type WritePlan, type WriteStep } from './write-store.js';

type Item = { itemId: string; quantity: number; options: { optionId: string; quantity: 1 }[] };
const itemKey = (i: { itemId: string; options: { optionId: string; quantity: number }[] }) =>
  contentHash([i.itemId, [...i.options].sort((a,b) => a.optionId.localeCompare(b.optionId))]);
const composition = (items: Snapshot['items'] | Item[]) => items.map(i => ({
  itemId: i.itemId, quantity: i.quantity, options: [...i.options].sort((a,b) => a.optionId.localeCompare(b.optionId)),
})).sort((a,b) => itemKey(a).localeCompare(itemKey(b)));

/** CART-01: único caminho operacional de escrita. Não possui método de pagamento ou envio de pedido. */
export class ConfirmedCartService {
  constructor(readonly store: CartWriteStore, private readonly links: Pick<IfoodLinkService, 'withOperational' | 'status'>,
    private readonly contract: CartContractGate) {}

  private async current(p: AdapterPrincipal, linkId: string, write = true) {
    const status = await this.links.status(p.organizerId);
    if (status.state !== 'CONNECTED' || !status.operational || status.linkId !== linkId || status.attempt)
      throw new CartError('CART_LINK_CHANGED', 'Confirme o vínculo operacional atual antes de continuar.');
    const required: Operation[] = write ? ['CART_WRITE','OFFERS_EVALUATE'] : ['CART_READ'];
    if (status.scopeEvidence !== 'TOKEN_SCOPES' || !required.every(op => status.allowedOperations.includes(op)))
      throw new CartError('CART_PERMISSIONS_UNVERIFIED', 'Permissões desta operação não estão comprovadas no vínculo.', 403);
  }
  private using<T>(p: AdapterPrincipal, fn: (ctx: OperationalContext, gateway: CartGateway) => Promise<T>, write = true) {
    if (p.organizerId !== p.conversationId) throw new CartError('INVALID_SOURCE', 'Confirmação exige conversa privada.', 403);
    const use = () => this.links.withOperational(p.organizerId, write ? 'CART_WRITE' : 'CART_READ', async ctx => {
        if (!ctx.cart) throw new CartError('CART_UNAVAILABLE', 'Sessão de carrinho indisponível.', 503);
        await this.current(p, ctx.linkId, write);
        return fn(ctx, ctx.cart);
      });
    return write ? this.links.withOperational(p.organizerId, 'OFFERS_EVALUATE', use) : use();
  }
  private async read(p: AdapterPrincipal, state: PurchaseState, gateway: CartGateway, cartId: string, write = true) {
    await this.current(p, state.linkId!, write);
    const raw = await gateway.call('getCart', { cartId });
    await this.current(p, state.linkId!, write);
    const snapshot = parseSnapshot(raw);
    if (snapshot.cartId !== cartId || state.address.state !== 'DECLARED' || state.merchant.state !== 'DECLARED' ||
      snapshot.addressId !== state.address.value.addressId || snapshot.merchantId !== state.merchant.value.merchantId)
      throw new CartError('CART_IDENTITY_MISMATCH', 'Carrinho, loja ou endereço divergem da compra.');
    const fingerprint = contentHash(payload(raw));
    this.store.saveHead(p, state, cartId, snapshot, fingerprint);
    return { cartId, snapshot, fingerprint, purchaseId: state.purchaseId } satisfies Head;
  }
  private async validate(p: AdapterPrincipal, ctx: OperationalContext) {
    const state = this.store.purchase(p), bag = state.bag, purchaseHash = contentHash(state);
    if (state.linkId !== ctx.linkId || !bag || bag.status !== 'CURRENT' || state.address.state !== 'DECLARED' ||
      state.merchant.state !== 'DECLARED' || bag.addressId !== state.address.value.addressId || bag.merchantId !== state.merchant.value.merchantId)
      throw new CartError('CART_BAG_UNVERIFIED', 'Selecione uma proposta atual com loja, endereço e vínculo verificados.');
    const coverage = planCoverage(state, bag), evaluated = evaluatePlan(state, bag, coverage);
    if (!evaluated.valid || coverage.some(c => c.status !== 'COVERED') || state.clarifications.length ||
      [state.groupLimit, ...state.participants.map(x => x.limit)].some(l => l.state === 'UNCLEAR' || l.state === 'NOT_ASKED'))
      throw new CartError('CART_GROUP_BLOCKED', 'Cobertura, restrições ou limites do grupo não estão verificados.');
    id.parse(bag.merchantId); id.parse(bag.addressId);
    const addresses = await ctx.deps.listAddresses();
    const address = addresses.results.find(a => a.addressId === bag.addressId);
    const location = z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) }).parse(address?.coordinates);
    const checks: unknown[] = [], items = new Map<string, Item>();
    for (const line of bag.lines) {
      id.parse(line.itemId);
      const listingResult = z.object({ results: z.array(z.object({ itemId: id,
        merchant: z.object({ merchantId: id }).passthrough() }).passthrough()) }).parse(payload(
        await ctx.deps.searchOffers({ query: line.name, userLocation: location, resultKind: 'ITEM', pageSize: 40 }, { timeoutMs: 10_000 })));
      const rows = listingResult.results.filter(r => r.itemId === line.itemId && r.merchant?.merchantId === bag.merchantId);
      if (rows.length !== 1) throw new CartError('CART_ITEM_UNAVAILABLE', 'Produto não apareceu univocamente na leitura atual.');
      const rawDetail = await ctx.deps.getItem({ itemId: line.itemId, merchantId: bag.merchantId, userLocation: location }, { timeoutMs: 10_000 });
      parseItem(rawDetail); // também bloqueia variantes/customizações não suportadas
      const detail = normalizeItemDetail(rawDetail), listing = normalizeListingItem(rows[0]);
      const options = line.optionIds.map(optionId => ({ optionId: id.parse(optionId), quantity: 1 as const }));
      for (const consumerId of line.consumerIds) {
        const person = state.participants.find(x => x.participantId === consumerId);
        const restrictions = person && knownRestrictions(state, person);
        if (!restrictions) throw new CartError('CART_RESTRICTIONS_UNKNOWN', 'Restrições não verificadas.');
        const candidate = evaluateCandidate({ listing, detail, serverFilters: [], selection: options, quantity: line.quantity }, { restrictions });
        const range = candidate.pricing.selected?.unitTotalRange;
        if (!candidate.eligible || !range || range.min === null || range.max !== range.min)
          throw new CartError('CART_ITEM_BLOCKED', 'Configuração, disponibilidade, preço ou segurança alimentar não verificáveis.');
        if (range.min !== line.unitMinCents || range.max !== line.unitMaxCents)
          throw new CartError('CART_PRICE_CHANGED', 'O preço mudou; gere outra proposta e confirme a nova revisão.');
      }
      checks.push([listing, detail, options]);
      const item: Item = { itemId: line.itemId, quantity: line.quantity, options }, key = itemKey(item);
      const previous = items.get(key);
      if (previous) previous.quantity += item.quantity; else items.set(key, item);
      if (items.get(key)!.quantity > 20) throw new CartError('CART_QUANTITY_UNSUPPORTED', 'Quantidade agregada excede o contrato suportado.');
    }
    if (!items.size || items.size > 20) throw new CartError('CART_QUANTITY_UNSUPPORTED', 'Quantidade de linhas fora do contrato.');
    await this.current(p, ctx.linkId); this.store.assertUnchanged(p, purchaseHash);
    return { state, purchaseHash, validationHash: contentHash([location, checks]), items: [...items.values()], evaluated };
  }
  private steps(items: Item[], head: Head | null): WriteStep[] {
    if (!head) return [{ tool: 'createCart', args: { items } }];
    if (!head.snapshot) throw new CartError('CART_READ_REQUIRED', 'Consulte o carrinho antes de preparar nova escrita.');
    const existing = head.snapshot.items;
    if (new Set(existing.map(itemKey)).size !== existing.length || existing.some(i => i.customerNote))
      throw new CartError('CART_COMPOSITION_UNSUPPORTED', 'Composição remota exige revisão antes de ser alterada.');
    const desired = new Map(items.map(i => [itemKey(i), i])), found = new Set<string>(), steps: WriteStep[] = [];
    for (const item of existing) {
      const key = itemKey(item), next = desired.get(key); found.add(key);
      if (!next) steps.push({ tool: 'removeItemFromCart', args: { cartItemId: item.cartItemId } });
      else if (next.quantity !== item.quantity) steps.push({ tool: 'updateCartItem', args: { ...next, cartItemId: item.cartItemId } });
    }
    for (const [key, item] of desired) if (!found.has(key)) steps.push({ tool: 'addItemToCart', args: { ...item } });
    if (!steps.length) throw new CartError('CART_ALREADY_MATCHES', 'O carrinho já corresponde à sacola; nenhuma escrita necessária.');
    const order = { removeItemFromCart:0,updateCartItem:1,addItemToCart:2,createCart:3 };
    return steps.sort((a,b) => order[a.tool]-order[b.tool]);
  }
  async prepare(p: AdapterPrincipal) {
    this.store.assertNotBlocked(p);
    return this.using(p, async (ctx, gateway) => {
      const check = await this.validate(p, ctx), { state } = check;
      let head = this.store.head(p, state);
      if (head) head = await this.read(p, state, gateway, head.cartId);
      const steps = this.steps(check.items, head);
      if (steps[0]!.tool === 'createCart') Object.assign(steps[0]!.args, { merchantId: state.bag!.merchantId, addressId: state.bag!.addressId });
      await this.contract.verify(gateway, steps.map(s => s.tool), steps.map(s => ({...s,args:{...s.args,...(head ? {cartId:head.cartId} : {})}})));
      await this.current(p, ctx.linkId);
      const plan: WritePlan = { purpose: 'PREPARE_CART', purchaseId: state.purchaseId, version: state.version, linkId: ctx.linkId,
        merchantId: state.bag!.merchantId, addressId: state.bag!.addressId!, purchaseHash: check.purchaseHash,
        validationHash: check.validationHash, remoteHash: head?.fingerprint ?? null, steps,
        observedSubtotalCents: addCents(...state.bag!.lines.map(l => multiplyCents(l.unitMinCents,l.quantity))), unknownCosts: true,
        expiresAt: this.store.now() + 300_000 };
      return { ...this.store.review(p, plan), lines: state.bag!.lines, coverage: check.evaluated.coverage,
        changes: steps, remoteItems: head?.snapshot?.items ?? [],
        remoteCosts: head?.snapshot?.totals ?? null, purchaseAuthorized: false, checkoutEnabled: false };
    });
  }
  private result(intent: Intent) {
    return { operationId: intent.id, state: intent.state, completedOperations: intent.step, code: intent.code,
      purpose: 'PREPARE_CART', purchaseAuthorized: false, checkoutEnabled: false, paymentEnabled: false };
  }
  async confirm(p: AdapterPrincipal, command: HumanCartCommand) {
    const replay = this.store.find(p, command);
    if (replay) return Promise.resolve(this.result(replay)); // jamais reexecuta, inclusive PENDING após reinício
    this.store.assertNotBlocked(p);
    const plan = this.store.readReview(p, command.confirmationRef);
    return this.using(p, async (ctx, gateway) => {
      const check = await this.validate(p, ctx);
      if (plan.validationHash !== check.validationHash || plan.purchaseHash !== check.purchaseHash)
        throw new CartError('CART_REVIEW_CHANGED', 'Catálogo ou composição mudou; solicite nova confirmação.');
      let head = this.store.head(p, check.state);
      await this.contract.verify(gateway, plan.steps.map(s => s.tool), plan.steps.map(s => ({...s,args:{...s.args,...(head ? {cartId:head.cartId} : {})}})));
      if (head) head = await this.read(p, check.state, gateway, head.cartId);
      if ((head?.fingerprint ?? null) !== plan.remoteHash) throw new CartError('CART_REMOTE_CHANGED', 'Carrinho alterado externamente; revise e confirme novamente.');
      await this.current(p, plan.linkId);
      const intent = this.store.reserve(p, command, plan);
      let cartId = head?.cartId ?? null;
      let sent = false;
      try {
        for (const [index, step] of plan.steps.entries()) {
          const fresh = await this.validate(p, ctx);
          if (fresh.validationHash !== plan.validationHash) throw new CartError('CART_REVIEW_CHANGED', 'Catálogo alterado; nova confirmação necessária.');
          if (cartId) {
            const observed = await this.read(p, check.state, gateway, cartId);
            if (observed.fingerprint !== head?.fingerprint) throw new CartError('CART_REMOTE_CHANGED', 'Carrinho mudou antes da escrita.');
          }
          await this.current(p, plan.linkId);
          let expected: Item[] = (head?.snapshot?.items ?? []).map(i => ({ ...i, options: i.options.map(o => ({ optionId:o.optionId, quantity:1 })) }));
          if (step.tool === 'createCart') expected = step.args['items'] as Item[];
          else if (step.tool === 'removeItemFromCart') expected = head!.snapshot!.items.filter(i => i.cartItemId !== step.args['cartItemId']) as Item[];
          else if (step.tool === 'updateCartItem') expected = head!.snapshot!.items.map(i => i.cartItemId === step.args['cartItemId'] ? step.args as unknown as Item : i) as Item[];
          else expected.push(step.args as unknown as Item);
          const previousTotals = head?.snapshot?.totals;
          this.store.beforeCall(p, intent.id, plan.purchaseHash); sent = true;
          const response = await gateway.writeConfirmed!(step.tool, { ...step.args, ...(cartId ? { cartId } : {}) });
          if (step.tool === 'createCart') cartId = parseCreatedCart(response).cartId;
          else assertMutationConfirmation(response);
          this.store.stepDone(p, check.state, intent.id, index + 1, cartId!); sent = false;
          // ID reconhecido é salvo antes da releitura: falha em GET nunca recria o carrinho.
          head = await this.read(p, check.state, gateway, cartId!);
          await this.current(p, plan.linkId);
          if (head.snapshot!.items.some(i => i.customerNote) || contentHash(composition(head.snapshot!.items)) !== contentHash(composition(expected)))
            throw new CartError('CART_COMPOSITION_CHANGED', 'Composição intermediária diverge; interrompida a sequência para nova revisão.');
          const expectedPrices = new Map<string,number | undefined>();
          for (const i of expected) expectedPrices.set(itemKey(i), check.state.bag!.lines.find(l =>
            itemKey({itemId:l.itemId,options:l.optionIds.map(optionId => ({optionId,quantity:1}))}) === itemKey(i))?.unitMinCents ??
            (i as Snapshot['items'][number]).unitPrice);
          if (head.snapshot!.items.some(i => i.unitPrice === undefined || i.unitPrice !== expectedPrices.get(itemKey(i))))
            throw new CartError('CART_PRICE_CHANGED', 'Preço unitário remoto divergente ou ausente; sequência interrompida para revisão.');
          if (confirmedTotals(head.snapshot!).status !== 'CONSISTENT' ||
            head.snapshot!.totals?.subtotal !== addCents(...head.snapshot!.items.map(i => multiplyCents(i.unitPrice!,i.quantity))))
            throw new CartError('CART_TOTALS_UNVERIFIED', 'Subtotal ou total remoto divergente; sequência interrompida para revisão.');
          const actualTotals = head.snapshot!.totals;
          if (previousTotals && (!actualTotals || ['deliveryFee','serviceFee','discount'].some(k => previousTotals[k as keyof typeof previousTotals] !== actualTotals[k as keyof typeof actualTotals])))
            throw new CartError('CART_COSTS_CHANGED', 'Taxas ou descontos mudaram; revise antes de outra escrita.');
          if (head.snapshot?.paymentMethod) throw new CartError('CART_PAYMENT_PRESENT', 'Carrinho contém pagamento externo; requer revisão sem processar pagamento.');
        }
        if (contentHash(composition(head!.snapshot!.items)) !== contentHash(composition(check.items)))
          throw new CartError('CART_COMPOSITION_CHANGED', 'A composição retornada diverge da confirmada.');
        this.store.finish(intent.id, 'SUCCEEDED');
      } catch (error) {
        this.store.finish(intent.id, sent ? 'RESULT_UNKNOWN' : 'FAILED',
          sent ? 'REMOTE_RESULT_UNKNOWN' : error instanceof CartError ? error.code : 'CART_READ_REQUIRED');
      }
      return { ...this.result(this.store.intent(p, intent.id)), cart: head?.snapshot ?? null,
        budget: head?.snapshot ? this.budget(check.state, head.snapshot) : null };
    });
  }
  private budget(state: PurchaseState, snapshot: Snapshot) {
    const totals = confirmedTotals(snapshot), bag = state.bag!;
    const desired: Item[] = [];
    for (const line of bag.lines) {
      const i = { itemId: line.itemId, quantity: line.quantity, options: line.optionIds.map(optionId => ({ optionId, quantity: 1 as const })) };
      const previous = desired.find(x => itemKey(x) === itemKey(i));
      if (previous) previous.quantity += i.quantity; else desired.push(i);
    }
    if (bag.status !== 'CURRENT' || state.clarifications.length || planCoverage(state,bag).some(c => c.status !== 'COVERED') ||
      snapshot.items.some(i => i.customerNote) || contentHash(composition(snapshot.items)) !== contentHash(composition(desired)) ||
      snapshot.items.some(i => i.unitPrice === undefined || i.unitPrice !== bag.lines.find(l => itemKey({itemId:l.itemId,options:l.optionIds.map(optionId => ({optionId,quantity:1}))}) === itemKey(i))?.unitMinCents) ||
      totals.status !== 'CONSISTENT' || !snapshot.totals || snapshot.totals.discount !== 0 ||
      snapshot.totals.subtotal !== addCents(...bag.lines.map(l => multiplyCents(l.unitMinCents,l.quantity))))
      return { status: 'UNVERIFIED', reason: 'Custos, preços ou elegibilidade de descontos divergentes; nova revisão necessária.' };
    const allocation = allocateCosts({ participants: state.participants.map(p => ({ participantId: p.participantId,
      ...(p.limit.state === 'DECLARED' && p.limit.value.kind === 'MANDATORY' ? { capCents: p.limit.value.amountCents } : {}) })),
    items: bag.lines.map(l => ({ itemId: l.lineId, unitPriceCents: l.unitMinCents, quantity: l.quantity, consumerIds: l.consumerIds })),
    deliveryFeeCents: snapshot.totals.deliveryFee, serviceFeeCents: snapshot.totals.serviceFee, discounts: [],
    ...(state.groupLimit.state === 'DECLARED' && state.groupLimit.value.kind === 'MANDATORY' ? { collectiveCapCents: state.groupLimit.value.amountCents } : {}) });
    return { status: allocation.budgetsSatisfied ? 'WITHIN_LIMITS' : 'LIMIT_EXCEEDED', allocation, purchaseAuthorized: false };
  }
  inspect(p: AdapterPrincipal) {
    return this.using(p, async (_ctx, gateway) => {
      const state = this.store.purchase(p, true), head = this.store.head(p, state);
      if (!head) throw new CartError('CART_NOT_FOUND', 'Nenhum cartId conhecido; criação desconhecida exige reconciliação externa.', 404);
      const observed = await this.read(p, state, gateway, head.cartId, false);
      let active = true;
      try { this.store.purchase(p); } catch { active = false; }
      return { cart: observed.snapshot, budget: active && state.bag ? this.budget(state, observed.snapshot!) : {status:'UNVERIFIED',reason:'Compra expirada; consulta técnica não renova confirmação.'},
        eligibility: 'NOT_REVALIDATED', requiresHumanReview: true,
        note: 'Consulta não libera escrita de resultado desconhecido nem autoriza pedido ou pagamento.', purchaseAuthorized: false };
    }, false);
  }
  operation(p: AdapterPrincipal, id: string) {
    return this.result(this.store.intent(p, id));
  }
}
