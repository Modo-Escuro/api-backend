// INT-02 offline: hipóteses SINTÉTICAS do adaptador F7, não outputs observados do iFood.
import { describe, expect, it } from 'vitest';
import { assertMutationConfirmation, confirmedTotals, parseCreatedCart, parseSnapshot } from '../../src/server/cart/contracts';
import { ADDRESS_ID, ITEM_ID, MERCHANT_ID, OPTION_ID } from './fakes';

const CART_ID = '99999999-9999-4999-8999-999999999999';
const CART_ITEM_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const snapshot = () => ({ cartId: CART_ID, merchantId: MERCHANT_ID, addressId: ADDRESS_ID,
  items: [{ cartItemId: CART_ITEM_ID, itemId: ITEM_ID, quantity: 2, options: [{ optionId: OPTION_ID, quantity: 1 }] }],
  totals: { subtotal: 20.10, deliveryFee: 4.99, serviceFee: 0.01, discount: 1.10, total: 24 } });

describe('INT-02: identidade e composição da resposta sintética', () => {
  it.each([null, '', 'cart-id-inválido', ITEM_ID.slice(0, -1)])('createCart rejeita cartId inválido %j', (cartId) => {
    expect(() => parseCreatedCart({ cartId })).toThrow();
  });

  it('preserva IDs distintos, opções e quantidades sem inventar campos ausentes', () => {
    const raw = snapshot();
    const parsed = parseSnapshot({ data: raw });
    expect(parsed.items).toEqual(raw.items);
    expect(parsed.cartId).toBe(CART_ID);
    expect(parsed.items[0]!.cartItemId).not.toBe(parsed.items[0]!.itemId);
    expect(parsed.items[0]).not.toHaveProperty('customerNote');
    expect(parsed).not.toHaveProperty('deliveryMethod');
  });

  it.each(['cartId', 'merchantId', 'addressId', 'items'] as const)('getCart exige %s explícito', (field) => {
    const raw: Record<string, unknown> = snapshot();
    delete raw[field];
    expect(() => parseSnapshot(raw)).toThrow();
    expect(() => parseSnapshot({ ...raw, [field]: null })).toThrow();
  });

  it.each(['cartItemId', 'itemId', 'quantity', 'options'] as const)('linha exige %s; ausente não vira default', (field) => {
    const raw = snapshot();
    const item: Record<string, unknown> = { ...raw.items[0] };
    delete item[field];
    expect(() => parseSnapshot({ ...raw, items: [item] })).toThrow();
    expect(() => parseSnapshot({ ...raw, items: [{ ...item, [field]: null }] })).toThrow();
  });

  it('lista vazia explícita é diferente de itens/opções ausentes, e linhas duplicadas são rejeitadas', () => {
    const raw = snapshot();
    expect(parseSnapshot({ ...raw, items: [] }).items).toEqual([]);
    expect(parseSnapshot({ ...raw, items: [{ ...raw.items[0], options: [] }] }).items[0]!.options).toEqual([]);
    expect(() => parseSnapshot({ ...raw, items: [raw.items[0], raw.items[0]] })).toThrow(/duplicados/);
    expect(() => parseSnapshot({ ...raw, items: [{ ...raw.items[0], cartItemId: 'inválido' }] })).toThrow();
    expect(() => parseSnapshot({ ...raw, items: [{ ...raw.items[0], options: [{ quantity: 1 }] }] })).toThrow();
    expect(() => parseSnapshot({ ...raw, items: [{ ...raw.items[0], options: [{ optionId: 'inválido', quantity: 1 }] }] })).toThrow();
  });

  it.each([0, -1, 1.5, '2', null])('quantidade inválida %j não é corrigida no item nem na opção', (quantity) => {
    const raw = snapshot();
    expect(() => parseSnapshot({ ...raw, items: [{ ...raw.items[0], quantity }] })).toThrow();
    expect(() => parseSnapshot({ ...raw, items: [{ ...raw.items[0], options: [{ optionId: OPTION_ID, quantity }] }] })).toThrow();
  });
});

describe('INT-02: dinheiro na fronteira BRL hipotética → centavos DOM-01', () => {
  it('converte frações exatas uma única vez, incluindo taxas e desconto', () => {
    expect(confirmedTotals(parseSnapshot(snapshot()))).toEqual({ status: 'CONSISTENT', values: {
      subtotalCents: 2010, deliveryFeeCents: 499, serviceFeeCents: 1, discountCents: 110, totalCents: 2400,
    } });
  });

  it.each(['subtotal', 'deliveryFee', 'serviceFee', 'discount', 'total'] as const)('%s ausente ou inválido nunca vira zero', (field) => {
    const raw = snapshot();
    const totals: Record<string, unknown> = { ...raw.totals };
    delete totals[field];
    expect(() => parseSnapshot({ ...raw, totals })).toThrow();
    for (const invalid of [null, '1.00', -1, 0.001, Infinity, NaN, Number.MAX_SAFE_INTEGER]) {
      expect(() => parseSnapshot({ ...raw, totals: { ...totals, [field]: invalid } })).toThrow();
    }
  });
});

describe('INT-02: erros inline documentados não confirmam resposta sintética', () => {
  it.each([
    { error: { code: 'UPSTREAM_ERROR', message: 'Erro sintético', retryable: true } },
    { errors: [{ code: 'UPSTREAM_ERROR', message: 'Erro sintético', retryable: false }] },
  ])('rejeita erro na raiz ou em data, mesmo com IDs e success=true: %j', (error) => {
    for (const parse of [parseCreatedCart, parseSnapshot, assertMutationConfirmation]) {
      const valid = parse === assertMutationConfirmation ? { success: true } : snapshot();
      expect(() => parse({ ...valid, ...error })).toThrow();
      expect(() => parse({ success: true, ...error, data: valid })).toThrow();
      expect(() => parse({ data: { ...valid, ...error } })).toThrow();
    }
  });
});
