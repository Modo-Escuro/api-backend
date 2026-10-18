import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CATALOG_LIMITS } from '../../src/server/cart/catalog';
import { loadConfig } from '../../src/server/config';
import { ORG_A, connectAndConfirm } from '../helpers/fakes';
import { ADDRESS_ID, DETAIL, MERCHANT_ID, cartSetup, chosenItem } from './fakes';

afterEach(() => vi.useRealTimers());

async function ready() {
  const f = cartSetup();
  const linked = await connectAndConfirm(f.env, ORG_A), linkId = linked.status.linkId!;
  const catalog = await f.carts.catalog(ORG_A, { linkId, addressId: ADDRESS_ID, query: 'lanche' });
  const item = chosenItem(catalog.items[0]!.itemRef);
  const cart = await f.carts.createCart(ORG_A, { linkId, requestId: randomUUID(), items: [item] });
  return { ...f, linkId, item, cart };
}

describe('regressão: expiração não é troca de conta', () => {
  it('renova/verifica o access token e preserva o carrinho e linkId', async () => {
    const f = await ready();
    f.env.clock.advance(3600_001);
    const carts = await Promise.all([1, 2].map(() => f.carts.getCart(ORG_A, f.linkId, f.cart.cartRef)));
    expect(carts.every((cart) => cart.cartRef === f.cart.cartRef && cart.linkId === f.linkId)).toBe(true);
    expect(f.env.as.count('refresh_token')).toBe(1);
    expect(await f.env.links.status(ORG_A)).toMatchObject({ state: 'CONNECTED', operational: true, linkId: f.linkId });
  });
  it('falha temporária no refresh é UNAVAILABLE e permite recuperação no mesmo vínculo', async () => {
    const f = await ready();
    f.env.clock.advance(3600_001);
    f.env.as.refreshMode = 'network';
    await expect(f.carts.getCart(ORG_A, f.linkId, f.cart.cartRef)).rejects.toMatchObject({ code: 'IFOOD_UNAVAILABLE' });
    expect(await f.env.links.status(ORG_A)).toMatchObject({ state: 'UNAVAILABLE', linkId: f.linkId });
    f.env.as.refreshMode = 'ok';
    expect((await f.carts.getCart(ORG_A, f.linkId, f.cart.cartRef)).cartRef).toBe(f.cart.cartRef);
  });
  it('refresh recusado exige reconexão e não vira CART_LINK_CHANGED', async () => {
    const f = await ready();
    f.env.clock.advance(3600_001);
    f.env.as.refreshMode = 'invalid_grant';
    await expect(f.carts.getCart(ORG_A, f.linkId, f.cart.cartRef)).rejects.toMatchObject({ code: 'IFOOD_RECONNECT_REQUIRED' });
    expect(await f.env.links.status(ORG_A)).toMatchObject({ state: 'RECONNECT_REQUIRED', linkId: f.linkId });
  });
});

describe('regressão: escrita confirmada seguida de falha na releitura', () => {
  it.each(['delivery', 'payment', 'voucher'] as const)('%s: mesmo requestId só relê getCart', async (kind) => {
    const f = await ready();
    const choices = await f.carts.listChoices(ORG_A, f.linkId, f.cart.cartRef, kind);
    const choiceRef = choices.choices[0]!.choiceRef, requestId = randomUUID();
    const tool = kind === 'delivery' ? 'setCartDelivery' : kind === 'payment' ? 'setCartPayment' : 'setVoucher';
    f.fake.hook = async (name) => { if (name === tool) f.fake.fail = 'getCart'; };
    await expect(f.carts.selectChoice(ORG_A, f.linkId, f.cart.cartRef, requestId, kind, choiceRef)).rejects.toBeDefined();
    f.fake.hook = null; f.fake.fail = null;
    const before = f.fake.call.mock.calls.length;
    expect((await f.carts.selectChoice(ORG_A, f.linkId, f.cart.cartRef, requestId, kind, choiceRef)).state).toBe('DRAFT');
    expect(f.fake.call.mock.calls.slice(before).map((call) => call[1])).toEqual(['getCart']);
    expect(f.fake.call.mock.calls.filter((call) => call[1] === tool)).toHaveLength(1);
    await expect(f.carts.selectChoice(ORG_A, f.linkId, f.cart.cartRef, requestId, kind, 'outra-referencia-valida')).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });
  it.each(['add', 'update'] as const)('%s: retry confirmado dispensa itemRef expirado e getItem indisponível', async (operation) => {
    const f = await ready(), requestId = randomUUID();
    const write = () => operation === 'add'
      ? f.carts.addItemToCart(ORG_A, f.linkId, f.cart.cartRef, requestId, f.item)
      : f.carts.updateCartItem(ORG_A, f.linkId, f.cart.cartRef, requestId, f.cart.items[0]!.cartItemId, f.item);
    const tool = operation === 'add' ? 'addItemToCart' : 'updateCartItem';
    f.fake.hook = async (name) => { if (name === tool) f.fake.fail = 'getCart'; };
    await expect(write()).rejects.toBeDefined();
    f.fake.hook = null; f.fake.fail = null;
    f.env.clock.advance(5 * 60_000 + 1);
    f.reads.getItem.mockClear().mockRejectedValue(new Error('getItem sinteticamente indisponível'));
    expect((await write()).state).toBe('DRAFT');
    expect(f.reads.getItem).not.toHaveBeenCalled();
    expect(f.fake.call.mock.calls.filter((call) => call[1] === tool)).toHaveLength(1);
  });
});

