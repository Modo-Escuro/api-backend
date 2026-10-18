import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { validateSelection } from '../domain/configuration.js';
import { normalizeItemDetail } from '../domain/normalize.js';
import { LinkError, type IfoodLinkService, type OperationalContext, type Operation } from '../links/service.js';
import { McpToolError } from '../mcp/errors.js';
import type { GetItemResult, LatLng } from '../mcp/types.js';
import { CartError, confirmedTotals, deliveryList, id, parseItem, searchList, parseList, parseSnapshot, payload, paymentList, voucherList,
  type CartGateway, type CartTool, type ItemInput, type Snapshot } from './contracts.js';

const opaque = () => randomBytes(18).toString('base64url');
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const TTL = 5 * 60_000;
interface Product {
  ref: string; organizer: string; linkId: string; addressId: string; location: LatLng; detail: GetItemResult; expires: number;
}
interface Choice { ref: string; digest: string; revision: number; expires: number }
interface Cart {
  ref: string; organizer: string; linkId: string; merchantId: string; addressId: string; location: LatLng;
  cartId: string; snapshot: Snapshot | null; fingerprint: string | null; revision: number; unknown: boolean;
  review: { reviewId: string; revision: number; fingerprint: string; expiresAt: string } | null;
  choices: Map<string, { kind: 'delivery' | 'payment' | 'voucher'; choice: Choice }>;
}
interface Attempt { signature: string; status: 'UNKNOWN' | 'DONE'; cartRef?: string }
export type SelectionKind = 'delivery' | 'payment' | 'voucher';

/** Estado de demo de um único processo. Reinício perde referências, nunca reexecuta intents. */
export class CartService {
  private products = new Map<string, Product>();
  private carts = new Map<string, Cart>();
  private attempts = new Map<string, Attempt>();
  private unknownCreates = new Set<string>();
  private locks = new Map<string, Promise<void>>();
  constructor(private readonly links: IfoodLinkService, private readonly enabled = false, private readonly now = Date.now) {}

