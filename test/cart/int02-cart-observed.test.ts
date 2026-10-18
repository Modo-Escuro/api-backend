// INT-02: respostas REAIS de carrinho (conta de teste, 18/10/2026). Ver fixtures/int02/cart-evidence.json.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { assertMutationConfirmation, confirmedTotals, parseCreatedCart, parseSnapshot, type CartGateway } from '../../src/server/cart/contracts';
import { ObservedCartContract } from '../../src/server/cart/write-contract';
import { parseToolResult, type RawToolResult } from '../../src/server/mcp/tools';
import { McpToolError } from '../../src/server/mcp/errors';

const path = (n: string) => fileURLToPath(new URL(`../../fixtures/int02/${n}`, import.meta.url));
const cart = (n: string) => JSON.parse(readFileSync(path(`cart/${n}`), 'utf8'));
const CART_ID = 'b82b35b3-4660-4aad-805a-dfcab8995d30';
const LINE = 'e94e3fc8-1bb8-49b2-a88f-2c7cc61b46f5';

describe('INT-02 carrinho observado', () => {
  it('createCart devolve o carrinho completo; cartId reconhecido e totais coerentes antes da promoção', () => {
    const raw = cart('createCart.json');
    expect(parseCreatedCart(raw)).toEqual({ cartId: CART_ID });
    const s = parseSnapshot(raw);
    expect(s).toMatchObject({ merchantId: '5d4b6c90-460a-4f1b-ab7d-2dd92cf16485',
      deliveryAddress: { street: 'Rua Doutor Carlos de Camargo Salles', number: '400', neighborhood: 'Cidade Universitária' } });
    expect(s.addressId).toBeUndefined();
    expect(s.items).toEqual([{ cartItemId: LINE, itemId: '61da1f8c-b492-4ab3-befd-5c5fe8a51724', quantity: 1, options: [], unitPrice: 799 }]);
    expect(confirmedTotals(s)).toEqual({ status: 'CONSISTENT', values: { subtotalCents: 799, deliveryFeeCents: 0, serviceFeeCents: 99, discountCents: 0, totalCents: 898 } });
    expect(s.totals!.benefits).toBe(499);
  });

  it('getCart com promoção aplicada: total do provedor não fecha com os componentes ⇒ PROVIDER_REPORTED, nunca CONSISTENT', () => {
    const s = parseSnapshot(cart('getCart-after-create.json'));
    expect(s.totals).toMatchObject({ subtotal: 799, serviceFee: 99, total: 499 });
    expect(s.totals!.benefits).toBe(898); // mistura promoção do item com entrega grátis já refletida na taxa
    expect(confirmedTotals(s).status).toBe('PROVIDER_REPORTED'); // informado, nunca confirmado
    expect(confirmedTotals({ ...s, totals: { ...s.totals!, benefits: 0 } }).status).toBe('DIVERGENT');
    expect(confirmedTotals({ ...s, totals: { ...s.totals!, total: 99_999 } }).status).toBe('DIVERGENT');
  });

  it('mutações devolvem o carrinho completo e são aceitas como confirmação estrutural', () => {
    for (const n of ['addItemToCart.json', 'updateCartItem.json', 'removeItemFromCart.json']) expect(() => assertMutationConfirmation(cart(n))).not.toThrow();
    const add = parseSnapshot(cart('addItemToCart.json'));
    expect(add.items).toHaveLength(2); // mesmo item adicionado de novo vira OUTRA linha
    expect(new Set(add.items.map(i => i.itemId)).size).toBe(1);
    const upd = parseSnapshot(cart('updateCartItem.json'));
    expect(upd.items.find(i => i.cartItemId === LINE)?.quantity).toBe(2); // cartItemId estável no update
    const rem = parseSnapshot(cart('removeItemFromCart.json'));
    expect(rem.items.map(i => i.cartItemId)).not.toContain(LINE);
    expect(cart('removeItemFromCart.json')).toEqual(cart('getCart-final.json'));
  });

  it('options ausente no input é rejeitado pelo servidor apesar do schema opcional (isError=true)', () => {
    const r = cart('addItemToCart-error-options-null.json') as RawToolResult;
    expect(r.isError).toBe(true);
    expect(() => parseToolResult('addItemToCart', r)).toThrow(McpToolError);
  });

  it('formato inesperado não vira confirmação: chave desconhecida em item, taxa divergente, pagamento presente', () => {
    const base = cart('getCart-final.json');
    expect(() => parseSnapshot({ ...base, items: [{ ...base.items[0], customizations: [{}] }] })).toThrow();
    expect(() => parseSnapshot({ ...base, summary: { ...base.summary, feeTotalAmount: 1.5 } })).toThrow();
    expect(() => parseSnapshot({ ...base, paymentMethod: { paymentMethodId: 'x' } })).toThrow();
    expect(() => assertMutationConfirmation({ ...base, deliveryAddress: undefined })).toThrow();
  });

  it('manifesto v1 com amostras reais abre o gate quando os schemas anunciados coincidem', async () => {
    const tools = JSON.parse(readFileSync(fileURLToPath(new URL('../../fixtures/tools-list.json', import.meta.url)), 'utf8'));
    const gateway: CartGateway = { call: async () => ({}), describe: async () => tools, writeConfirmed: async () => ({}) };
    const gate = new ObservedCartContract(path('cart-evidence.json'));
    await expect(gate.verify(gateway, ['createCart', 'addItemToCart', 'updateCartItem', 'removeItemFromCart'])).resolves.toBeUndefined();
    await expect(gate.verify(gateway, ['createCart'], [{ tool: 'createCart', args: { items: 'x' } } as never])).rejects.toMatchObject({ code: 'CART_CONTRACT_UNVERIFIED' });
  });
});
