import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { CartService } from '../../src/server/cart/service';
import { confirmedTotals, parseItem, parseSnapshot } from '../../src/server/cart/contracts';
import { McpToolError } from '../../src/server/mcp/errors';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { cartGateway } from '../../src/server/mcp/cart';
import { ORG_A, ORG_B, authorize, connectAndConfirm } from '../helpers/fakes';
import { ADDRESS_ID, CARD_TOKEN, ITEM_ID, OPTION_ID, PAYMENT_ID, cartSetup, chosenItem } from './fakes';

async function ready() {
  const f = cartSetup();
  const linked = await connectAndConfirm(f.env, ORG_A), linkId = linked.status.linkId!;
  const catalog = await f.carts.catalog(ORG_A, { linkId, addressId: ADDRESS_ID, query: 'lanche' });
  const item = chosenItem(catalog.items[0]!.itemRef);
  const intent = { linkId, requestId: randomUUID(), items: [item] };
  const cart = await f.carts.createCart(ORG_A, intent);
  return { ...f, linkId, item, intent, cart };
}
async function complete(f: Awaited<ReturnType<typeof ready>>) {
  for (const kind of ['delivery', 'payment'] as const) {
    const choices = await f.carts.listChoices(ORG_A, f.linkId, f.cart.cartRef, kind);
    await f.carts.selectChoice(ORG_A, f.linkId, f.cart.cartRef, randomUUID(), kind, choices.choices[0]!.choiceRef);
  }
  return f.carts.review(ORG_A, f.linkId, f.cart.cartRef);
}

