// INT-01: regressões adversariais com respostas SINTÉTICAS, nunca capturas de pedidos reais.
import { randomUUID } from 'node:crypto';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { describe, expect, it, vi } from 'vitest';
import { cartGateway } from '../../src/server/mcp/cart';
import { WRITES, parseSnapshot } from '../../src/server/cart/contracts';
import { callReadTool } from '../../src/server/mcp/tools';
import { loadConfig } from '../../src/server/config';
import { ORG_A, connectAndConfirm } from '../helpers/fakes';
import { ADDRESS_ID, cartSetup, chosenItem } from './fakes';

async function ready() {
  const f = cartSetup();
  const link = await connectAndConfirm(f.env, ORG_A);
  const linkId = link.status.linkId!;
  const catalog = await f.carts.catalog(ORG_A, { linkId, addressId: ADDRESS_ID, query: 'lanche' });
  const item = chosenItem(catalog.items[0]!.itemRef);
  const input = { linkId, requestId: randomUUID(), items: [item] };
  const cart = await f.carts.createCart(ORG_A, input);
  return { ...f, linkId, item, input, cart };
}

describe('INT-01 integrada à main: fronteira de leitura da DEC-01', () => {
  it('configuração padrão e rota F7 desativada não iniciam criação remota', async () => {
    expect(loadConfig({}).cartEnabled).toBe(false);
    const f = cartSetup(false);
    const response = await f.call('POST', '/api/bot/cart', {
      linkId: 'synthetic-link-reference', requestId: randomUUID(),
      items: [chosenItem('synthetic-item-reference')],
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { kind: 'CART_CONFIRMATION_REQUIRED' }, purchaseAuthorized: false });
    expect(f.fake.call).not.toHaveBeenCalled();
  });

  it('pipeline de leitura rejeita todas as mutações F7 e envio antes de obter resposta do MCP', async () => {
    const callTool = vi.fn();
    const client = { callTool } as unknown as Client;
    // eslint-disable-next-line no-restricted-syntax -- Nome adversarial: verificar rejeição, nunca executar envio.
    for (const tool of [...WRITES, 'submitOrder']) {
      await expect(callReadTool(tool, {}, client)).rejects.toThrow(/não permitida/);
    }
    expect(callTool).not.toHaveBeenCalled();
  });
});

describe('INT-01: saída desconhecida não confirma escrita', () => {
  it.each([undefined, null, {}, 'OK', { queued: true }, { success: 'true' },
    { success: true, error: { code: 'FAILED' } }, { success: true, data: { error: { code: 'FAILED' } } },
  ])('gateway bloqueia confirmação não reconhecida %j', async (raw) => {
    const callTool = vi.fn().mockResolvedValue({ structuredContent: raw });
    const gateway = cartGateway(async () => ({ callTool }) as unknown as Client);
    await expect(gateway.writeConfirmed!('addItemToCart', {})).rejects.toBeDefined();
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it.each(['addItemToCart', 'updateCartItem', 'removeItemFromCart'] as const)('%s: resposta malformada após efeito bloqueia reenvio com a mesma ou outra chave', async (tool) => {
    const f = await ready();
    const original = f.fake.call.getMockImplementation()!;
    const cartItemId = f.cart.items[0]!.cartItemId;
    const write = (requestId: string) => tool === 'addItemToCart'
      ? f.carts.addItemToCart(ORG_A, f.linkId, f.cart.cartRef, requestId, f.item)
      : tool === 'updateCartItem'
        ? f.carts.updateCartItem(ORG_A, f.linkId, f.cart.cartRef, requestId, cartItemId, { ...f.item, quantity: 2 })
        : f.carts.removeItemFromCart(ORG_A, f.linkId, f.cart.cartRef, requestId, cartItemId);
    f.fake.call.mockImplementation(async (token, name, args) => {
      const result = await original(token, name, args);
      return name === tool ? { queued: true } : result;
    });
    const requestId = randomUUID();
    await expect(write(requestId)).rejects.toMatchObject({ code: 'RESULT_UNKNOWN' });
    expect((await f.carts.getCart(ORG_A, f.linkId, f.cart.cartRef)).state).toBe('RESULT_UNKNOWN');
    // A presença/ausência da linha em getCart não prova que uma escrita tardia terminou.
    for (const id of [requestId, randomUUID()]) {
      await expect(write(id)).rejects.toMatchObject({ code: 'RESULT_UNKNOWN' });
    }
    expect(f.fake.call.mock.calls.filter((c) => c[1] === tool)).toHaveLength(1);
  });

  it('erro dentro de data não pode ser descartado por projeção de getCart', async () => {
    const f = await ready();
    const snapshot = [...f.fake.snapshots.values()][0]!.snapshot;
    expect(() => parseSnapshot({ success: false, data: snapshot })).toThrow();
    expect(() => parseSnapshot({ success: 'true', data: snapshot })).toThrow();
    expect(() => parseSnapshot({ success: null, data: snapshot })).toThrow();
    expect(() => parseSnapshot({ data: { ...snapshot, error: { code: 'FAILED' } } })).toThrow();
  });

  it('criação sem cartId continua desconhecida e bloqueia nova criação', async () => {
    const f = await ready();
    const original = f.fake.call.getMockImplementation()!;
    f.fake.call.mockImplementation(async (token, tool, args) => {
      const result = await original(token, tool, args);
      return tool === 'createCart' ? { success: true } : result;
    });
    const input = { ...f.input, requestId: randomUUID() };
    await expect(f.carts.createCart(ORG_A, input)).rejects.toMatchObject({ code: 'RESULT_UNKNOWN' });
    await expect(f.carts.createCart(ORG_A, input)).rejects.toMatchObject({ code: 'RESULT_UNKNOWN' });
    await expect(f.carts.createCart(ORG_A, { ...input, requestId: randomUUID() })).rejects.toMatchObject({ code: 'RESULT_UNKNOWN' });
    expect(f.fake.call.mock.calls.filter((c) => c[1] === 'createCart')).toHaveLength(2); // primeira conhecida + uma sem resposta confiável
  });
});