async function catalogReady(count: number) {
  const f = cartSetup();
  const linked = await connectAndConfirm(f.env, ORG_A), linkId = linked.status.linkId!;
  const listings = Array.from({ length: count }, () => ({ itemId: randomUUID(), merchant: { merchantId: MERCHANT_ID } }));
  f.reads.searchOffers.mockResolvedValue({ results: listings });
  const run = () => f.carts.catalog(ORG_A, { linkId, addressId: ADDRESS_ID, query: 'lanche' });
  return { ...f, linkId, listings, run };
}
describe('regressão: catálogo parcial, concorrência e prazo total', () => {
  it('uma falha de getItem não descarta os outros candidatos', async () => {
    const f = await catalogReady(4), failedId = f.listings[1]!.itemId;
    f.reads.getItem.mockImplementation(async (args) => {
      if (args.itemId === failedId) throw new Error('detalhe-sintético-com-dado-que-não-deve-sair');
      return { ...structuredClone(DETAIL), itemId: args.itemId };
    });
    const catalog = await f.run();
    expect(catalog.items).toHaveLength(3);
    expect(catalog).toMatchObject({ partial: true, details: { requested: 4, detailed: 3, failed: 1, skippedDeadline: 0 } });
    expect(catalog.errors).toEqual([{ itemId: failedId, kind: 'DETAIL_UNAVAILABLE', code: null }]);
    expect(JSON.stringify(catalog)).not.toContain('detalhe-sintético');
  });
  it('usa no máximo três getItem simultâneos e preserva a ordem da listagem', async () => {
    const f = await catalogReady(8);
    let active = 0, peak = 0;
    f.reads.getItem.mockImplementation(async (args) => {
      peak = Math.max(peak, ++active);
      await Promise.resolve();
      active--;
      return { ...structuredClone(DETAIL), itemId: args.itemId, itemName: args.itemId };
    });
    const catalog = await f.run();
    expect(peak).toBe(CATALOG_LIMITS.concurrency);
    expect(catalog.items.map((item) => item.itemName)).toEqual(f.listings.map((item) => item.itemId));
    expect(catalog.partial).toBe(false);
  });
  it('retorna os itens já detalhados ao atingir o prazo, mesmo se o provedor ignorar timeout', async () => {
    const f = await catalogReady(10);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    let entered!: () => void;
    const reached = new Promise<void>((resolve) => { entered = resolve; });
    const pending: { resolve: (detail: typeof DETAIL) => void; itemId: string; signal: AbortSignal }[] = [];
    let cleanup = false, finished = false;
    f.reads.getItem.mockImplementation(async (args, opts) => {
      if (args.itemId === f.listings[0]!.itemId || cleanup) return { ...structuredClone(DETAIL), itemId: args.itemId };
      return new Promise((resolve) => { pending.push({ resolve, itemId: args.itemId, signal: opts.signal! }); entered(); });
    });
    const work = f.run();
    void work.then(() => { finished = true; }, () => { finished = true; });
    try {
      await reached;
      await vi.advanceTimersByTimeAsync(CATALOG_LIMITS.deadlineMs + 1);
      expect(finished).toBe(true);
      const catalog = await work;
      expect(catalog.items).toHaveLength(1);
      expect(catalog).toMatchObject({ partial: true, details: { deadlineReached: true, skippedDeadline: 3, failed: 6 } });
      expect(pending.every((call) => call.signal.aborted)).toBe(true);
    } finally {
      cleanup = true;
      for (const call of pending) call.resolve({ ...structuredClone(DETAIL), itemId: call.itemId });
      await work.catch(() => undefined);
    }
  });
  it('falha em todos os detalhes retorna catálogo vazio parcial, sem inventar referências', async () => {
    const f = await catalogReady(3);
    f.reads.getItem.mockRejectedValue(new Error('falha-sintética'));
    expect(await f.run()).toMatchObject({ items: [], partial: true, details: { detailed: 0, failed: 3 } });
  });
});

it('mantém feature e checkout desabilitados, sem o bloqueio fixo de issues já integradas', async () => {
  expect(loadConfig({}).cartEnabled).toBe(false);
  const f = await ready();
  expect(f.cart).toMatchObject({ checkoutEnabled: false, purchaseAuthorized: false });
  expect(f.cart.blockers).not.toContain('SECURITY_ISSUES_2_3_PENDING');
});