describe('F7: carrinho com MCP exclusivamente simulado', () => {

  it('bloqueia variantes/customizações não observadas', () => {
    expect(() => parseItem({ variants: [{ id: 'desconhecido' }] })).toThrow(/Variantes/);
    expect(() => parseItem({ options: [{ customizations: null }] })).toThrow(/customizações/);
  });
  it('invalida revisão por expiração, cupom e troca do cartão com mesmo método', async () => {
    const f = await ready();
    await complete(f);
    const snapshot = [...f.fake.snapshots.values()][0]!.snapshot;
    (snapshot.paymentMethod as unknown as Record<string, unknown>).cardTokenId = 'token-sintético-alterado';
    expect((await f.carts.getCart(ORG_A, f.linkId, f.cart.cartRef)).review).toBeNull();
    await f.carts.review(ORG_A, f.linkId, f.cart.cartRef);
    snapshot.vouchers = [{ code: 'OUTRO', campaignId: '99999999-9999-4999-8999-999999999999' }];
    expect((await f.carts.getCart(ORG_A, f.linkId, f.cart.cartRef)).review).toBeNull();
    await f.carts.review(ORG_A, f.linkId, f.cart.cartRef);
    f.env.clock.advance(5 * 60_000 + 1);
    expect((await f.carts.getCart(ORG_A, f.linkId, f.cart.cartRef)).review).toBeNull();
  });
  it('erro inline após escrita é conservador, sanitizado e nunca repetido', async () => {
    const f = await ready();
    f.fake.hook = async (tool) => { if (tool === 'addItemToCart') throw new McpToolError(tool, [{ code: 'INTERNAL', message: 'segredo-sintético-que-não-deve-sair', retryable: true }]); };
    const result = await f.call('POST', `/api/bot/cart/${f.cart.cartRef}/items`, { linkId: f.linkId, requestId: randomUUID(), item: f.item });
    expect(result.status).toBe(409);
    const text = await result.text();
    expect(text).toContain('RESULT_UNKNOWN');
    expect(text).toContain('INTERNAL');
    expect(text).not.toContain('segredo-sintético');
    expect(JSON.parse(text).error.retryable).toBe(false);
  });
  it('gateway interpreta error singular e success=false sem confirmar mutação', async () => {
    const callTool = vi.fn().mockResolvedValueOnce({ structuredContent: { error: { code: 'OUT_OF_STOCK', message: 'Sem estoque', retryable: false } } })
      .mockResolvedValueOnce({ structuredContent: { success: false } });
    const gateway = cartGateway(async () => ({ callTool }) as unknown as Client);
    await expect(gateway.call('addItemToCart', {})).rejects.toMatchObject({ code: 'OUT_OF_STOCK' });
    await expect(gateway.call('addItemToCart', {})).rejects.toMatchObject({ code: 'UNCONFIRMED' });
    expect(callTool).toHaveBeenCalledTimes(2);
  });

  it('cria com IDs provados e devolve apenas dinheiro em centavos vindo de getCart', async () => {
    const f = await ready();
    expect(f.cart.totals).toEqual({ status: 'CONSISTENT', values: { subtotalCents: 2000, deliveryFeeCents: 500, serviceFeeCents: 100, discountCents: 0, totalCents: 2600 } });
    const args = f.fake.call.mock.calls.find((c) => c[1] === 'createCart')![2];
    expect(args.items).toEqual([{ itemId: ITEM_ID, quantity: 1, options: [{ optionId: OPTION_ID, quantity: 1 }] }]);
    expect(f.cart).toMatchObject({ checkoutEnabled: false, purchaseAuthorized: false });
  });
  it('create repetido e concorrente usa uma única mutação; conteúdo diferente conflita', async () => {
    const f = await ready();
    await Promise.all([f.carts.createCart(ORG_A, f.intent), f.carts.createCart(ORG_A, f.intent)]);
    expect(f.fake.call.mock.calls.filter((c) => c[1] === 'createCart')).toHaveLength(1);
    await expect(f.carts.createCart(ORG_A, { ...f.intent, items: [{ ...f.item, quantity: 2 }] })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });
  it('adiciona, atualiza e remove usando cartItemId de getCart; retry não duplica', async () => {
    const f = await ready();
    const addId = randomUUID();
    await f.carts.changeItem(ORG_A, f.linkId, f.cart.cartRef, addId, f.item);
    await f.carts.changeItem(ORG_A, f.linkId, f.cart.cartRef, addId, f.item);
    expect(f.fake.call.mock.calls.filter((c) => c[1] === 'addItemToCart')).toHaveLength(1);
    const cart = await f.carts.getCart(ORG_A, f.linkId, f.cart.cartRef);
    const line = cart.items[0]!.cartItemId;
    const updated = await f.carts.changeItem(ORG_A, f.linkId, f.cart.cartRef, randomUUID(), { ...f.item, quantity: 2 }, line);
    expect(updated.items[0]!.quantity).toBe(2);
    const removeId = randomUUID();
    await f.carts.removeItemFromCart(ORG_A, f.linkId, f.cart.cartRef, removeId, line);
    await f.carts.removeItemFromCart(ORG_A, f.linkId, f.cart.cartRef, removeId, line);
    expect(f.fake.call.mock.calls.filter((c) => c[1] === 'removeItemFromCart')).toHaveLength(1);
    await expect(f.carts.removeItemFromCart(ORG_A, f.linkId, f.cart.cartRef, randomUUID(), randomUUID())).rejects.toMatchObject({ code: 'CART_ITEM_NOT_FOUND' });
  });
  it.each([
    { options: [] },
    { options: [{ optionId: '99999999-9999-4999-8999-999999999999', quantity: 1 as const }] },
    { options: [{ optionId: OPTION_ID, quantity: 1 as const }, { optionId: OPTION_ID, quantity: 1 as const }] },
  ])('bloqueia configuração inválida antes de escrever: %j', async (override) => {
    const f = await ready();
    const writes = f.fake.call.mock.calls.length;
    await expect(f.carts.createCart(ORG_A, { ...f.intent, requestId: randomUUID(), items: [{ ...f.item, ...override }] })).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' });
    expect(f.fake.call.mock.calls).toHaveLength(writes);
  });
  it('não aceita itemRef inventado ou endereço não retornado pelo MCP', async () => {
    const f = await ready();
    await expect(f.carts.createCart(ORG_A, { ...f.intent, requestId: randomUUID(), items: [chosenItem('inventado-xxxxxxxxxxxx')] })).rejects.toMatchObject({ code: 'ITEM_NOT_FOUND' });
    await expect(f.carts.catalog(ORG_A, { linkId: f.linkId, addressId: randomUUID(), query: 'lanche' })).rejects.toMatchObject({ code: 'INVALID_ADDRESS' });
  });
  it('isola referências e carrinhos entre organizadores e sessões', async () => {
    const f = await ready();
    const b = await connectAndConfirm(f.env, ORG_B), linkB = b.status.linkId!;
    await expect(f.carts.getCart(ORG_B, linkB, f.cart.cartRef)).rejects.toMatchObject({ code: 'CART_NOT_FOUND' });
    await expect(f.carts.createCart(ORG_B, { ...f.intent, linkId: linkB, requestId: randomUUID() })).rejects.toMatchObject({ code: 'ITEM_NOT_FOUND' });
    const cat = await f.carts.catalog(ORG_B, { linkId: linkB, addressId: ADDRESS_ID, query: 'lanche' });
    await f.carts.createCart(ORG_B, { linkId: linkB, requestId: randomUUID(), items: [chosenItem(cat.items[0]!.itemRef)] });
    const tokens = f.fake.call.mock.calls.filter((c) => c[1] === 'createCart').map((c) => c[0]);
    expect(new Set(tokens).size).toBe(2);
  });
  it('bloqueia vínculo desconectado, trocado ou login ainda não confirmado', async () => {
    const f = await ready();
    await f.env.links.disconnect(ORG_A);
    await expect(f.carts.getCart(ORG_A, f.linkId, f.cart.cartRef)).rejects.toMatchObject({ code: 'IFOOD_LINK_REQUIRED' });
    await authorize(f.env, ORG_A);
    await expect(f.carts.getCart(ORG_A, f.linkId, f.cart.cartRef)).rejects.toMatchObject({ code: 'IFOOD_LINK_REQUIRED' });
    const linked = await connectAndConfirm(f.env, ORG_A);
    await expect(f.carts.getCart(ORG_A, f.linkId, f.cart.cartRef)).rejects.toMatchObject({ code: 'CART_LINK_CHANGED' });
    await expect(f.carts.getCart(ORG_A, linked.status.linkId!, f.cart.cartRef)).rejects.toMatchObject({ code: 'CART_NOT_FOUND' });
  });
  it('consulta e revalida entrega, pagamento e cupom; não expõe nem retém token de cartão', async () => {
    const f = await ready();
    for (const kind of ['delivery', 'payment', 'voucher'] as const) {
      const choices = await f.carts.listChoices(ORG_A, f.linkId, f.cart.cartRef, kind);
      expect(JSON.stringify(choices)).not.toContain(CARD_TOKEN);
      const req = randomUUID();
      const selected = await f.carts.selectChoice(ORG_A, f.linkId, f.cart.cartRef, req, kind, choices.choices[0]!.choiceRef);
      await f.carts.selectChoice(ORG_A, f.linkId, f.cart.cartRef, req, kind, choices.choices[0]!.choiceRef);
      expect(JSON.stringify(selected)).not.toContain(CARD_TOKEN);
    }
    expect((await f.carts.getCart(ORG_A, f.linkId, f.cart.cartRef)).vouchers).toHaveLength(1);
    expect((await f.carts.removeVoucher(ORG_A, f.linkId, f.cart.cartRef, randomUUID())).vouchers).toHaveLength(0);
    const paymentCall = f.fake.call.mock.calls.find((c) => c[1] === 'setCartPayment');
    expect(paymentCall![2].cardTokenId).toBe(CARD_TOKEN); // existe somente no argumento transitório enviado ao MCP falso
    expect(JSON.stringify(f.carts)).not.toContain(CARD_TOKEN);
  });
  it('rejeita seleção inventada, vencida ou removida pelo provedor', async () => {
    const f = await ready();
    await expect(f.carts.selectChoice(ORG_A, f.linkId, f.cart.cartRef, randomUUID(), 'delivery', 'inventado-xxxxxxxxxxxx')).rejects.toMatchObject({ code: 'CHOICE_EXPIRED' });
    const choices = await f.carts.listChoices(ORG_A, f.linkId, f.cart.cartRef, 'payment');
    f.fake.paymentAvailable = false;
    await expect(f.carts.selectChoice(ORG_A, f.linkId, f.cart.cartRef, randomUUID(), 'payment', choices.choices[0]!.choiceRef)).rejects.toMatchObject({ code: 'CHOICE_CHANGED' });
    f.env.clock.advance(5 * 60_000 + 1);
    await expect(f.carts.selectChoice(ORG_A, f.linkId, f.cart.cartRef, randomUUID(), 'payment', choices.choices[0]!.choiceRef)).rejects.toMatchObject({ code: 'CHOICE_EXPIRED' });
  });
  it('invalida revisão por mutação, alteração externa de total, entrega, pagamento ou itens', async () => {
    const f = await ready();
    const review = await complete(f);
    expect(review.review).not.toBeNull();
    await f.carts.changeItem(ORG_A, f.linkId, f.cart.cartRef, randomUUID(), f.item);
    expect((await f.carts.getCart(ORG_A, f.linkId, f.cart.cartRef)).review).toBeNull();
    for (const mutate of [
      (s: { totals?: { total: number; subtotal: number } }) => { s.totals!.total++; s.totals!.subtotal++; },
      (s: { deliveryMethod?: unknown }) => { s.deliveryMethod = { deliveryMethodId: 'PICKUP' }; },
      (s: { paymentMethod?: unknown }) => { s.paymentMethod = { paymentMethodId: PAYMENT_ID.replace(/^5/, '9') }; },
      (s: { items: { quantity: number }[] }) => { s.items[0]!.quantity++; },
    ]) {
      await f.carts.review(ORG_A, f.linkId, f.cart.cartRef);
      mutate([...f.fake.snapshots.values()][0]!.snapshot);
      expect((await f.carts.getCart(ORG_A, f.linkId, f.cart.cartRef)).review).toBeNull();
    }
  });
  it('totais ausentes ou divergentes bloqueiam revisão; nenhum preço é estimado', async () => {
    const f = await ready();
    await complete(f);
    const s = [...f.fake.snapshots.values()][0]!.snapshot;
    s.totals!.total = 1;
    expect((await f.carts.getCart(ORG_A, f.linkId, f.cart.cartRef)).totals.status).toBe('DIVERGENT');
    await expect(f.carts.review(ORG_A, f.linkId, f.cart.cartRef)).rejects.toMatchObject({ code: 'CART_NOT_REVIEWABLE' });
    delete s.totals;
    expect((await f.carts.getCart(ORG_A, f.linkId, f.cart.cartRef)).totals.values).toBeNull();
    await expect(f.carts.review(ORG_A, f.linkId, f.cart.cartRef)).rejects.toMatchObject({ code: 'CART_NOT_REVIEWABLE' });
    expect(() => parseSnapshot({ cartId: randomUUID(), totals: { total: 3 } })).toThrow(/não reconhecida/);
    expect(() => parseSnapshot({ ...s, totals: { subtotal: -1 } })).toThrow(/não reconhecida/);
    expect(confirmedTotals(s).status).toBe('UNAVAILABLE');
  });
  it('timeout de criação bloqueia retries mesmo com outro requestId', async () => {
    const f = await ready();
    f.fake.fail = 'createCart';
    const input = { ...f.intent, requestId: randomUUID() };
    await expect(f.carts.createCart(ORG_A, input)).rejects.toMatchObject({ code: 'RESULT_UNKNOWN' });
    f.fake.fail = null;
    await expect(f.carts.createCart(ORG_A, input)).rejects.toMatchObject({ code: 'RESULT_UNKNOWN' });
    await expect(f.carts.createCart(ORG_A, { ...input, requestId: randomUUID() })).rejects.toMatchObject({ code: 'RESULT_UNKNOWN' });
    expect(f.fake.call.mock.calls.filter((c) => c[1] === 'createCart')).toHaveLength(2); // primeira criação + tentativa com timeout
  });
  it('timeout de adição bloqueia toda nova mutação, sem limpar desconhecido por getCart', async () => {
    const f = await ready();
    f.fake.fail = 'addItemToCart';
    await expect(f.carts.changeItem(ORG_A, f.linkId, f.cart.cartRef, randomUUID(), f.item)).rejects.toMatchObject({ code: 'RESULT_UNKNOWN' });
    f.fake.fail = null;
    expect((await f.carts.getCart(ORG_A, f.linkId, f.cart.cartRef)).state).toBe('RESULT_UNKNOWN');
    await expect(f.carts.changeItem(ORG_A, f.linkId, f.cart.cartRef, randomUUID(), f.item)).rejects.toMatchObject({ code: 'RESULT_UNKNOWN' });
    expect(f.fake.call.mock.calls.filter((c) => c[1] === 'addItemToCart')).toHaveLength(1);
  });
  it('detecta desconexão durante chamada sem devolver carrinho válido', async () => {
    const f = await ready();
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((r) => { entered = r; }), blocked = new Promise<void>((r) => { release = r; });
    f.fake.hook = async (tool) => { if (tool === 'getCart') { entered(); await blocked; } };
    const pending = f.carts.getCart(ORG_A, f.linkId, f.cart.cartRef);
    await started;
    await f.env.links.disconnect(ORG_A);
    release();
    await expect(pending).rejects.toMatchObject({ code: 'CART_LINK_CHANGED' });
  });
  it('sem escopo ou com feature desabilitada não escreve', async () => {
    const f = await ready();
    const disabled = new CartService(f.env.links);
    await expect(disabled.getCart(ORG_A, f.linkId, f.cart.cartRef)).rejects.toMatchObject({ code: 'CART_FEATURE_DISABLED' });
    const noScope = cartSetup(); noScope.env.as.scope = 'mcp.user.addresses.read';
    const linked = await connectAndConfirm(noScope.env, ORG_A);
    await expect(noScope.carts.createCart(ORG_A, { ...f.intent, linkId: linked.status.linkId! })).rejects.toMatchObject({ code: 'IFOOD_SCOPE_MISSING' });
    expect(noScope.fake.call).not.toHaveBeenCalled();
  });
});

describe('contrato HTTP e preparação F7.3', () => {

  it('executa o contrato HTTP completo sem expor preços decimais ou tokens', async () => {
    const f = cartSetup();
    const linked = await connectAndConfirm(f.env, ORG_A), linkId = linked.status.linkId!;
    const catalogResponse = await f.call('POST', '/api/bot/cart/catalog', { linkId, addressId: ADDRESS_ID, query: 'lanche' });
    expect(catalogResponse.status).toBe(200);
    const catalog = await catalogResponse.json();
    expect(catalog.items[0].optionGroups[0].options[0]).toHaveProperty('additionalPriceCents', 0);
    expect(catalog.items[0].optionGroups[0].options[0]).not.toHaveProperty('additionalPrice');
    const item = chosenItem(catalog.items[0].itemRef);
    const created = await f.call('POST', '/api/bot/cart', { linkId, requestId: randomUUID(), items: [item] });
    expect(created.status).toBe(201);
    const cart = await created.json(), base = `/api/bot/cart/${cart.cartRef}`;
    expect((await f.call('GET', `${base}?linkId=${linkId}`)).status).toBe(200);
    expect((await f.call('POST', `${base}/items`, { linkId, requestId: randomUUID(), item })).status).toBe(200);
    expect((await f.call('PUT', `${base}/items/${cart.items[0].cartItemId}`, { linkId, requestId: randomUUID(), item: { ...item, quantity: 2 } })).status).toBe(200);
    for (const kind of ['delivery', 'payment', 'voucher']) {
      const response = await f.call('GET', `${base}/${kind}?linkId=${linkId}`);
      expect(response.status).toBe(200);
      const listing = await response.json();
      expect(JSON.stringify(listing)).not.toContain(CARD_TOKEN);
      expect((await f.call('PUT', `${base}/${kind}`, { linkId, requestId: randomUUID(), choiceRef: listing.choices[0].choiceRef })).status).toBe(200);
    }
    expect((await f.call('DELETE', `${base}/voucher`, { linkId, requestId: randomUUID() })).status).toBe(200);
    const reviewed = await f.call('POST', `${base}/review`, { linkId });
    expect(reviewed.status).toBe(200);
    expect((await reviewed.json()).approvalEnabled).toBe(false);
    expect((await f.call('DELETE', `${base}/items/${cart.items[0].cartItemId}`, { linkId, requestId: randomUUID() })).status).toBe(200);
  });
  it('não repete mutação confirmada se a leitura subsequente falhar', async () => {
    const f = await ready();
    const requestId = randomUUID();
    f.fake.hook = async (tool) => { if (tool === 'addItemToCart') f.fake.fail = 'getCart'; };
    await expect(f.carts.addItemToCart(ORG_A, f.linkId, f.cart.cartRef, requestId, f.item)).rejects.toBeDefined();
    f.fake.hook = null; f.fake.fail = null;
    await f.carts.addItemToCart(ORG_A, f.linkId, f.cart.cartRef, requestId, f.item);
    expect(f.fake.call.mock.calls.filter((c) => c[1] === 'addItemToCart')).toHaveLength(1);
  });

  it('exige autenticação do bot e rejeita identidade/preços/consentimento forjados', async () => {
    const f = await ready();
    expect((await f.call('POST', '/api/bot/cart', f.intent, ORG_A, 'inválido')).status).toBe(401);
    for (const extra of [{ organizerId: ORG_B }, { merchantId: randomUUID() }, { totalCents: 1 }, { userConsent: true }]) {
      const r = await f.call('POST', '/api/bot/cart', { ...f.intent, ...extra });
      expect(r.status).toBe(400);
    }
    for (const quantity of [0, -1, 1.5, 21]) expect((await f.call('POST', '/api/bot/cart', { ...f.intent,
      items: [{ ...f.item, quantity }] })).status).toBe(400);
    expect((await f.call('POST', '/api/bot/cart', { ...f.intent, items: [{ ...f.item, variantId: randomUUID() }] })).status).toBe(400);
  });
  it('contrato HTTP oferece revisão, mas bloqueia aprovação e envio sem chamar tool de pedido', async () => {
    const f = await ready();
    const review = await complete(f);
    const calls = f.fake.call.mock.calls.length;
    for (const action of ['approve', 'submit']) {
      const r = await f.call('POST', `/api/bot/cart/${f.cart.cartRef}/${action}`, { linkId: f.linkId, reviewId: review.review!.reviewId });
      expect(r.status).toBe(409);
      expect((await r.json()).error.kind).toBe('CHECKOUT_DISABLED');
    }
    expect(f.fake.call.mock.calls).toHaveLength(calls);
    const mockSubmitOrder = vi.fn();
    // Simulação de regra do adaptador Telegram: approvalEnabled=false nunca aciona submissão.
    if (review.approvalEnabled) mockSubmitOrder({ userConsent: true });
    expect(mockSubmitOrder).not.toHaveBeenCalled();
  });
  it('gateway recusa submitOrder mesmo se forçado em runtime, sem obter cliente', async () => {
    const client = vi.fn();
    // eslint-disable-next-line no-restricted-syntax
    await expect(cartGateway(client).call('submitOrder' as never, {})).rejects.toThrow(/fora do escopo/);
    expect(client).not.toHaveBeenCalled();
  });
});
