// MCP, OAuth e pessoas inteiramente SINTÉTICOS; não executa rede, modelo, Telegram ou escrita real.
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/server/app';
import { loadConfig } from '../../src/server/config';
import { contentHash, type AdapterPrincipal } from '../../src/server/contracts/guards';
import { applyPatch, restrictionsSig, type PurchaseState } from '../../src/server/domain/purchase';
import { composeProposals } from '../../src/server/domain/group';
import { ConfirmedCartService } from '../../src/server/cart/write-service';
import { CartWriteStore } from '../../src/server/cart/write-store';
import { ObservedCartContract, type CartContractGate } from '../../src/server/cart/write-contract';
import type { CartGateway, CartTool } from '../../src/server/cart/contracts';
import type { IfoodLinkService, OperationalContext } from '../../src/server/links/service';
import { TurnStore, scopeKey } from '../../src/server/turns/store';
import { TurnRuntime } from '../../src/server/turns/runtime';
import { candidate } from '../group/catalog';
import { event as turnEvent, result as turnResult } from '../turns/helpers';
import { ORG_A, connectAndConfirm, setup as setupLinks } from '../helpers/fakes';
import { McpToolError } from '../../src/server/mcp/errors';
import { addressSchema, linkFingerprint } from '../../src/server/services/address-reference';
import { cartIntentSummary } from '../../src/server/cart/write-schema';
import { metrics } from '../../src/server/ops/metrics';

const M = '11111111-1111-4111-8111-111111111111', I = '22222222-2222-4222-8222-222222222222';
const A = '33333333-3333-4333-8333-333333333333', L = 'link-sintetico-0001';
const principal: AdapterPrincipal = { botId: '900001', organizerId: '111111111', conversationId: '111111111' };
const token = 'synthetic-service-token-0123456789abcdef';
const syntheticAddress = { addressId: A, alias: 'Casa', location: { neighborhood: 'Centro', city: 'Cidade sintética' }, coordinates: { latitude: -1, longitude: -2 } };
const stores: TurnStore[] = [];
afterEach(() => { for (const s of stores.splice(0)) s.close(); });

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'cart01-test-')), path = join(dir, 'turns.db');
  let time = 1_800_000_000_000;
  const now = () => time;
  const turns = new TurnStore(path, {}, now); stores.push(turns);
  // Referência de endereço explicitamente autorizada: origem humana simulada, sem MCP real.
  turns.db.exec('CREATE TABLE delivery_address_selected(scope TEXT PRIMARY KEY,link_hash TEXT,address_id TEXT,address_hash TEXT,expires INTEGER,choice_hash TEXT)');
  turns.db.prepare('INSERT INTO delivery_address_selected VALUES(?,?,?,?,?,?)').run(scopeKey(principal), linkFingerprint(L), A,
    contentHash(addressSchema.parse(syntheticAddress)), now() + 86_400_000, contentHash('synthetic-human-address-reference'));
  let s = applyPatch(null, [{ op: 'ADD_PARTICIPANT', displayName: 'Pessoa sintética' }], { seed: 'synthetic', eventId: 'e1' }).state;
  s = applyPatch(s, [{ op: 'SET_RESTRICTIONS', participantId: s.participants[0]!.participantId, value: 'NONE' },
    { op: 'SET_LIMIT', target: s.participants[0]!.participantId, value: 'NONE' }, { op: 'SET_LIMIT', target: 'GROUP', value: 'NONE' },
    { op: 'SET_PRIORITY', value: 'ECONOMY' }, { op: 'SET_ADDRESS', addressId: A }, { op: 'SET_MERCHANT', merchantId: M }],
  { seed: 'synthetic', eventId: 'e2' }).state;
  const proposals = composeProposals(s, [candidate({ itemId: I, merchantId: M, name: 'Arroz', price: 20, fee: 5 })], { seed: 'synthetic', addressId: A }).proposals;
  s = applyPatch(s, [{ op: 'SET_PROPOSALS', proposals: proposals.map(p => p.proposal) },
    { op: 'SELECT_PROPOSAL', proposalId: proposals[0]!.proposal.proposalId }], { seed: 'synthetic', eventId: 'e3' }).state;
  s.linkId = L;
  const save = (state: PurchaseState) => {
    s = state;
    const snapshot = { contractVersion: '1.0', conversationId: principal.conversationId, version: s.version, phase: 'COLLECTING',
      humanApproval: null, allowedActions: [], pending: [], blocks: [] };
    turns.db.prepare(`INSERT INTO conversations(scope,snapshot,domain,last_activity_at) VALUES(?,?,?,?)
      ON CONFLICT(scope) DO UPDATE SET snapshot=excluded.snapshot,domain=excluded.domain,last_activity_at=excluded.last_activity_at`)
      .run(scopeKey(principal), JSON.stringify(snapshot), JSON.stringify(s), now());
  };
  save(s);
  let linked = L, price = 20;
  const rawListing = () => ({ itemId: I, itemName: 'Arroz', unitPrice: price,
    merchant: { merchantId: M, merchantName: 'Loja sintética', isOpen: true, minimumOrderAmount: 0, deliveryMethod: { fee: 5, deliveryMethodId: 'DELIVERY', deliveryMethodMode: 'DELIVERY' } } });
  const rawDetail = () => ({ itemId: I, merchantId: M, itemName: 'Arroz', itemDescription: 'Arroz e água', unitPrice: price,
    merchantName: 'Loja sintética', merchantMinimumOrderAmount: 0, optionGroups: [] });
  type Remote = { cartId: string; merchantId: string; addressId: string;
    items: { cartItemId: string; itemId: string; quantity: number; options: { optionId: string; quantity: number }[]; unitPrice?: number }[];
    totals: { subtotal: number; deliveryFee: number; serviceFee: number; discount: number; total: number } };
  let remote: Remote | null = null;
  const read = vi.fn(async (tool: CartTool) => {
    if (tool !== 'getCart' || !remote) throw new Error('leitura sintética inválida');
    return structuredClone(remote);
  });
  const write = vi.fn(async (tool: string, args: Record<string, unknown>): Promise<unknown> => {
    if (tool === 'createCart') remote = { cartId: randomUUID(), merchantId: String(args.merchantId), addressId: String(args.addressId),
      items: (args.items as Remote['items']).map(i => ({ ...i, cartItemId: randomUUID(), unitPrice:20 })),
      totals: { subtotal: 20, deliveryFee: 5, serviceFee: 1, discount: 0, total: 26 } };
    else if (tool === 'updateCartItem') remote!.items.find(i => i.cartItemId === args.cartItemId)!.quantity = Number(args.quantity);
    else if (tool === 'removeItemFromCart') remote!.items = remote!.items.filter(i => i.cartItemId !== args.cartItemId);
    else if (tool === 'addItemToCart') remote!.items.push({ ...(args as unknown as Remote['items'][number]), cartItemId: randomUUID(), unitPrice:20 });
    else throw new Error('escrita sintética inválida');
    if (tool !== 'createCart') {
      remote!.totals.subtotal = remote!.items.reduce((n,i) => n + i.quantity * 20, 0);
      remote!.totals.total = remote!.totals.subtotal + 6;
    }
    return tool === 'createCart' ? { cartId: remote!.cartId } : { success: true };
  });
  const gateway: CartGateway = { call: read, writeConfirmed: write };
  const ctx = { linkId: L, cart: gateway, deps: { listAddresses: vi.fn(async () => ({ results: [structuredClone(syntheticAddress)] })),
    searchOffers: vi.fn(async () => ({ results: [rawListing()] })), getItem: vi.fn(async (args: { itemId: string }) =>
      ({ ...rawDetail(), itemId: args.itemId, itemName: args.itemId === I ? 'Arroz' : 'Outro item sintético' })) } } as unknown as OperationalContext;
  const links = { status: vi.fn(async () => ({ state: 'CONNECTED', operational: true, linkId: linked, attempt: null,
    scopeEvidence: 'TOKEN_SCOPES', allowedOperations: ['CART_READ','CART_WRITE','OFFERS_EVALUATE','ADDRESSES_READ'],
    account: { identity: { status: 'VERIFIED', displayName: 'Pessoa S.', emailMasked: 'p***@example.test', source: 'getUser' } } })),
    storageHealth: vi.fn(async () => ({ state: 'OK' })), sessionSummary: vi.fn(async () => ({ operational: 1 })),
    withOperational: vi.fn(async (_org: string, _op: string, fn: (c: OperationalContext) => Promise<unknown>) => fn(ctx)) } as unknown as Pick<IfoodLinkService,'status' | 'withOperational'>;
  const gate: CartContractGate = { verify: vi.fn(async () => undefined) }; // injeção exclusiva do teste, não evidência observada
  const service = new ConfirmedCartService(new CartWriteStore(turns), links, gate);
  const command = (reference: string) => ({ confirmationRef: reference, requestId: randomUUID(), callbackId: randomUUID() });
  const cfg = loadConfig({ BOT_API_TOKEN: token, ALLOWED_ORGANIZER_IDS: principal.organizerId,
    CONVERSATION_RUNTIME_ENABLED: 'true', CONVERSATION_DB_FILE: path, BOT_TELEGRAM_ID: principal.botId });
  const app = createApp(undefined, { config: cfg, links: links as IfoodLinkService, cartWrites: service });
  const call = (path: string, body: unknown, extra: Record<string,string> = {}) => app.request(`/api/bot/v1/conversations/${principal.conversationId}/cart-writes/${path}`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json',
      'x-telegram-user-id': principal.organizerId, 'x-telegram-chat-id': principal.conversationId, ...extra }, body: JSON.stringify(body) });
  return { turns, dir, path, now, service, ctx, write, read, gateway, gate, links, command, app, call, cfg,
    state: () => structuredClone(s), save, remote: () => remote!, setPrice: (n: number) => { price = n; }, setLink: (v: string) => { linked = v; },
    advance: (ms: number) => { time += ms; } };
}

