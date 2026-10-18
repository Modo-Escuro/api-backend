// DOM-01 / DEC-01 D3–D4: calcula custos de uma atribuição já fornecida.
// Não escolhe itens/pessoas (GRP-01), não persiste (DATA-01) e não aprova compra.
import { addCents, cents, compareIds, multiplyCents, splitCents } from './money.js';
import type { TriState } from './constraints.js';

export interface CostInput {
  participants: { participantId: string; capCents?: number }[];
  items: { itemId: string; unitPriceCents: number; quantity: number; consumerIds: string[] }[];
  deliveryFeeCents: number | null;
  serviceFeeCents: number | null;
  discounts: { discountId: string; amountCents: number; eligibleItemIds: string[] | null }[];
  collectiveCapCents?: number;
  minimumOrderCents?: number;
}

const unique = (ids: string[]) => ids.every((id) => id.length > 0) && new Set(ids).size === ids.length;

export function allocateCosts(input: CostInput) {
  const ids = input.participants.map((p) => p.participantId).sort(compareIds);
  if (!ids.length || !input.items.length || !unique(ids) || !unique(input.items.map((i) => i.itemId))
    || !unique(input.discounts.map((d) => d.discountId))) throw new RangeError('Identificadores de custo ausentes ou duplicados');
  const rows = ids.map((participantId) => ({ participantId, itemsCents: 0, deliveryCents: 0 as number | null,
    serviceCents: 0 as number | null, discountCents: 0, totalCents: null as number | null, budget: null as TriState | null }));
  const byId = new Map(rows.map((r) => [r.participantId, r]));
  const allocations = new Map<string, Record<string, number>>();
  const warnings: string[] = [];
  for (const item of input.items) {
    if (!Number.isSafeInteger(item.quantity) || item.quantity < 1 || !item.consumerIds.length || !unique(item.consumerIds)
      || item.consumerIds.some((id) => !byId.has(id))) throw new RangeError('Consumo ou quantidade inválidos');
    const parts = splitCents(multiplyCents(item.unitPriceCents, item.quantity), item.consumerIds.map((participantId) => ({ participantId, weight: 1 })));
    allocations.set(item.itemId, { ...parts });
    for (const [id, amount] of Object.entries(parts)) byId.get(id)!.itemsCents = addCents(byId.get(id)!.itemsCents, amount);
  }
  const consumers = ids.filter((id) => input.items.some((i) => i.consumerIds.includes(id)));
  const feeWeights = consumers.map((participantId) => ({ participantId, weight: 1 }));
  for (const [amount, field] of [[input.deliveryFeeCents, 'deliveryCents'], [input.serviceFeeCents, 'serviceCents']] as const) {
    if (amount !== null) cents(amount);
    const parts = amount === null ? null : splitCents(amount, feeWeights);
    for (const id of consumers) byId.get(id)![field] = parts ? parts[id]! : null;
  }
  for (const discount of [...input.discounts].sort((a, b) => compareIds(a.discountId, b.discountId))) {
    cents(discount.amountCents);
    if (discount.eligibleItemIds === null) { warnings.push(`DISCOUNT_ELIGIBILITY_UNKNOWN:${discount.discountId}`); continue; }
    if (!unique(discount.eligibleItemIds) || discount.eligibleItemIds.some((id) => !allocations.has(id))) throw new RangeError('Elegibilidade de desconto inválida');
    const weights = ids.map((participantId) => ({ participantId,
      weight: addCents(...discount.eligibleItemIds!.map((id) => allocations.get(id)![participantId] ?? 0)) }));
    const eligibleTotal = addCents(...weights.map((w) => w.weight));
    const applied = Math.min(discount.amountCents, eligibleTotal);
    const parts = splitCents(applied, weights);
    for (const id of ids) {
      const part = parts[id]!;
      byId.get(id)!.discountCents = addCents(byId.get(id)!.discountCents, part);
      // Consome só subtotais ainda elegíveis; outro desconto não reaproveita o mesmo centavo.
      const itemParts = splitCents(part, discount.eligibleItemIds.map((itemId) => ({
        participantId: itemId, weight: allocations.get(itemId)![id] ?? 0,
      })));
      for (const itemId of discount.eligibleItemIds) allocations.get(itemId)![id] = cents((allocations.get(itemId)![id] ?? 0) - itemParts[itemId]!);
    }
  }
  for (const row of rows) {
    row.totalCents = row.deliveryCents === null || row.serviceCents === null ? null
      : cents(addCents(row.itemsCents, row.deliveryCents, row.serviceCents) - row.discountCents);
    const cap = input.participants.find((p) => p.participantId === row.participantId)!.capCents;
    if (cap !== undefined) { cents(cap); row.budget = row.totalCents === null ? 'UNKNOWN' : row.totalCents <= cap ? 'PASS' : 'FAIL'; }
  }
  const subtotalCents = addCents(...rows.map((r) => r.itemsCents));
  const discountCents = addCents(...rows.map((r) => r.discountCents));
  const totalCents = rows.some((r) => r.totalCents === null) ? null : addCents(...rows.map((r) => r.totalCents!));
  let collectiveBudget: TriState | null = null;
  if (input.collectiveCapCents !== undefined) {
    cents(input.collectiveCapCents);
    collectiveBudget = totalCents === null ? 'UNKNOWN' : totalCents <= input.collectiveCapCents ? 'PASS' : 'FAIL';
  }
  const minimumOrder: TriState | null = input.minimumOrderCents === undefined ? null
    : subtotalCents >= cents(input.minimumOrderCents) ? 'PASS' : 'FAIL';
  const budgetsSatisfied = totalCents !== null && collectiveBudget !== 'FAIL'
    && rows.every((r) => r.budget !== 'FAIL' && r.budget !== 'UNKNOWN') && minimumOrder !== 'FAIL';
  return { kind: totalCents === null ? 'UNKNOWN' as const : 'ESTIMATE' as const, currency: 'BRL' as const,
    subtotalCents, deliveryFeeCents: input.deliveryFeeCents, serviceFeeCents: input.serviceFeeCents,
    discountCents, totalCents, participants: rows, collectiveBudget, minimumOrder, budgetsSatisfied, warnings };
}
