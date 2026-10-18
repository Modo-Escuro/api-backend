// Entradas derivadas de fixtures/tools-list.json. Saídas: adaptador conservador, ainda
// sem captura autenticada de cart; formatos não reconhecidos nunca viram preço confirmado.
import { z } from 'zod';

export class CartError extends Error {
  constructor(readonly code: string, message: string, readonly status: 400 | 403 | 404 | 409 | 410 | 502 | 503 = 409,
    readonly providerCode?: string) { super(message); }
}
export const id = z.uuid();
export const ref = z.string().min(16).max(100);
export const option = z.object({ optionId: id, quantity: z.literal(1) }).strict();
export const searchList = z.object({ results: z.array(z.object({ itemId: id, merchant: z.object({ merchantId: id }) })) });
export const itemDetail = z.object({ itemId: id, merchantId: id, itemName: z.string().optional(), merchantName: z.string().optional(),
  optionGroups: z.array(z.object({ optionGroupId: id, name: z.string().optional(), minSelections: z.number().int().nonnegative().optional(),
    maxSelections: z.number().int().nonnegative().optional(), options: z.array(z.object({ optionId: id, name: z.string().optional(),
      additionalPrice: z.number().finite().nonnegative().optional() })) })).optional() });
export const itemInput = z.object({ itemRef: ref, quantity: z.number().int().min(1).max(20),
  options: z.array(option).max(50), customerNote: z.string().max(500).optional() }).strict();
const selectedOption = z.object({ optionId: id, quantity: z.number().int().positive() });
const cartItem = z.object({ cartItemId: id, itemId: id, quantity: z.number().int().positive(),
  options: z.array(selectedOption), customerNote: z.string().optional() });
const money = z.number().finite().nonnegative().refine((n) => Number.isSafeInteger(Math.round(n * 100)) && Math.abs(n * 100 - Math.round(n * 100)) < 0.000001);
const totals = z.object({ subtotal: money, deliveryFee: money, serviceFee: money, discount: money, total: money });
const snapshotSchema = z.object({ cartId: id, merchantId: id, addressId: id, items: z.array(cartItem),
  totals: totals.optional(),
  deliveryMethod: z.object({ deliveryMethodId: z.string().min(1), selectedTimeSlotId: id.nullable().optional() }).nullable().optional(),
  // Projeção: nunca guarda cardTokenId, PAN, documento ou dados brutos de pagamento.
  paymentMethod: z.object({ paymentMethodId: id }).nullable().optional(),
  vouchers: z.array(z.object({ code: z.string(), campaignId: id })).optional() });
export type Snapshot = z.infer<typeof snapshotSchema>;
export type ItemInput = z.infer<typeof itemInput>;
export type CartTool = 'createCart' | 'getCart' | 'addItemToCart' | 'updateCartItem' | 'removeItemFromCart'
  | 'getCartDeliveryMethods' | 'setCartDelivery' | 'listPaymentMethods' | 'setCartPayment' | 'listVouchers' | 'setVoucher' | 'removeVoucher';
export interface CartGateway { call(tool: CartTool, args: Record<string, unknown>): Promise<unknown> }
export const WRITES: ReadonlySet<string> = new Set(['createCart', 'addItemToCart', 'updateCartItem', 'removeItemFromCart',
  'setCartDelivery', 'setCartPayment', 'setVoucher', 'removeVoucher']);

export function payload(raw: unknown): unknown {
  if (raw && typeof raw === 'object' && 'data' in raw) return (raw as { data: unknown }).data;
  return raw;
}
export function parseSnapshot(raw: unknown): Snapshot {
  const result = snapshotSchema.safeParse(payload(raw));
  if (!result.success) throw new CartError('CART_CONTRACT_UNVERIFIED', 'Resposta de getCart não reconhecida; é necessária uma captura sanitizada do contrato real.', 502);
  const s = result.data;
  if (new Set(s.items.map((i) => i.cartItemId)).size !== s.items.length) throw new CartError('CART_CONTRACT_UNVERIFIED', 'Itens duplicados na resposta de getCart.', 502);
  return s;
}
export function confirmedTotals(s: Snapshot) {
  const t = s.totals;
  if (!t) return { status: 'UNAVAILABLE' as const, values: null };
  const values = { subtotalCents: Math.round(t.subtotal * 100), deliveryFeeCents: Math.round(t.deliveryFee * 100),
    serviceFeeCents: Math.round(t.serviceFee * 100), discountCents: Math.round(t.discount * 100), totalCents: Math.round(t.total * 100) };
  const expected = BigInt(values.subtotalCents) + BigInt(values.deliveryFeeCents) + BigInt(values.serviceFeeCents) - BigInt(values.discountCents);
  return { status: expected >= 0n && expected === BigInt(values.totalCents) ? 'CONSISTENT' as const : 'DIVERGENT' as const, values };
}
export const deliveryList = z.object({ deliveryMethods: z.array(z.object({ deliveryMethodId: z.string().min(1),
  timeSlots: z.array(z.object({ timeSlotId: id })).optional() })) });
export const paymentList = z.object({ paymentMethods: z.array(z.object({ paymentMethodId: id,
  cardTokenId: id.nullable().optional(), type: z.string().optional() })) });
export const voucherList = z.object({ vouchers: z.array(z.object({ campaignId: id, code: z.string().min(1) })) });
export function parseList<T>(schema: z.ZodType<T>, raw: unknown): T {
  const r = schema.safeParse(payload(raw));
  if (!r.success) throw new CartError('CART_CONTRACT_UNVERIFIED', 'Lista retornada pelo MCP não reconhecida; nenhuma seleção foi aplicada.', 502);
  return r.data;
}

/** A captura de getItem usa optionGroups. Não interpretar variantes/customizações de formato desconhecido. */
export function parseItem(raw: unknown) {
  const inspect = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(inspect); return; }
    for (const [key, entry] of Object.entries(value)) {
      if (['variants', 'customizations'].includes(key) && !(Array.isArray(entry) && entry.length === 0))
        throw new CartError('UNSUPPORTED_CONFIGURATION', 'Variantes ou customizações fora do contrato observado precisam de validação antes de adicionar.', 400);
      inspect(entry);
    }
  };
  inspect(payload(raw));
  return parseList(itemDetail, raw);
}