  private async locked<T>(organizer: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(organizer) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => { release = resolve; });
    this.locks.set(organizer, next);
    await previous;
    try { return await fn(); } finally { release(); if (this.locks.get(organizer) === next) this.locks.delete(organizer); }
  }

  private async current(organizer: string, linkId: string): Promise<void> {
    const status = await this.links.status(organizer);
    if (status.linkId !== linkId || status.state !== 'CONNECTED' || !status.operational) {
      for (const [key, p] of this.products) if (p.organizer === organizer) this.products.delete(key);
      for (const cart of this.carts.values()) if (cart.organizer === organizer) { cart.review = null; cart.choices.clear(); }
      throw new CartError('CART_LINK_CHANGED', 'A conta mudou ou deixou de estar operacional. Reconecte e monte novamente o carrinho.');
    }
  }

  private async run<T>(organizer: string, linkId: string, operation: Operation,
    fn: (ctx: OperationalContext, gateway: CartGateway) => Promise<T>): Promise<T> {
    if (!this.enabled) throw new CartError('CART_FEATURE_DISABLED', 'Montagem de carrinho indisponível nesta versão.', 503);
    try { return await this.locked(organizer, () => this.links.withOperational(organizer, operation, async (ctx) => {
      if (ctx.linkId !== linkId) throw new CartError('CART_LINK_CHANGED', 'linkId obsoleto.');
      await this.current(organizer, linkId);
      if (!ctx.cart) throw new CartError('CART_UNAVAILABLE', 'Sessão de carrinho indisponível para este vínculo.', 503);
      const result = await fn(ctx, ctx.cart);
      await this.current(organizer, linkId);
      return result;
    })); } catch (error) {
      for (const cart of this.carts.values()) if (cart.organizer === organizer) { cart.review = null; cart.choices.clear(); }
      if (error instanceof CartError || error instanceof LinkError) throw error;
      throw new CartError('CART_PROVIDER_UNAVAILABLE', 'Não foi possível consultar o MCP; tente novamente apenas a leitura.', 503,
        error instanceof McpToolError && /^[A-Z0-9_]{1,80}$/.test(error.code ?? '') ? error.code : undefined);
    }
  }

  private owned(organizer: string, linkId: string, cartRef: string): Cart {
    const cart = this.carts.get(cartRef);
    if (!cart || cart.organizer !== organizer || cart.linkId !== linkId) throw new CartError('CART_NOT_FOUND', 'Carrinho não encontrado.', 404);
    return cart;
  }
  private product(organizer: string, linkId: string, itemRef: string): Product {
    const p = this.products.get(itemRef);
    if (!p || p.organizer !== organizer || p.linkId !== linkId) throw new CartError('ITEM_NOT_FOUND', 'Referência de item não encontrada.', 404);
    if (p.expires <= this.now()) throw new CartError('ITEM_EXPIRED', 'Faça uma nova consulta do catálogo.', 410);
    return p;
  }
  private invalidate(cart: Cart) { cart.review = null; cart.choices.clear(); cart.revision++; }

  private async call(gateway: CartGateway, organizer: string, linkId: string, tool: CartTool, args: Record<string, unknown>) {
    await this.current(organizer, linkId);
    const result = await gateway.call(tool, args);
    await this.current(organizer, linkId);
    return result;
  }
  private async refresh(cart: Cart, gateway: CartGateway) {
    const raw = await this.call(gateway, cart.organizer, cart.linkId, 'getCart', { cartId: cart.cartId });
    const snapshot = parseSnapshot(raw);
    if (snapshot.cartId !== cart.cartId || snapshot.merchantId !== cart.merchantId || snapshot.addressId !== cart.addressId) {
      this.invalidate(cart);
      throw new CartError('CART_IDENTITY_MISMATCH', 'getCart retornou outro carrinho, loja ou endereço.', 502);
    }
    // Hash de toda a resposta detecta inclusive troca de cartão sem reter dados sensíveis.
    const fingerprint = digest(payload(raw));
    if (cart.fingerprint !== fingerprint) this.invalidate(cart);
    cart.snapshot = snapshot;
    cart.fingerprint = fingerprint;
    return this.view(cart);
  }
  private view(cart: Cart) {
    const snapshot = cart.snapshot;
    const money = snapshot ? confirmedTotals(snapshot) : { status: 'UNAVAILABLE' as const, values: null };
    return { cartRef: cart.ref, linkId: cart.linkId, revision: cart.revision,
      state: cart.unknown ? 'RESULT_UNKNOWN' : 'DRAFT', money: { currency: 'BRL', unit: 'CENTS' },
      items: snapshot?.items ?? [], totals: money, delivery: snapshot?.deliveryMethod ?? null,
      payment: snapshot?.paymentMethod ?? null, vouchers: snapshot?.vouchers ?? [],
      review: cart.review && Date.parse(cart.review.expiresAt) > this.now() ? cart.review : null,
      checkoutEnabled: false, purchaseAuthorized: false,
      blockers: ['CHECKOUT_DISABLED', 'SECURITY_ISSUES_2_3_PENDING', 'ELIGIBILITY_UNVERIFIED',
        ...(cart.unknown ? ['RESULT_UNKNOWN'] : []), ...(money.status !== 'CONSISTENT' ? [`TOTALS_${money.status}`] : [])] };
  }

  /** Única origem de itemRef: listagem real na sessão do organizador seguida de getItem. */
  catalog(organizer: string, input: { linkId: string; addressId: string; query: string }) {
    return this.run(organizer, input.linkId, 'OFFERS_EVALUATE', async (ctx) => {
      const addresses = await ctx.deps.listAddresses();
      const address = addresses.results.find((a) => a.addressId === input.addressId);
      if (!address?.coordinates || !id.safeParse(address.addressId).success) throw new CartError('INVALID_ADDRESS', 'Selecione um endereço válido retornado por listAddresses.', 400);
      const parsedLocation = z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) }).safeParse(address.coordinates);
      if (!parsedLocation.success) throw new CartError('INVALID_ADDRESS', 'Coordenadas do endereço não verificáveis.', 400);
      const location = parsedLocation.data;
      const page = parseList(searchList, await ctx.deps.searchOffers({ query: input.query, userLocation: location, resultKind: 'ITEM', pageSize: 10 }, { timeoutMs: 15_000 }));
      const items = [];
      for (const listing of (page.results ?? []).slice(0, 10)) {
        if (!id.safeParse(listing.itemId).success || !id.safeParse(listing.merchant.merchantId).success) continue;
        const detail = parseItem(await ctx.deps.getItem({ itemId: listing.itemId, merchantId: listing.merchant.merchantId, userLocation: location }, { timeoutMs: 15_000 }));
        if (detail.itemId !== listing.itemId || detail.merchantId !== listing.merchant.merchantId) throw new CartError('ITEM_IDENTITY_MISMATCH', 'Detalhamento não corresponde à listagem.', 502);
        const normalized = normalizeItemDetail(detail);
        const itemRef = opaque();
        this.products.set(itemRef, { ref: itemRef, organizer, linkId: input.linkId, addressId: address.addressId, location,
          detail, expires: this.now() + TTL });
        items.push({ itemRef, itemName: detail.itemName ?? null, merchantName: detail.merchantName ?? null,
          optionsStatus: normalized.optionGroups.state, optionGroups: detail.optionGroups?.map((g) => ({ optionGroupId: g.optionGroupId, name: g.name ?? null,
            minSelections: g.minSelections ?? null, maxSelections: g.maxSelections ?? null,
            options: g.options.map((o) => ({ optionId: o.optionId, name: o.name ?? null,
              additionalPriceCents: o.additionalPrice !== undefined ? Math.round(o.additionalPrice * 100) : null })) })) ?? null,
          eligibilityVerified: false, note: 'Referência de catálogo não comprova segurança alimentar nem aprovação de compra.' });
      }
      return { linkId: input.linkId, expiresAt: new Date(this.now() + TTL).toISOString(), items };
    });
  }
  private async validatedItem(ctx: OperationalContext, organizer: string, linkId: string, input: ItemInput,
    expected?: { merchantId: string; addressId: string; itemId?: string }) {
    const product = this.product(organizer, linkId, input.itemRef);
    if (expected && (product.detail.merchantId !== expected.merchantId || product.addressId !== expected.addressId ||
      (expected.itemId && product.detail.itemId !== expected.itemId))) throw new CartError('ITEM_CONTEXT_MISMATCH', 'Item de outra loja, endereço ou linha do carrinho.', 400);
    if (new Set(input.options.map((o) => o.optionId)).size !== input.options.length) throw new CartError('INVALID_CONFIGURATION', 'Opções duplicadas.', 400);
    const detail = parseItem(await ctx.deps.getItem({ itemId: product.detail.itemId, merchantId: product.detail.merchantId, userLocation: product.location }, { timeoutMs: 15_000 }));
    if (detail.itemId !== product.detail.itemId || detail.merchantId !== product.detail.merchantId) throw new CartError('ITEM_IDENTITY_MISMATCH', 'Item mudou durante a validação.', 502);
    const validation = validateSelection(normalizeItemDetail(detail), input.options);
    if (validation.status !== 'VALID') throw new CartError('INVALID_CONFIGURATION', 'Confira as opções obrigatórias, variantes e quantidades antes de adicionar.', 400);
    return { product, args: { itemId: detail.itemId, quantity: input.quantity, options: input.options,
      ...(input.customerNote !== undefined ? { customerNote: input.customerNote } : {}) } };
  }
  private attemptKey(organizer: string, linkId: string, requestId: string) { return `${organizer}:${linkId}:${requestId}`; }
  private existing(key: string, signature: string): Attempt | undefined {
    const previous = this.attempts.get(key);
    if (previous?.signature !== undefined && previous.signature !== signature) throw new CartError('IDEMPOTENCY_CONFLICT', 'requestId já usado com outro conteúdo.');
    if (previous?.status === 'UNKNOWN') throw new CartError('RESULT_UNKNOWN', 'Resultado anterior desconhecido. Não repita a operação; reconciliação necessária.');
    return previous;
  }
  createCart(organizer: string, input: { linkId: string; requestId: string; items: ItemInput[] }) {
    return this.run(organizer, input.linkId, 'CART_WRITE', async (ctx, gateway) => {
      const key = this.attemptKey(organizer, input.linkId, input.requestId), signature = digest(['create', input]);
      const previous = this.existing(key, signature);
      if (previous?.cartRef) return this.refresh(this.owned(organizer, input.linkId, previous.cartRef), gateway);
      const scope = `${organizer}:${input.linkId}`;
      if (this.unknownCreates.has(scope)) throw new CartError('RESULT_UNKNOWN', 'Criação anterior sem resultado conhecido; criação bloqueada até reconciliação.');
      const first = this.product(organizer, input.linkId, input.items[0]!.itemRef);
      const expected = { merchantId: first.detail.merchantId, addressId: first.addressId };
      const items = [];
      for (const item of input.items) items.push((await this.validatedItem(ctx, organizer, input.linkId, item, expected)).args);
      this.attempts.set(key, { signature, status: 'UNKNOWN' });
      this.unknownCreates.add(scope);
      let cart: Cart | undefined;
      try {
        const raw = await this.call(gateway, organizer, input.linkId, 'createCart', { ...expected, items });
        const parsed = z.object({ cartId: id }).safeParse(payload(raw));
        if (!parsed.success) throw new CartError('CART_CONTRACT_UNVERIFIED', 'createCart não retornou cartId reconhecido.', 502);
        cart = { ref: opaque(), organizer, linkId: input.linkId, ...expected, location: first.location, cartId: parsed.data.cartId,
          snapshot: null, fingerprint: null, revision: 0, unknown: false, review: null, choices: new Map() };
        this.carts.set(cart.ref, cart);
        this.attempts.set(key, { signature, status: 'DONE', cartRef: cart.ref });
        this.unknownCreates.delete(scope);
      } catch (error) { throw this.unknownError(error); }
      return this.refresh(cart, gateway);
    });
  }
  getCart(organizer: string, linkId: string, cartRef: string) {
    return this.run(organizer, linkId, 'CART_READ', (_ctx, gateway) => this.refresh(this.owned(organizer, linkId, cartRef), gateway));
  }
  private unknownError(error: unknown) {
    return new CartError('RESULT_UNKNOWN', 'Operação enviada sem confirmação segura. Não repetir; reconciliar com o iFood.', 409,
      error instanceof McpToolError && /^[A-Z0-9_]{1,80}$/.test(error.code ?? '') ? error.code : undefined);
  }
  private async mutate(cart: Cart, gateway: CartGateway, requestId: string, tool: CartTool, args: Record<string, unknown>) {
    const key = this.attemptKey(cart.organizer, cart.linkId, requestId), signature = digest([tool, cart.ref, args]);
    const previous = this.existing(key, signature);
    if (previous) return this.refresh(cart, gateway);
    if (cart.unknown) throw new CartError('RESULT_UNKNOWN', 'Carrinho aguarda reconciliação; mutações bloqueadas.');
    this.invalidate(cart);
    this.attempts.set(key, { signature, status: 'UNKNOWN', cartRef: cart.ref });
    try {
      await this.call(gateway, cart.organizer, cart.linkId, tool, { cartId: cart.cartId, ...args });
      this.attempts.set(key, { signature, status: 'DONE', cartRef: cart.ref });
    } catch (error) { cart.unknown = true; throw this.unknownError(error); }
    // Se a leitura falhar, um retry do mesmo requestId só lê; nunca repete a mutação.
    return this.refresh(cart, gateway);
  }
  addItemToCart(organizer: string, linkId: string, cartRef: string, requestId: string, input: ItemInput) {
    return this.changeItem(organizer, linkId, cartRef, requestId, input);
  }
  updateCartItem(organizer: string, linkId: string, cartRef: string, requestId: string, cartItemId: string, input: ItemInput) {
    return this.changeItem(organizer, linkId, cartRef, requestId, input, cartItemId);
  }
  changeItem(organizer: string, linkId: string, cartRef: string, requestId: string, input: ItemInput, cartItemId?: string) {
    return this.run(organizer, linkId, 'CART_WRITE', async (ctx, gateway) => {
      const cart = this.owned(organizer, linkId, cartRef);
      await this.refresh(cart, gateway);
      const existing = cartItemId ? cart.snapshot!.items.find((i) => i.cartItemId === cartItemId) : undefined;
      if (cartItemId && !existing) throw new CartError('CART_ITEM_NOT_FOUND', 'Item não encontrado neste carrinho.', 404);
      const validated = await this.validatedItem(ctx, organizer, linkId, input, { ...cart, itemId: existing?.itemId });
      return this.mutate(cart, gateway, requestId, cartItemId ? 'updateCartItem' : 'addItemToCart',
        { ...validated.args, ...(cartItemId ? { cartItemId } : {}) });
    });
  }
  removeItemFromCart(organizer: string, linkId: string, cartRef: string, requestId: string, cartItemId: string) {
    return this.run(organizer, linkId, 'CART_WRITE', async (_ctx, gateway) => {
      const cart = this.owned(organizer, linkId, cartRef);
      // Consulta a intenção antes de checar a linha: retry após remoção bem-sucedida é só leitura.
      const key = this.attemptKey(organizer, linkId, requestId);
      if (this.existing(key, digest(['removeItemFromCart', cart.ref, { cartItemId }]))) return this.refresh(cart, gateway);
      await this.refresh(cart, gateway);
      if (!cart.snapshot!.items.some((i) => i.cartItemId === cartItemId)) throw new CartError('CART_ITEM_NOT_FOUND', 'Item não encontrado neste carrinho.', 404);
      return this.mutate(cart, gateway, requestId, 'removeItemFromCart', { cartItemId });
    });
  }
  private async listed(cart: Cart, gateway: CartGateway, kind: SelectionKind) {
    if (kind === 'delivery') {
      const raw = await this.call(gateway, cart.organizer, cart.linkId, 'getCartDeliveryMethods', { cartId: cart.cartId });
      return parseList(deliveryList, raw).deliveryMethods.flatMap((d) => [
        { deliveryMethodId: d.deliveryMethodId }, ...(d.timeSlots ?? []).map((s) => ({ deliveryMethodId: d.deliveryMethodId, selectedTimeSlotId: s.timeSlotId }))]);
    }
    if (kind === 'payment') {
      const raw = await this.call(gateway, cart.organizer, cart.linkId, 'listPaymentMethods', { merchantId: cart.merchantId });
      return parseList(paymentList, raw).paymentMethods.map((p) => {
        const card = p.type === 'CREDIT_CARD' || p.type === 'DEBIT_CARD';
        const nonCard = p.type === 'PIX' || p.type === 'CASH';
        if ((card && !p.cardTokenId) || (nonCard && p.cardTokenId) || (!card && !nonCard && !p.cardTokenId))
          throw new CartError('CART_CONTRACT_UNVERIFIED', 'Método de pagamento sem configuração verificável.', 502);
        return { paymentMethodId: p.paymentMethodId, ...(p.cardTokenId ? { cardTokenId: p.cardTokenId } : {}) };
      });
    }
    const raw = await this.call(gateway, cart.organizer, cart.linkId, 'listVouchers', { cartId: cart.cartId });
    return parseList(voucherList, raw).vouchers;
  }
  listChoices(organizer: string, linkId: string, cartRef: string, kind: SelectionKind) {
    return this.run(organizer, linkId, kind === 'payment' ? 'CART_PAYMENT' : 'CART_READ', async (_ctx, gateway) => {
      const cart = this.owned(organizer, linkId, cartRef);
      await this.refresh(cart, gateway);
      const values = await this.listed(cart, gateway, kind);
      for (const [key, value] of cart.choices) if (value.kind === kind) cart.choices.delete(key);
      return { cartRef, revision: cart.revision, choices: values.map((value, index) => {
        const choiceRef = opaque();
        cart.choices.set(choiceRef, { kind, choice: { ref: choiceRef, digest: digest(value), revision: cart.revision, expires: this.now() + TTL } });
        // Tokens de cartão só existem no resultado local da chamada, não no estado nem no contrato externo.
        const safe = kind === 'payment' ? { label: `${'cardTokenId' in value ? 'Cartão salvo' : 'Pagamento'} ${index + 1}` } : value;
        return { choiceRef, ...safe, ...('cardTokenId' in safe ? { cardTokenId: undefined } : {}) };
      }) };
    });
  }
  selectChoice(organizer: string, linkId: string, cartRef: string, requestId: string, kind: SelectionKind, choiceRef: string) {
    return this.run(organizer, linkId, kind === 'payment' ? 'CART_PAYMENT' : 'CART_WRITE', async (_ctx, gateway) => {
      const cart = this.owned(organizer, linkId, cartRef);
      // Idempotência por referência externa, inclusive depois de invalidar as escolhas.
      const selectionKey = this.attemptKey(organizer, linkId, `selection:${requestId}`);
      const signature = digest([kind, cartRef, choiceRef]);
      if (this.existing(selectionKey, signature)) return this.refresh(cart, gateway);
      await this.refresh(cart, gateway);
      const selected = cart.choices.get(choiceRef);
      if (!selected || selected.kind !== kind || selected.choice.revision !== cart.revision || selected.choice.expires <= this.now())
        throw new CartError('CHOICE_EXPIRED', 'Consulte novamente as opções do carrinho.', 410);
      const values = await this.listed(cart, gateway, kind);
      const args = values.find((v) => digest(v) === selected.choice.digest);
      if (!args) throw new CartError('CHOICE_CHANGED', 'Opção não está mais disponível; consulte novamente.');
      this.attempts.set(selectionKey, { signature, status: 'UNKNOWN', cartRef });
      const tool = kind === 'delivery' ? 'setCartDelivery' : kind === 'payment' ? 'setCartPayment' : 'setVoucher';
      const result = await this.mutate(cart, gateway, requestId, tool, args);
      this.attempts.set(selectionKey, { signature, status: 'DONE', cartRef });
      return result;
    });
  }
  removeVoucher(organizer: string, linkId: string, cartRef: string, requestId: string) {
    return this.run(organizer, linkId, 'CART_WRITE', async (_ctx, gateway) => {
      const cart = this.owned(organizer, linkId, cartRef);
      await this.refresh(cart, gateway);
      return this.mutate(cart, gateway, requestId, 'removeVoucher', {});
    });
  }
  review(organizer: string, linkId: string, cartRef: string) {
    return this.run(organizer, linkId, 'CART_READ', async (_ctx, gateway) => {
      const cart = this.owned(organizer, linkId, cartRef);
      await this.refresh(cart, gateway);
      if (cart.unknown || confirmedTotals(cart.snapshot!).status !== 'CONSISTENT') throw new CartError('CART_NOT_REVIEWABLE', 'Reconcilie o carrinho e os totais antes da revisão.');
      if (!cart.snapshot!.items.length || !cart.snapshot!.deliveryMethod || !cart.snapshot!.paymentMethod)
        throw new CartError('CART_INCOMPLETE', 'Itens, entrega e pagamento devem constar no getCart.');
      cart.review = { reviewId: opaque(), revision: cart.revision, fingerprint: cart.fingerprint!, expiresAt: new Date(this.now() + TTL).toISOString() };
      return { ...this.view(cart), approvalEnabled: false, note: 'Revisão informativa. Login e revisão não aprovam compra.' };
    });
  }
}