describe('CART-01: confirmação humana, persistência e reconciliação (MCP mockado)', () => {
  it('OPS-02 conta intenções persistidas e tentativas sem repetir métricas no replay', async () => {
    const f = setup(), review = await f.service.prepare(principal), cmd = f.command(review.confirmationRef);
    const before = metrics.counter('cart_write_attempts_total', { tool: 'createCart', outcome: 'RESULT_UNKNOWN' });
    f.write.mockResolvedValueOnce({ queued: true });
    expect((await f.service.confirm(principal, cmd)).state).toBe('RESULT_UNKNOWN');
    await f.service.confirm(principal, cmd);
    expect(metrics.counter('cart_write_attempts_total', { tool: 'createCart', outcome: 'RESULT_UNKNOWN' })).toBe(before + 1);
    expect(cartIntentSummary(f.turns.db)).toEqual({ PENDING: 0, SUCCEEDED: 0, FAILED: 0, RESULT_UNKNOWN: 1 });
    const app = createApp(undefined, { config: f.cfg, links: f.links as IfoodLinkService, conversations: new TurnRuntime(f.turns) });
    const response = await app.request('/api/ops/status', { headers: { authorization: `Bearer ${token}`, 'x-telegram-user-id': principal.organizerId } });
    expect(await response.json()).toMatchObject({ purchase: { cartPreparation: 'DISABLED', cartIntents: { RESULT_UNKNOWN: 1 } } });
  });
  it('revisão identifica conta mascarada, loja e endereço sem copiar rótulos ao plano técnico', async () => {
    const f = setup(), review = await f.service.prepare(principal);
    expect(review.display).toMatchObject({ accountLabel: 'Pessoa S. · p***@example.test', merchantName: 'Loja sintética', addressLabel: 'Casa · Centro · Cidade sintética' });
    const plans = JSON.stringify(f.turns.db.prepare('SELECT plan FROM cart_write_reviews').all());
    expect(plans).not.toMatch(/Pessoa S\.|example\.test|Casa|Cidade sintética|Loja sintética/);
    expect(f.write).not.toHaveBeenCalled();
  });
  it('identidade indisponível bloqueia revisão e não gera referência humana', async () => {
    const f = setup(), status = await f.links.status(principal.organizerId);
    vi.mocked(f.links.status).mockResolvedValue({ ...status, account: null });
    await expect(f.service.prepare(principal)).rejects.toMatchObject({ code: 'CART_REVIEW_NOT_DISPLAYABLE' });
    expect(f.turns.db.prepare('SELECT count(*) n FROM cart_write_reviews').get()!['n']).toBe(0);
    expect(f.write).not.toHaveBeenCalled();
  });
  it('troca de identificação da conta após revisão invalida a confirmação mesmo com mesmo total', async () => {
    const f = setup(), review = await f.service.prepare(principal), status = await f.links.status(principal.organizerId);
    vi.mocked(f.links.status).mockResolvedValue({ ...status, account: { ...status.account!, identity: { status: 'VERIFIED', displayName: 'Outra P.', emailMasked: null, source: 'getUser' } } });
    await expect(f.service.confirm(principal, f.command(review.confirmationRef))).rejects.toMatchObject({ code: 'CART_REVIEW_CHANGED' });
    expect(f.write).not.toHaveBeenCalled();
  });
  it('detalhamento de outro ID não é apresentado nem enviado como o produto escolhido', async () => {
    const f = setup(), original = vi.mocked(f.ctx.deps.getItem).getMockImplementation()!;
    vi.mocked(f.ctx.deps.getItem).mockImplementation(async (...args) => ({ ...(await original(...args) as object), itemId: randomUUID() }));
    await expect(f.service.prepare(principal)).rejects.toMatchObject({ code: 'CART_IDENTITY_MISMATCH' });
    expect(f.write).not.toHaveBeenCalled();
  });
  it('opções têm rótulos observados; opção sem nome impede confirmação', async () => {
    const f = setup(), optionId = randomUUID(), groupId = randomUUID(), state = f.state();
    state.bag!.lines[0]!.optionIds = [optionId]; f.save(state);
    const original = vi.mocked(f.ctx.deps.getItem).getMockImplementation()!;
    let name: string | undefined = 'Sem molho';
    vi.mocked(f.ctx.deps.getItem).mockImplementation(async (...args) => ({ ...(await original(...args) as object),
      optionGroups: [{ optionGroupId: groupId, minSelections: 0, maxSelections: 1, options: [{ optionId, name, additionalPrice: 0 }] }] }));
    expect((await f.service.prepare(principal)).display.items[0]!.options).toEqual([{ optionId, name, quantity: 1 }]);
    name = undefined;
    await expect(f.service.prepare(principal)).rejects.toMatchObject({ code: 'CART_REVIEW_NOT_DISPLAYABLE' });
    expect(f.write).not.toHaveBeenCalled();
  });
  it('regressão da auditoria: revisar e atualizar carrinho com opção mantém um único rótulo por configuração', async () => {
    const f = setup(), optionId = randomUUID(), optionGroupId = randomUUID(), state = f.state();
    state.bag!.lines[0]!.optionIds = [optionId]; f.save(state);
    const original = vi.mocked(f.ctx.deps.getItem).getMockImplementation()!;
    vi.mocked(f.ctx.deps.getItem).mockImplementation(async (...args) => ({ ...(await original(...args) as object),
      optionGroups: [{ optionGroupId, minSelections: 0, maxSelections: 1, options: [{ optionId, name: 'Sem molho', additionalPrice: 0 }] }] }));
    const first = await f.service.prepare(principal);
    expect((await f.service.confirm(principal, f.command(first.confirmationRef))).state).toBe('SUCCEEDED');
    const changed = f.state(); changed.bag!.lines[0]!.quantity = 2; changed.version++; f.save(changed);
    const review = await f.service.prepare(principal);
    expect(review.display.items).toEqual([{ itemId: I, name: 'Arroz', options: [{ optionId, quantity: 1, name: 'Sem molho' }] }]);
    expect((await f.service.confirm(principal, f.command(review.confirmationRef))).state).toBe('SUCCEEDED');
    expect(f.write.mock.calls.map(([tool]) => tool)).toEqual(['createCart', 'updateCartItem']);
  });
  it('remoção de item remoto exige nome e detecta mudança do nome antes da escrita', async () => {
    const f = setup(), first = await f.service.prepare(principal);
    await f.service.confirm(principal, f.command(first.confirmationRef));
    const otherId = randomUUID(); f.remote().items.push({ cartItemId: randomUUID(), itemId: otherId, quantity: 1, options: [], unitPrice: 20 });
    f.remote().totals.subtotal = 40; f.remote().totals.total = 46;
    const review = await f.service.prepare(principal);
    expect(review.display.items.find(i => i.itemId === otherId)?.name).toBe('Outro item sintético');
    const original = vi.mocked(f.ctx.deps.getItem).getMockImplementation()!;
    vi.mocked(f.ctx.deps.getItem).mockImplementation(async (...args) => ({ ...(await original(...args) as object), ...(args[0].itemId === otherId ? { itemName: 'Nome alterado' } : {}) }));
    await expect(f.service.confirm(principal, f.command(review.confirmationRef))).rejects.toMatchObject({ code: 'CART_REVIEW_CHANGED' });
    expect(f.write).toHaveBeenCalledTimes(1);
  });
  it('consulta final exibe composição e custos sem reexecutar a intenção', async () => {
    const f = setup(), review = await f.service.prepare(principal), cmd = f.command(review.confirmationRef);
    expect((await f.service.confirm(principal, cmd)).state).toBe('SUCCEEDED');
    const current = await f.service.inspect(principal);
    expect(current).toMatchObject({ display: { merchantName: 'Loja sintética' },
      cart: { totals: { subtotal: 2000, deliveryFee: 500, serviceFee: 100, total: 2600 } },
      budget: { status: 'WITHIN_LIMITS' }, purchaseAuthorized: false, checkoutEnabled: false, paymentEnabled: false });
    expect(f.service.request(principal, cmd.requestId).state).toBe('SUCCEEDED');
    expect(f.write).toHaveBeenCalledTimes(1);
  });
  it('ID de endereço duplicado na lista remota é ambíguo e nunca permite preparar', async () => {
    const f = setup();
    vi.mocked(f.ctx.deps.listAddresses).mockResolvedValueOnce({ results: [
      { addressId: A, coordinates: { latitude: -1, longitude: -2 } },
      { addressId: A, coordinates: { latitude: -3, longitude: -4 } },
    ] });
    await expect(f.service.prepare(principal)).rejects.toThrow();
    expect(f.write).not.toHaveBeenCalled();
  });
  it.each(['expires', 'replaced'])('seleção %s durante o último getItem bloqueia o despacho imediatamente anterior à escrita', async mode => {
    const f = setup(), review = await f.service.prepare(principal);
    f.turns.db.prepare('UPDATE delivery_address_selected SET expires=?').run(f.now() + 1000);
    const original = vi.mocked(f.ctx.deps.getItem).getMockImplementation()!;
    let calls = 0;
    vi.spyOn(f.ctx.deps, 'getItem').mockImplementation(async (...args) => {
      const result = await original(...args);
      if (++calls === 2) {
        if (mode === 'expires') f.advance(1001);
        else f.turns.db.prepare('UPDATE delivery_address_selected SET address_hash=?').run('0'.repeat(64));
      }
      return result;
    });
    const result = await f.service.confirm(principal, f.command(review.confirmationRef));
    expect(result).toMatchObject({ state: 'FAILED', code: 'CART_ADDRESS_CONFIRMATION_REQUIRED' });
    expect(f.write).not.toHaveBeenCalled();
  });
  it.each(['missing', 'expired', 'other-link', 'other-address', 'changed-address'])('endereço %s bloqueia preparação antes de qualquer escrita', async mode => {
    const f = setup();
    if (mode === 'missing') f.turns.db.prepare('DELETE FROM delivery_address_selected').run();
    if (mode === 'expired') f.turns.db.prepare('UPDATE delivery_address_selected SET expires=?').run(f.now() - 1);
    if (mode === 'other-link') f.turns.db.prepare('UPDATE delivery_address_selected SET link_hash=?').run(linkFingerprint('outro-vinculo'));
    if (mode === 'other-address') f.turns.db.prepare('UPDATE delivery_address_selected SET address_id=?').run(randomUUID());
    if (mode === 'changed-address') vi.mocked(f.ctx.deps.listAddresses).mockResolvedValueOnce({ results: [{ addressId: A, coordinates: { latitude: -3, longitude: -4 } }] });
    await expect(f.service.prepare(principal)).rejects.toMatchObject({ code: 'CART_ADDRESS_CONFIRMATION_REQUIRED' });
    expect(f.write).not.toHaveBeenCalled();
  });
  it('mesmo ID e preço com nome atual diferente bloqueiam revisão antiga e escrita', async () => {
    const f = setup();
    const original = vi.mocked(f.ctx.deps.getItem).getMockImplementation()!;
    vi.spyOn(f.ctx.deps, 'getItem').mockImplementation(async (...args) => ({ ...(await original(...args) as Record<string,unknown>), itemName: 'Outro produto' }));
    await expect(f.service.prepare(principal)).rejects.toMatchObject({ code: 'CART_ITEM_CHANGED' });
    expect(f.write).not.toHaveBeenCalled();
    expect(f.turns.db.prepare('SELECT count(*) AS n FROM cart_write_reviews').get()!['n']).toBe(0);
  });
  it('mesma identificação normalizada da proposta aceita espaços e controles removidos pela GRP-01', async () => {
    const f = setup();
    const original = vi.mocked(f.ctx.deps.getItem).getMockImplementation()!;
    vi.spyOn(f.ctx.deps, 'getItem').mockImplementation(async (...args) => ({ ...(await original(...args) as Record<string,unknown>), itemName: '  Arroz\u200b  ' }));
    expect((await f.service.prepare(principal)).purpose).toBe('PREPARE_CART');
    expect(f.write).not.toHaveBeenCalled();
  });
  it('recupera resposta de confirmação perdida por requestId escopado, só com GET e sem reenviar escrita', async () => {
    const f = setup(), review = await f.service.prepare(principal), command = f.command(review.confirmationRef);
    const result = await f.service.confirm(principal, command);
    const base = `/api/bot/v1/conversations/${principal.conversationId}/cart-writes/requests/`;
    const headers = { authorization: `Bearer ${token}`, 'x-telegram-user-id': principal.organizerId, 'x-telegram-chat-id': principal.conversationId };
    const response = await f.app.request(base + command.requestId, { headers });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ operationId: result.operationId, state: 'SUCCEEDED', purpose: 'PREPARE_CART' });
    expect((await f.app.request(base + 'invalido', { headers })).status).toBe(400);
    expect((await f.app.request(base + randomUUID(), { headers })).status).toBe(404);
    expect(() => f.service.request({ ...principal, organizerId: '222222222', conversationId: '222222222' }, command.requestId)).toThrow();
    expect(f.write).toHaveBeenCalledTimes(1);
  });
  it.each([false, true])('runtime recupera intenção interrompida sent=%s mesmo sem montar serviço CART-01', async sent => {
    const f = setup(), review = await f.service.prepare(principal), store = new CartWriteStore(f.turns);
    const command = f.command(review.confirmationRef), plan = store.readReview(principal, command.confirmationRef);
    const intent = store.reserve(principal, command, plan);
    if (sent) store.beforeCall(principal, intent.id, plan.purchaseHash);
    f.turns.close(); f.advance(120_001);
    const restarted = new TurnStore(f.path, {}, f.now); stores.push(restarted);
    restarted.recover();
    expect(restarted.db.prepare('SELECT state FROM cart_write_intents WHERE id=?').get(intent.id)!['state']).toBe(sent ? 'RESULT_UNKNOWN' : 'FAILED');
    restarted.accept(principal, turnEvent(981, f.state().version));
    const job = restarted.claim('synthetic-after-restart')!;
    expect(restarted.finish(job, turnResult(job))).toBe(!sent);
    expect(f.write).not.toHaveBeenCalled();
  });
  it('erro MCP com dados privados não atravessa a nova rota nem vira autorização', async () => {
    const f = setup();
    vi.spyOn(f.ctx.deps, 'getItem').mockRejectedValueOnce(new McpToolError('getItem', [{ code: 'INTERNAL',
      message: 'email-sintetico@example.com token-sintetico-privado' }]));
    const response = await f.call('reviews', {});
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({ error: { kind: 'CART_PROVIDER_UNAVAILABLE', retryable: false }, purchaseAuthorized: false });
    expect(text).not.toContain('email-sintetico'); expect(text).not.toContain('token-sintetico');
    expect(f.write).not.toHaveBeenCalled();
  });
  it.each([true, false])('vínculo real com montagem Gemini respeita escopos e flag CART-01=%s sem F7 nem pagamento', async enabled => {
    const config = loadConfig({ CONVERSATION_RUNTIME_ENABLED: 'true', CONVERSATION_DB_FILE: '.conversations/synthetic.sqlite',
      BOT_TELEGRAM_ID: principal.botId, BOT_API_TOKEN: token, ALLOWED_ORGANIZER_IDS: ORG_A,
      CONVERSATION_MODEL_ENABLED: 'true', CONVERSATION_MODEL_PROVIDER: 'google', CONVERSATION_MODEL: 'gemini-3.8-flash',
      GEMINI_API_KEY: 'synthetic-key', CONVERSATION_MODEL_MAX_REQUESTS: '1',
      IFOOD_CONFIRMED_CART_WRITES_ENABLED: String(enabled), IFOOD_CART_CONTRACT_EVIDENCE_FILE: 'synthetic-proof.json' });
    const env = setupLinks({ cartEnabled: config.cartEnabled, confirmedCartWrites: config.confirmedCartWrites,
      conversationRuntime: config.conversationRuntime, conversationModel: config.conversationModel });
    env.as.scope += ' mcp.cart.read mcp.cart.write mcp.cart.payment';
    await connectAndConfirm(env, ORG_A);
    expect(env.cfg.cartEnabled).toBe(false);
    expect(env.cfg.conversationModel?.provider).toBe('google');
    const status = await env.links.status(ORG_A);
    expect(status.scopeEvidence).toBe('TOKEN_SCOPES');
    if (enabled) expect(status.allowedOperations).toEqual(expect.arrayContaining(['CART_READ', 'CART_WRITE']));
    else expect(status.allowedOperations).not.toEqual(expect.arrayContaining(['CART_WRITE']));
    expect(status.allowedOperations).not.toContain('CART_PAYMENT');
  });
  it('migração v2 preserva compra e replay e instala schema atual antes de aceitar confirmações', async () => {
    const f = setup();
    const accepted = f.turns.accept(principal, turnEvent(88, f.state().version));
    const before = f.state();
    f.turns.close();
    const old = new DatabaseSync(f.path);
    old.exec('DROP TABLE cart_write_reviews; DROP TABLE cart_write_intents; DROP TABLE cart_write_heads; PRAGMA user_version=2;');
    old.close();
    const migrated = new TurnStore(f.path, {}, f.now); stores.push(migrated);
    expect(migrated.db.prepare('PRAGMA user_version').get()!['user_version']).toBe(5);
    expect(new CartWriteStore(migrated).purchase(principal)).toEqual(before);
    expect(migrated.accept(principal, turnEvent(88, before.version)).operation.operationId).toBe(accepted.operation.operationId);
    const service = new ConfirmedCartService(new CartWriteStore(migrated), f.links, f.gate);
    const review = await service.prepare(principal);
    expect((await service.confirm(principal, f.command(review.confirmationRef))).state).toBe('SUCCEEDED');
    expect(f.write).toHaveBeenCalledTimes(1);
  });
  it('rollout OPS-02 restringe revisão, confirmação e consulta, sem ampliar autorização', async () => {
    const f = setup(), review = await f.service.prepare(principal), command = f.command(review.confirmationRef);
    const app = createApp(undefined, { config: { ...f.cfg, conversationOrganizerIds: ['222222222'] }, links: f.links as IfoodLinkService, cartWrites: f.service });
    const base = `/api/bot/v1/conversations/${principal.conversationId}/cart-writes`;
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json',
      'x-telegram-user-id': principal.organizerId, 'x-telegram-chat-id': principal.conversationId };
    for (const suffix of ['reviews', 'confirm']) {
      const response = await app.request(`${base}/${suffix}`, { method: 'POST', headers,
        body: JSON.stringify(suffix === 'reviews' ? {} : { ...command, purpose: 'PREPARE_CART', source: 'TELEGRAM_CALLBACK' }) });
      expect(response.status).toBe(503);
      expect((await response.json()).error.kind).toBe('CART_FEATURE_DISABLED');
    }
    expect((await app.request(`${base}/current`, { headers })).status).toBe(503);
    expect((await app.request(`${base}/operations/${'a'.repeat(32)}`, { headers })).status).toBe(503);
    expect(f.write).not.toHaveBeenCalled();
    expect(f.turns.db.prepare('SELECT consumed FROM cart_write_reviews').get()!['consumed']).toBe(0);
  });
  it('status operacional distingue CART-01 montada de autorização de compra e não expõe a revisão', async () => {
    const f = setup(), review = await f.service.prepare(principal);
    const response = await f.app.request('/api/ops/status', { headers: { authorization: `Bearer ${token}`, 'x-telegram-user-id': principal.organizerId } });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(JSON.parse(text).purchase).toMatchObject({ capable: false, cartPreparation: 'HUMAN_CONFIRMATION_REQUIRED',
      submission: 'DISABLED', reason: 'PREPARE_CART_ONLY' });
    expect(text).not.toContain(review.confirmationRef);
    expect(f.write).not.toHaveBeenCalled();
  });
  it('preparar revisão não escreve; clique específico executa uma vez e não autoriza pedido', async () => {
    const f = setup(), review = await f.service.prepare(principal);
    expect(f.write).not.toHaveBeenCalled();
    expect(review).toMatchObject({ purpose: 'PREPARE_CART', totalCents: null, unknownCosts: true, purchaseAuthorized: false });
    const command = f.command(review.confirmationRef), result = await f.service.confirm(principal, command);
    expect(result).toMatchObject({ state: 'SUCCEEDED', completedOperations: 1, checkoutEnabled: false, purchaseAuthorized: false });
    expect(f.write).toHaveBeenCalledTimes(1);
    f.advance(400_000);
    expect(await f.service.confirm(principal, command)).toMatchObject({ state: 'SUCCEEDED' });
    expect(f.write).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['sem endereço textual igual', 'Outra Rua', 'FAILED'],
    ['formato observado com promoção', 'Rua Sintética', 'SUCCEEDED'],
  ])('INT-02 %s: carrinho inteiro sem addressId, total só informado pelo iFood', async (_label, street, expected) => {
    const f = setup(), loc = { street: 'Rua Sintética', number: '10', neighborhood: 'Centro', city: 'Cidade sintética' };
    const address = { addressId: A, location: loc, coordinates: { latitude: -1, longitude: -2 } };
    vi.mocked(f.ctx.deps.listAddresses).mockResolvedValue({ results: [address] });
    f.turns.db.prepare('UPDATE delivery_address_selected SET address_hash=?').run(contentHash(addressSchema.parse(address)));
    // Forma das respostas reais (fixtures/int02/cart); valores sintéticos.
    const cartId = randomUUID(), lines: { itemId: string; cartItemId: string; quantity: number }[] = [];
    const observed = (promo: boolean) => { const sub = lines.reduce((n, l) => n + l.quantity * 20, 0);
      return { cartId, merchant: { merchantId: M, merchantName: 'Loja' },
        items: lines.map(l => ({ ...l, unitPrice: 20, name: 'Arroz' })),
        deliveryAddress: { streetName: street, streetNumber: '10', neighborhood: 'Centro' },
        deliveryMethod: { deliveryMethodId: 'DEFAULT', deliveryMethodMode: 'DELIVERY', fee: 0 },
        fees: [{ name: 'Taxa de serviço', amount: 0.99 }],
        summary: { totalAmount: Math.round((promo ? sub + 0.99 - 5 : sub + 0.99) * 100) / 100, subtotalAmount: sub, deliveryFeeAmount: 0, feeTotalAmount: 0.99,
          benefitsTotalAmount: promo ? 10 : 5, voucherTotalAmount: 0 } }; };
    f.write.mockImplementation(async (tool: string, args: Record<string, unknown>) => {
      if (tool !== 'createCart') throw new Error('inesperado');
      for (const i of args.items as { itemId: string; quantity: number }[]) lines.push({ itemId: i.itemId, cartItemId: randomUUID(), quantity: i.quantity });
      return observed(false); // createCart responde antes de aplicar a promoção (observado)
    });
    f.read.mockImplementation((async () => observed(true)) as never);
    const review = await f.service.prepare(principal), result = await f.service.confirm(principal, f.command(review.confirmationRef));
    expect(result).toMatchObject({ state: expected, purchaseAuthorized: false, checkoutEnabled: false });
    expect(f.write).toHaveBeenCalledTimes(1);
    if (expected === 'SUCCEEDED') expect((result as { budget?: unknown }).budget).toMatchObject({ status: 'UNVERIFIED' }); // total informado nunca vira orçamento confirmado
    else expect(result).toMatchObject({ code: 'CART_IDENTITY_MISMATCH' });
  });
  it('teto individual nunca perguntado não bloqueia a revisão (o bot só pergunta o orçamento do grupo)', async () => {
    const f = setup(), s = f.state();
    s.participants[0]!.limit = { state: 'NOT_ASKED' };
    f.save(s);
    expect(await f.service.prepare(principal)).toMatchObject({ purpose: 'PREPARE_CART', purchaseAuthorized: false });
    expect(f.write).not.toHaveBeenCalled();
  });
  it('confirmação ausente/expirada e referência de outro organizador não escrevem', async () => {
    const f = setup();
    await expect(f.service.confirm(principal, f.command('inexistente'))).rejects.toMatchObject({ code: 'CART_CONFIRMATION_EXPIRED' });
    const r = await f.service.prepare(principal);
    await expect(f.service.confirm({ ...principal, organizerId: '222222222', conversationId: '222222222' }, f.command(r.confirmationRef))).rejects.toBeDefined();
    f.advance(300_001);
    await expect(f.service.confirm(principal, f.command(r.confirmationRef))).rejects.toMatchObject({ code: 'CART_CONFIRMATION_EXPIRED' });
    expect(f.write).not.toHaveBeenCalled();
  });
  it('consome confirmação uma vez; requestId com conteúdo diferente conflita', async () => {
    const f = setup(), r = await f.service.prepare(principal), c = f.command(r.confirmationRef);
    await f.service.confirm(principal,c);
    await expect(f.service.confirm(principal,{ ...c, callbackId: 'outro' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(f.service.confirm(principal,f.command(r.confirmationRef))).rejects.toMatchObject({ code: 'CART_CONFIRMATION_EXPIRED' });
    expect(f.write).toHaveBeenCalledTimes(1);
  });
  it('dois cliques concorrentes e duas instâncias produzem uma única escrita', async () => {
    const f = setup(), r = await f.service.prepare(principal);
    const other = new TurnStore(f.path, {}, f.now); stores.push(other);
    const second = new ConfirmedCartService(new CartWriteStore(other), f.links, f.gate);
    const outcomes = await Promise.allSettled([f.service.confirm(principal,f.command(r.confirmationRef)), second.confirm(principal,f.command(r.confirmationRef))]);
    expect(outcomes.filter(o => o.status === 'fulfilled')).toHaveLength(1);
    expect(f.write).toHaveBeenCalledTimes(1);
  });
  it('timeout após efeito é RESULT_UNKNOWN e bloqueia novo requestId, nova conexão e reinício', async () => {
    const f = setup(), r = await f.service.prepare(principal), c = f.command(r.confirmationRef);
    const original = f.write.getMockImplementation()!;
    f.write.mockImplementationOnce(async (...args) => { await original(...args); throw new Error('resposta perdida'); });
    const result = await f.service.confirm(principal,c);
    expect(result.state).toBe('RESULT_UNKNOWN');
    await expect(f.service.inspect(principal)).rejects.toMatchObject({ code: 'CART_NOT_FOUND' });
    await expect(f.service.prepare(principal)).rejects.toMatchObject({ code: 'RESULT_UNKNOWN' });
    const again = new TurnStore(f.path, {}, f.now); stores.push(again);
    const restarted = new ConfirmedCartService(new CartWriteStore(again), f.links, f.gate);
    expect((await restarted.confirm(principal,c)).state).toBe('RESULT_UNKNOWN');
    f.setLink('outro-vinculo');
    await expect(restarted.prepare(principal)).rejects.toMatchObject({ code: 'RESULT_UNKNOWN' });
    expect(f.write).toHaveBeenCalledTimes(1);
  });
  it('reinício no intervalo após PENDING não retoma a escrita e expira em desconhecido', async () => {
    const f = setup(), review = await f.service.prepare(principal), c = f.command(review.confirmationRef);
    const store = new CartWriteStore(f.turns), plan = store.readReview(principal,c.confirmationRef), intent = store.reserve(principal,c,plan);
    store.beforeCall(principal,intent.id,plan.purchaseHash);
    f.advance(120_001);
    const restarted = new TurnStore(f.path, {}, f.now); stores.push(restarted);
    const service = new ConfirmedCartService(new CartWriteStore(restarted), f.links, f.gate);
    expect((await service.confirm(principal,c)).state).toBe('RESULT_UNKNOWN');
    expect(f.write).not.toHaveBeenCalled();
  });
  it('falha no GET posterior a criação salva cartId e não recria no replay', async () => {
    const f = setup(), r = await f.service.prepare(principal), c = f.command(r.confirmationRef);
    f.read.mockRejectedValueOnce(new Error('getCart indisponível'));
    expect((await f.service.confirm(principal,c)).state).toBe('FAILED');
    expect((await f.service.inspect(principal)).cart!.cartId).toBe(f.remote().cartId);
    expect((await f.service.confirm(principal,c)).state).toBe('FAILED');
    expect(f.write).toHaveBeenCalledTimes(1);
  });
  it.each(['grupo','preço','vínculo'] as const)('mudança em %s após revisão exige nova confirmação', async kind => {
    const f = setup(), r = await f.service.prepare(principal);
    if (kind === 'grupo') { const s = f.state(); s.version++; f.save(s); }
    if (kind === 'preço') f.setPrice(21);
    if (kind === 'vínculo') f.setLink('outro-vinculo');
    await expect(f.service.confirm(principal,f.command(r.confirmationRef))).rejects.toBeDefined();
    expect(f.write).not.toHaveBeenCalled();
  });
  it('versão alterada durante getItem não produz revisão utilizável', async () => {
    const f = setup();
    vi.spyOn(f.ctx.deps,'getItem').mockImplementationOnce(async () => { const s = f.state(); s.version++; f.save(s);
      return { itemId: I, merchantId: M, itemName: 'Arroz', unitPrice: 20, optionGroups: [] }; });
    await expect(f.service.prepare(principal)).rejects.toMatchObject({ code: 'CART_REVIEW_CHANGED' });
    expect(f.write).not.toHaveBeenCalled();
  });
  it('reavalia alergia por pessoa: sem dado do iFood a preparação segue com a restrição na revisão (aviso, não bloqueio)', async () => {
    const f = setup(), s = f.state(), person = s.participants[0]!;
    person.restrictions = { state: 'DECLARED', value: [{ restrictionId: 'restriction00000001', key: { kind: 'ALLERGY', code: 'MILK' }, origin: { eventId: 'fake' } }], origin: { eventId: 'fake' } };
    s.bag!.coverage![0]!.restrictionsSig = restrictionsSig(s,person); f.save(s);
    const review = await f.service.prepare(principal);
    expect(review).toMatchObject({ purpose: 'PREPARE_CART', purchaseAuthorized: false });
    expect(review.coverage).toEqual(expect.arrayContaining([expect.objectContaining({ participantId: person.participantId, status: 'COVERED' })]));
    expect(f.write).not.toHaveBeenCalled();
  });
  it('reavalia alergia por pessoa mesmo se cobertura persistida disser COVERED: conflito informado bloqueia', async () => {
    const f = setup(), s = f.state(), person = s.participants[0]!;
    person.restrictions = { state: 'DECLARED', value: [{ restrictionId: 'restriction00000001', key: { kind: 'ALLERGY', code: 'MILK' }, origin: { eventId: 'fake' } }], origin: { eventId: 'fake' } };
    s.bag!.coverage![0]!.restrictionsSig = restrictionsSig(s,person);
    s.bag!.lines[0]!.name = 'Arroz com leite'; f.save(s);
    const listing = vi.mocked(f.ctx.deps.searchOffers).getMockImplementation()!, detail = vi.mocked(f.ctx.deps.getItem).getMockImplementation()!;
    vi.mocked(f.ctx.deps.searchOffers).mockImplementation(async (...a) => { const r = await listing(...a) as { results: Record<string, unknown>[] };
      return { results: r.results.map((x) => ({ ...x, itemName: 'Arroz com leite' })) }; });
    vi.mocked(f.ctx.deps.getItem).mockImplementation(async (...a) => ({ ...(await detail(...a) as Record<string, unknown>), itemName: 'Arroz com leite' }));
    await expect(f.service.prepare(principal)).rejects.toMatchObject({ code: 'CART_ITEM_BLOCKED' });
    expect(f.write).not.toHaveBeenCalled();
  });
  it('alteração externa de composição/taxa invalida confirmação de atualização', async () => {
    const f = setup(), first = await f.service.prepare(principal); await f.service.confirm(principal,f.command(first.confirmationRef));
    const s = f.state(); s.bag!.lines[0]!.quantity=2; s.version++; f.save(s);
    const r = await f.service.prepare(principal);
    f.remote().totals.serviceFee=3; f.remote().totals.total=28;
    await expect(f.service.confirm(principal,f.command(r.confirmationRef))).rejects.toMatchObject({ code: 'CART_REMOTE_CHANGED' });
    expect(f.write).toHaveBeenCalledTimes(1);
  });
  it('alteração confirmada usa cartItemId de getCart e recalcula com DOM-01', async () => {
    const f=setup(), first=await f.service.prepare(principal); await f.service.confirm(principal,f.command(first.confirmationRef));
    const s=f.state(); s.bag!.lines[0]!.quantity=2; s.version++; f.save(s);
    const r=await f.service.prepare(principal), result=await f.service.confirm(principal,f.command(r.confirmationRef));
    expect(result.state).toBe('SUCCEEDED');
    expect(f.write.mock.calls[1]).toEqual(['updateCartItem',expect.objectContaining({cartId:f.remote().cartId,cartItemId:f.remote().items[0]!.cartItemId,quantity:2})]);
    expect('budget' in result && result.budget).toMatchObject({ status:'WITHIN_LIMITS', allocation:{totalCents:4600} });
  });
  it('regressão da auditoria: troca externa por item de mesmo preço não valida rateio antigo', async () => {
    const f=setup(), first=await f.service.prepare(principal); await f.service.confirm(principal,f.command(first.confirmationRef));
    f.remote().items[0]!.itemId=randomUUID();
    expect((await f.service.inspect(principal)).budget).toMatchObject({status:'UNVERIFIED'});
  });
  it('escopos ausentes não se convertem em autorização de escrita', async () => {
    const f=setup();
    vi.mocked(f.links.status).mockResolvedValueOnce({...await f.links.status(principal.organizerId), scopeEvidence:'NOT_PROVIDED', allowedOperations:[]});
    await expect(f.service.prepare(principal)).rejects.toMatchObject({code:'CART_PERMISSIONS_UNVERIFIED'});
    expect(f.write).not.toHaveBeenCalled();
  });
  it('regressão da auditoria: feature desligada responde 503 na consulta', async () => {
    const cfg=loadConfig({BOT_API_TOKEN:token,ALLOWED_ORGANIZER_IDS:principal.organizerId});
    const app=createApp(undefined,{config:cfg});
    const response=await app.request(`/api/bot/v1/conversations/${principal.conversationId}/cart-writes/current`,{
      headers:{authorization:`Bearer ${token}`,'x-telegram-user-id':principal.organizerId,'x-telegram-chat-id':principal.conversationId}});
    expect(response.status).toBe(503); expect((await response.json()).error.kind).toBe('CART_FEATURE_DISABLED');
  });
  it('consulta técnica de intenção desconhecida continua possível após 24h sem renovar confirmação', async () => {
    const f=setup(), first=await f.service.prepare(principal); await f.service.confirm(principal,f.command(first.confirmationRef));
    const s=f.state();s.bag!.lines[0]!.quantity=2;s.version++;f.save(s);
    const r=await f.service.prepare(principal);
    f.write.mockRejectedValueOnce(new Error('resposta desconhecida'));
    expect((await f.service.confirm(principal,f.command(r.confirmationRef))).state).toBe('RESULT_UNKNOWN');
    f.advance(86_400_001);
    expect((await f.service.inspect(principal)).budget).toMatchObject({status:'UNVERIFIED'});
    await expect(f.service.prepare(principal)).rejects.toMatchObject({code:'RESULT_UNKNOWN'});
    expect(f.turns.purge()).toEqual({purged:0,failed:0});
  });
  it.each(['timeout','taxa','composição','preço','subtotal'] as const)('interrompe sequência após falha parcial: %s',async kind=>{
    const f=setup(), first=await f.service.prepare(principal); await f.service.confirm(principal,f.command(first.confirmationRef));
    // Alteração externa conhecida na revisão: remover a linha extra e atualizar arroz são dois passos distintos.
    f.remote().items.push({cartItemId:randomUUID(),itemId:randomUUID(),quantity:1,options:[],unitPrice:20});
    f.remote().totals.subtotal=40;f.remote().totals.total=46;
    const s=f.state();s.bag!.lines[0]!.quantity=2;s.version++;f.save(s);
    const r=await f.service.prepare(principal), c=f.command(r.confirmationRef), original=f.write.getMockImplementation()!;
    f.write.mockImplementation(async(tool,args)=>{
      if(tool==='updateCartItem' && kind==='timeout') throw new Error('resposta perdida');
      const result=await original(tool,args);
      if(tool==='removeItemFromCart' && kind==='taxa'){f.remote().totals.serviceFee=2;f.remote().totals.total++;}
      if(tool==='removeItemFromCart' && kind==='composição')f.remote().items[0]!.itemId=randomUUID();
      if(tool==='removeItemFromCart' && kind==='preço'){f.remote().items[0]!.unitPrice=21;f.remote().totals.subtotal=21;f.remote().totals.total=27;}
      if(tool==='removeItemFromCart' && kind==='subtotal'){f.remote().totals.subtotal=21;f.remote().totals.total=27;}
      return result;
    });
    const result=await f.service.confirm(principal,c);
    expect(result.state).toBe(kind==='timeout'?'RESULT_UNKNOWN':'FAILED');
    expect(result.completedOperations).toBe(1);
    const calls=f.write.mock.calls.length;
    await f.service.confirm(principal,c);expect(f.write).toHaveBeenCalledTimes(calls);
    if(kind!=='timeout')expect(f.write.mock.calls.some(([tool])=>tool==='updateCartItem')).toBe(false);
    expect('budget' in result && result.budget).toMatchObject({status:'UNVERIFIED'});
  });
  it('regressão da auditoria: reconhecimento e head técnico são atômicos antes do GET',async()=>{
    const f=setup(),r=await f.service.prepare(principal),c=f.command(r.confirmationRef),store=new CartWriteStore(f.turns);
    const plan=store.readReview(principal,c.confirmationRef),intent=store.reserve(principal,c,plan);
    store.beforeCall(principal,intent.id,plan.purchaseHash);
    const cartId=randomUUID();
    store.stepDone(principal,f.state(),intent.id,1,cartId);
    f.advance(120_001);
    const reopened=new TurnStore(f.path,{},f.now);stores.push(reopened);
    const recovered=new CartWriteStore(reopened);recovered.assertNotBlocked(principal);
    expect(recovered.head(principal,f.state())).toMatchObject({cartId,snapshot:null});
    const service=new ConfirmedCartService(recovered,f.links,f.gate);
    await expect(service.prepare(principal)).rejects.toBeDefined();
    expect(f.write).not.toHaveBeenCalled();
  });
  it('rollback do head desfaz reconhecimento e mantém marcador de possível efeito',async()=>{
    const f=setup(),r=await f.service.prepare(principal),c=f.command(r.confirmationRef),store=new CartWriteStore(f.turns);
    const plan=store.readReview(principal,c.confirmationRef),intent=store.reserve(principal,c,plan);
    store.beforeCall(principal,intent.id,plan.purchaseHash);
    f.turns.db.exec("CREATE TRIGGER fail_cart_head BEFORE INSERT ON cart_write_heads BEGIN SELECT RAISE(ABORT,'synthetic-fault'); END");
    expect(()=>store.stepDone(principal,f.state(),intent.id,1,randomUUID())).toThrow();
    expect(store.intent(principal,intent.id)).toMatchObject({step:0,sent:1});
    f.advance(120_001);
    await expect(f.service.prepare(principal)).rejects.toMatchObject({code:'RESULT_UNKNOWN'});
    expect(f.write).not.toHaveBeenCalled();
  });
  it('consumação da confirmação e intenção fazem rollback juntas se persistência falhar',async()=>{
    const f=setup(),r=await f.service.prepare(principal),c=f.command(r.confirmationRef);
    f.turns.db.exec("CREATE TRIGGER fail_cart_intent BEFORE INSERT ON cart_write_intents BEGIN SELECT RAISE(ABORT,'synthetic-fault'); END");
    await expect(f.service.confirm(principal,c)).rejects.toBeDefined();
    expect(f.turns.db.prepare('SELECT consumed FROM cart_write_reviews').get()!['consumed']).toBe(0);
    expect(f.turns.db.prepare('SELECT count(*) AS n FROM cart_write_intents').get()!['n']).toBe(0);
    expect(f.write).not.toHaveBeenCalled();
    f.turns.db.exec('DROP TRIGGER fail_cart_intent');
    expect((await f.service.confirm(principal,c)).state).toBe('SUCCEEDED');
  });
  it('turno concorrente não altera a versão do domínio durante escrita pendente',async()=>{
    const f=setup(),r=await f.service.prepare(principal),c=f.command(r.confirmationRef),store=new CartWriteStore(f.turns);
    f.turns.accept(principal,turnEvent(987,f.state().version));
    const job=f.turns.claim('synthetic-worker')!;
    const plan=store.readReview(principal,c.confirmationRef);store.reserve(principal,c,plan);
    expect(f.turns.finish(job,turnResult(job))).toBe(false);
    expect(store.purchase(principal).version).toBe(plan.version);
    expect(f.turns.operation(principal,job.operation.operationId)).toMatchObject({status:'FAILED',error:{code:'UNAVAILABLE'}});
    expect(f.write).not.toHaveBeenCalled();
  });
  it.each(['ausente','divergente'] as const)('preço unitário remoto %s não valida rateio apenas pelo subtotal',async kind=>{
    const f=setup(),r=await f.service.prepare(principal);await f.service.confirm(principal,f.command(r.confirmationRef));
    if(kind==='ausente')delete f.remote().items[0]!.unitPrice;else f.remote().items[0]!.unitPrice=19;
    expect((await f.service.inspect(principal)).budget).toMatchObject({status:'UNVERIFIED'});
  });
  it('prazo humano continua obrigatório imediatamente antes da escrita',async()=>{
    const f=setup(),r=await f.service.prepare(principal);
    f.advance(299_000);
    const original=vi.mocked(f.ctx.deps.getItem).getMockImplementation()!;
    let reads=0;
    vi.spyOn(f.ctx.deps,'getItem').mockImplementation(async(...args)=>{
      if(++reads===2)f.advance(2_000);
      return original(...args);
    });
    const result=await f.service.confirm(principal,f.command(r.confirmationRef));
    expect(result).toMatchObject({state:'FAILED',code:'CART_CONFIRMATION_EXPIRED'});
    expect(f.write).not.toHaveBeenCalled();
  });
  it('gate confere hashes, metadados e argumentos com manifesto inteiramente sintético de teste',async()=>{
    const f=setup(),r=await f.service.prepare(principal);await f.service.confirm(principal,f.command(r.confirmationRef));
    const schemas={createCart:{type:'object',properties:{merchantId:{type:'string'},addressId:{type:'string'},items:{type:'array'}},required:['merchantId','addressId','items'],additionalProperties:false},
      getCart:{type:'object',properties:{cartId:{type:'string'}},required:['cartId'],additionalProperties:false}};
    const createSample={cartId:f.remote().cartId},getSample=f.remote(),path=join(f.dir,'synthetic-manifest.json');
    writeFileSync(join(f.dir,'synthetic-created.json'),JSON.stringify(createSample));writeFileSync(join(f.dir,'synthetic-get.json'),JSON.stringify(getSample));
    const parser=readFileSync('src/server/cart/contracts.ts','utf8').replace(/\r\n/g,'\n');
    const proof={version:1,endpoint:'https://consumer-mcp.ifood.com.br/marketplace',source:'OBSERVED_AUTHENTICATED',businessToolsCalled:true,
      parserSha256:createHash('sha256').update(parser).digest('hex'),tools:[
        {name:'createCart',inputSchemaSha256:contentHash(schemas.createCart),observedAt:new Date(f.now()).toISOString(),samplePath:'synthetic-created.json',sampleSha256:contentHash(createSample)},
        {name:'getCart',inputSchemaSha256:contentHash(schemas.getCart),observedAt:new Date(f.now()).toISOString(),samplePath:'synthetic-get.json',sampleSha256:contentHash(getSample)}]};
    writeFileSync(path,JSON.stringify(proof));
    f.gateway.describe=async()=>[{name:'createCart',inputSchema:schemas.createCart},{name:'getCart',inputSchema:schemas.getCart}];
    const gate=new ObservedCartContract(path);
    await expect(gate.verify(f.gateway,['createCart'],[{tool:'createCart',args:{merchantId:M,addressId:A,items:[]}}])).resolves.toBeUndefined();
    await expect(gate.verify(f.gateway,['createCart'],[{tool:'createCart',args:{userId:'forjado'}}])).rejects.toMatchObject({code:'CART_CONTRACT_UNVERIFIED'});
    f.gateway.describe=async()=>[{name:'ifood_createCart',inputSchema:schemas.createCart},{name:'getCart',inputSchema:schemas.getCart}];
    await expect(gate.verify(f.gateway,['createCart'])).rejects.toMatchObject({code:'CART_CONTRACT_UNVERIFIED'});
    writeFileSync(path,JSON.stringify({...proof,parserSha256:'0'.repeat(64)}));
    await expect(gate.verify(f.gateway,['createCart'])).rejects.toMatchObject({code:'CART_CONTRACT_UNVERIFIED'});
  });
  it('schemas/saídas não observados impedem escrita e geração de confirmação', async () => {
    const f=setup(), service=new ConfirmedCartService(new CartWriteStore(f.turns),f.links,new ObservedCartContract(join(f.dir,'inexistente.json')));
    await expect(service.prepare(principal)).rejects.toMatchObject({code:'CART_CONTRACT_UNVERIFIED'});
    expect(f.write).not.toHaveBeenCalled();
  });
  it('rota humana rejeita booleano de consentimento, finalidade de compra e chat de outra pessoa', async () => {
    const f=setup(), r=await f.service.prepare(principal), c=f.command(r.confirmationRef);
    expect((await f.call('confirm',{...c,userConsent:true})).status).toBe(400);
    expect((await f.call('confirm',{...c,purpose:'SUBMIT_ORDER',source:'TELEGRAM_CALLBACK'})).status).toBe(400);
    expect((await f.call('confirm',{...c,purpose:'PREPARE_CART',source:'TELEGRAM_CALLBACK'},{'x-telegram-chat-id':'222222222'})).status).toBe(403);
    expect((await f.call('confirm',{...c,purpose:'PREPARE_CART',source:'TELEGRAM_CALLBACK'})).status).toBe(200);
    expect(f.write).toHaveBeenCalledTimes(1);
  });
  it('endpoints legados não escrevem, mesmo com flag antiga ativa', async () => {
    const f=setup();
    for(const suffix of ['', '/fake/items','/fake/payment','/fake/approve','/fake/submit']) {
      const response=await f.app.request(`/api/bot/cart${suffix}`,{method:'POST',headers:{authorization:`Bearer ${token}`,'x-telegram-user-id':principal.organizerId}});
      expect(response.status).toBe(409);
    }
    expect(f.write).not.toHaveBeenCalled();
  });
  it('confirmação e referência não entram no domínio/modelContext e banco não guarda texto do callback', async () => {
    const f=setup(), r=await f.service.prepare(principal), c=f.command(r.confirmationRef);
    await f.service.confirm(principal,c);
    expect(JSON.stringify(f.state())).not.toContain(r.confirmationRef);
    const stored=JSON.stringify(f.turns.db.prepare('SELECT * FROM cart_write_intents').all());
    expect(stored).not.toContain(c.confirmationRef); expect(stored).not.toContain(c.callbackId);
  });
  it('manifesto vazio não é prova de contrato e flag exige banco e evidência', async () => {
    const f=setup(), path=join(f.dir,'proof.json'); writeFileSync(path,'{}');
    await expect(new ObservedCartContract(path).verify(f.gateway,['createCart'])).rejects.toMatchObject({code:'CART_CONTRACT_UNVERIFIED'});
    expect(()=>loadConfig({IFOOD_CONFIRMED_CART_WRITES_ENABLED:'true'})).toThrow(/CART-01/);
    expect(()=>loadConfig({IFOOD_CONFIRMED_CART_WRITES_ENABLED:'yes'})).toThrow(/true ou false/);
  });
});
