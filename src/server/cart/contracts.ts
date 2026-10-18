// Entradas derivadas de fixtures/tools-list.json. Saídas: adaptador conservador, ainda
// sem captura autenticada de cart; formatos não reconhecidos nunca viram preço confirmado.
import { z } from 'zod';
import { extractErrors } from '../mcp/errors.js';
import { brlToCents } from '../domain/money.js';

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
// Fronteira do adaptador legado: saídas BRL sintéticas viram centavos antes de qualquer cálculo.
const money = z.number().finite().nonnegative().refine((n) => {
  try { brlToCents(n); return true; } catch { return false; }
}).transform(brlToCents);
const cartItem = z.object({ cartItemId: id, itemId: id, quantity: z.number().int().positive(),
  options: z.array(selectedOption), customerNote: z.string().optional(), unitPrice: money.optional() });
// benefits (observado): mistura promoção de item com entrega grátis já refletida na taxa; não decomponível.
const totals = z.object({ subtotal: money, deliveryFee: money, serviceFee: money, discount: money, total: money, benefits: money.optional() });
const deliveryAddress = z.object({ street: z.string().min(1), number: z.string().min(1), neighborhood: z.string().nullable() }).strict();
const snapshotSchema = z.object({ cartId: id, merchantId: id, addressId: id.optional(), deliveryAddress: deliveryAddress.optional(),
  items: z.array(cartItem),
  totals: totals.optional(),
  deliveryMethod: z.object({ deliveryMethodId: z.string().min(1), selectedTimeSlotId: id.nullable().optional() }).nullable().optional(),
  // Projeção: nunca guarda cardTokenId, PAN, documento ou dados brutos de pagamento.
  paymentMethod: z.object({ paymentMethodId: id }).nullable().optional(),
  vouchers: z.array(z.object({ code: z.string(), campaignId: id })).optional() })
  .refine(s => s.addressId !== undefined || s.deliveryAddress !== undefined, 'endereço do carrinho ausente');
export type Snapshot = z.infer<typeof snapshotSchema>;
export type ItemInput = z.infer<typeof itemInput>;
export type CartTool = 'createCart' | 'getCart' | 'addItemToCart' | 'updateCartItem' | 'removeItemFromCart'
  | 'getCartDeliveryMethods' | 'setCartDelivery' | 'listPaymentMethods' | 'setCartPayment' | 'listVouchers' | 'setVoucher' | 'removeVoucher';
export interface CartGateway {
  call(tool: CartTool, args: Record<string, unknown>): Promise<unknown>;
  /** Metadados diretos do servidor, sem modificar nomes anunciados pelo host. */
  describe?(): Promise<{ name: string; inputSchema: unknown }[]>;
  /** Exclusivo da orquestração determinística após consumir confirmação PREPARE_CART. */
  writeConfirmed?(tool: 'createCart' | 'addItemToCart' | 'updateCartItem' | 'removeItemFromCart', args: Record<string, unknown>): Promise<unknown>;
}
export const WRITES: ReadonlySet<string> = new Set(['createCart', 'addItemToCart', 'updateCartItem', 'removeItemFromCart',
  'setCartDelivery', 'setCartPayment', 'setVoucher', 'removeVoucher']);

export function payload(raw: unknown): unknown {
  const value = raw && typeof raw === 'object' && 'data' in raw ? (raw as { data: unknown }).data : raw;
  for (const candidate of value === raw ? [raw] : [raw, value]) {
    if (extractErrors(candidate).length || (candidate && typeof candidate === 'object' && 'success' in candidate && candidate.success !== true)) {
      throw new CartError('CART_CONTRACT_UNVERIFIED', 'Resposta do MCP contém erro ou não confirma sucesso.', 502);
    }
  }
  return value;
}

// Hipótese mínima já usada pelos fakes de F7; NÃO é outputSchema observado do provedor.
// Não aceitar undefined/texto/{}/queued=true como prova de que a escrita foi concluída.
const mutationConfirmation = z.object({ success: z.literal(true) }).strict();
export function assertMutationConfirmation(raw: unknown): void {
  const body = payload(raw);
  // Observado: mutações devolvem o carrinho completo; a composição é conferida depois pela releitura.
  if (isObservedCart(body)) { normalizeObserved(body); return; }
  if (!mutationConfirmation.safeParse(body).success)
    throw new CartError('CART_CONTRACT_UNVERIFIED', 'Confirmação de escrita não reconhecida; reconciliar antes de repetir.', 502);
}

export function parseCreatedCart(raw: unknown): { cartId: string } {
  const result = z.object({ cartId: id }).safeParse(payload(raw));
  if (!result.success) throw new CartError('CART_CONTRACT_UNVERIFIED', 'createCart não retornou cartId reconhecido.', 502);
  return result.data;
}
// Formato OBSERVADO na INT-02 (18/10/2026, fixtures/int02): createCart, getCart e as mutações devolvem o
// carrinho completo em content[].text, sem success/data. addressId não volta; só deliveryAddress textual.
// Item sem opções omite `options` (formato com opções ainda não observado: chave desconhecida rejeita).
const observedItem = z.object({ itemId: id, cartItemId: id, quantity: z.number().int().positive(), unitPrice: money,
  name: z.string().optional(), options: z.array(selectedOption).optional(), customerNote: z.string().optional() }).strict();
