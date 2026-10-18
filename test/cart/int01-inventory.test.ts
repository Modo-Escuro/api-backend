import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { auditCartCapture } from '../../src/server/cart/contract-audit';
import { parseList, deliveryList, paymentList, voucherList, parseSnapshot, confirmedTotals, parseCreatedCart, assertMutationConfirmation } from '../../src/server/cart/contracts';
import { ADDRESS_ID, CARD_TOKEN, ITEM_ID, MERCHANT_ID, PAYMENT_ID } from './fakes';

const capture = () => readFileSync('fixtures/tools-list.json', 'utf8');
describe('INT-01: proveniência da descoberta e lacunas do contrato', () => {
  it('relatório é derivado da captura e não declara observação de saída', () => {
    const report = auditCartCapture(capture());
    expect(JSON.parse(readFileSync('docs/int-01-tools-audit.json', 'utf8'))).toEqual(report);
    expect(report.tools).toHaveLength(15);
    expect(report.tools.every((t) => !t.outputSchemaPresent && t.outputEvidence === 'NOT_CAPTURED')).toBe(true);
    expect(report.tools.every((t) => t.idempotencyInputFields.length === 0)).toBe(true);
    expect(report.reconciliation).toMatchObject({ orderLookupWithoutOrderId: false, cartLookupWithoutCartId: false });
  });
  it('não transforma texto de descrição ou annotations em garantia de idempotência/segurança', () => {
    const report = auditCartCapture(capture());
    expect(report.tools.every((t) => t.annotations?.idempotentHint === false)).toBe(true);
    expect(report.tools.find((t) => t.name === 'getCart')!.annotations?.readOnlyHint).toBe(false);
    expect(report.checkoutEnabled).toBe(false);
    expect(report.reconciliation.guarantee).toBe('NOT_ESTABLISHED_BY_THIS_CAPTURE');
  });
  it('consulta de pedido depende de ID conhecido, e envio não pertence ao gateway F7', () => {
    const report = auditCartCapture(capture());
    expect(report.tools.filter((t) => /^(getOrder|trackOrder)$/.test(t.name)).every((t) => t.inputRequired.includes('orderId'))).toBe(true);
    expect(report.tools.find((t) => /^submitOrder$/.test(t.name))!.f7GatewayAllowed).toBe(false);
  });
  it('distingue required formal da política conservadora da aplicação', () => {
    const report = auditCartCapture(capture());
    expect(report.tools.find((t) => t.name === 'createCart')!.inputRequired).toEqual([]);
    expect(report.tools.find((t) => t.name === 'addItemToCart')!.inputRequired).not.toContain('options');
    expect(report.tools.find((t) => t.name === 'updateCartItem')!.inputRequired).not.toContain('options');
  });
});

describe('INT-01: parsers provisórios (somente formatos sintéticos)', () => {
  it.each([undefined, null, {}, { total: 20 }, { data: { price: 20 } }])('getCart desconhecido %j bloqueia', (raw) => {
    expect(() => parseSnapshot(raw)).toThrow();
  });
  it('totais ausentes não viram zero e precisão/unidade desconhecida não é inferida', () => {
    const raw = { cartId: MERCHANT_ID, merchantId: MERCHANT_ID, addressId: ADDRESS_ID, items: [] };
    expect(confirmedTotals(parseSnapshot(raw))).toEqual({ status: 'UNAVAILABLE', values: null });
    for (const bad of [null, { subtotal: 20 }, { subtotal: 20.001, deliveryFee: 1, serviceFee: 0, discount: 0, total: 21.001 }]) {
      expect(() => parseSnapshot({ ...raw, totals: bad })).toThrow();
    }
  });
  it('listas não reconhecidas e ID de pagamento que contradiz UUID não são ampliados por adivinhação', () => {
    expect(() => parseList(deliveryList, { methods: [] })).toThrow();
    expect(() => parseList(paymentList, { paymentMethods: [{ paymentMethodId: 'PIX', type: 'PIX' }] })).toThrow();
    expect(() => parseList(voucherList, { vouchers: [{ code: 'TEST' }] })).toThrow();
    expect(parseList(paymentList, { paymentMethods: [{ paymentMethodId: PAYMENT_ID, cardTokenId: CARD_TOKEN }] }).paymentMethods).toHaveLength(1);
  });
  it('create requer cartId, itemId sozinho não o substitui; acknowledgments permanecem hipóteses', () => {
    expect(() => parseCreatedCart({ itemId: ITEM_ID })).toThrow();
    expect(parseCreatedCart({ data: { cartId: MERCHANT_ID } })).toEqual({ cartId: MERCHANT_ID });
    expect(() => assertMutationConfirmation({ data: { success: true } })).not.toThrow();
    expect(() => assertMutationConfirmation({ success: true, queued: true })).toThrow();
  });
});