const observedCart = z.object({
  cartId: id, merchant: z.object({ merchantId: id }).passthrough(), items: z.array(observedItem),
  deliveryAddress: z.object({ streetName: z.string().min(1), streetNumber: z.string().min(1), neighborhood: z.string().nullish() }).passthrough(),
  deliveryMethod: z.object({ deliveryMethodId: z.string().min(1), fee: money }).passthrough(),
  fees: z.array(z.object({ amount: money }).passthrough()),
  summary: z.object({ totalAmount: money, subtotalAmount: money, deliveryFeeAmount: money, feeTotalAmount: money,
    benefitsTotalAmount: money, voucherTotalAmount: money }).passthrough(),
}).passthrough();
const isObservedCart = (v: unknown) => !!v && typeof v === 'object' && 'merchant' in v && 'summary' in v;
function normalizeObserved(raw: unknown): unknown {
  const r = observedCart.safeParse(raw);
  if (!r.success) throw new CartError('CART_CONTRACT_UNVERIFIED', 'Carrinho retornado fora do formato observado.', 502);
  const c = r.data, extra = raw as Record<string, unknown>;
  // Pagamento/cupons ainda não observados: presença bloqueia em vez de ser ignorada.
  if ((extra['paymentMethod'] ?? null) !== null || (Array.isArray(extra['vouchers']) && extra['vouchers'].length))
    throw new CartError('CART_CONTRACT_UNVERIFIED', 'Carrinho contém pagamento/cupom em formato não validado.', 502);
  const feeSum = c.fees.reduce((a, f) => a + f.amount, 0);
  if (c.deliveryMethod.fee !== c.summary.deliveryFeeAmount || feeSum !== c.summary.feeTotalAmount)
    throw new CartError('CART_CONTRACT_UNVERIFIED', 'Taxas do carrinho divergem entre si.', 502);
  return { cartId: c.cartId, merchantId: c.merchant.merchantId,
    deliveryAddress: { street: c.deliveryAddress.streetName, number: c.deliveryAddress.streetNumber, neighborhood: c.deliveryAddress.neighborhood ?? null },
    items: c.items.map(i => ({ cartItemId: i.cartItemId, itemId: i.itemId, quantity: i.quantity, options: i.options ?? [],
      unitPrice: i.unitPrice / 100, ...(i.customerNote !== undefined ? { customerNote: i.customerNote } : {}) })),
    totals: { subtotal: c.summary.subtotalAmount / 100, deliveryFee: c.summary.deliveryFeeAmount / 100, serviceFee: c.summary.feeTotalAmount / 100,
      discount: c.summary.voucherTotalAmount / 100, total: c.summary.totalAmount / 100, benefits: c.summary.benefitsTotalAmount / 100 },
    deliveryMethod: { deliveryMethodId: c.deliveryMethod.deliveryMethodId } };
}
export function parseSnapshot(raw: unknown): Snapshot {
  const body = payload(raw);
  const result = snapshotSchema.safeParse(isObservedCart(body) ? normalizeObserved(body) : body);
  if (!result.success) throw new CartError('CART_CONTRACT_UNVERIFIED', 'Resposta de getCart não reconhecida; é necessária uma captura sanitizada do contrato real.', 502);
  const s = result.data;
  if (new Set(s.items.map((i) => i.cartItemId)).size !== s.items.length) throw new CartError('CART_CONTRACT_UNVERIFIED', 'Itens duplicados na resposta de getCart.', 502);
  return s;
}
export function confirmedTotals(s: Snapshot) {
  const t = s.totals;
  if (!t) return { status: 'UNAVAILABLE' as const, values: null };
  const values = { subtotalCents: t.subtotal, deliveryFeeCents: t.deliveryFee,
    serviceFeeCents: t.serviceFee, discountCents: t.discount, totalCents: t.total };
  const expected = BigInt(values.subtotalCents) + BigInt(values.deliveryFeeCents) + BigInt(values.serviceFeeCents) - BigInt(values.discountCents);
  if (expected >= 0n && expected === BigInt(values.totalCents)) return { status: 'CONSISTENT' as const, values };
  // Decisão INT-02 (18/10/2026): com benefícios não decomponíveis, o total é só INFORMADO pelo iFood,
  // nunca confirmado. Exige total entre 0 e o valor sem benefícios; orçamento/rateio seguem não verificados.
  const total = BigInt(values.totalCents);
  if ((t.benefits ?? 0) > 0 && total >= 0n && total <= expected) return { status: 'PROVIDER_REPORTED' as const, values };
  return { status: 'DIVERGENT' as const, values };
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
