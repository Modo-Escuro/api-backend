// Conversão explícita BRL decimal (domínio, CLAUDE.md) ↔ centavos inteiros (contrato do bot, docs/bot-api.md).
// Todo campo monetário do contrato do bot termina em `Cents`. Textos (notes/mensagens) continuam em "R$ x,yz".

import type { PriceRange } from '../domain/pricing.js';
import type { candidateView, evaluateView } from './evaluate-view.js';

/** Valores do domínio já estão arredondados a centavos; Math.round absorve o erro de ponto flutuante (32.9*100). */
export const toCents = (v: number | null | undefined): number | null => (v === null || v === undefined ? null : Math.round(v * 100));
export const fromCents = (c: number): number => c / 100;

const rangeCents = (r: PriceRange) => ({ minCents: toCents(r.min), maxCents: toCents(r.max) });

type Candidate = ReturnType<typeof candidateView>;
type PriceView = NonNullable<Candidate['pricing']['minimumConfigurable']>;

function priceCents(p: PriceView | null) {
  if (!p) return null;
  const opt = (o: PriceView['options']['mandatory'][number]) => ({
    optionId: o.optionId,
    optionGroupId: o.optionGroupId,
    groupName: o.groupName,
    name: o.name,
    quantity: o.quantity,
    unitAdditionalPriceCents: toCents(o.unitAdditionalPrice),
    totalCents: toCents(o.total),
  });
  return {
    kind: p.kind,
    status: p.status,
    flags: p.flags,
    quantity: p.quantity,
    unit: {
      listPriceCents: toCents(p.unit.listPrice),
      promotionalPriceCents: toCents(p.unit.promotionalPrice),
      basePriceCents: toCents(p.unit.basePrice),
      promotionApplied: p.unit.promotionApplied,
      discountPerUnitCents: toCents(p.unit.discountPerUnit),
      discountPercent: p.unit.discountPercent,
    },
    options: {
      mandatory: p.options.mandatory.map(opt),
      additional: p.options.additional.map(opt),
      mandatoryTotalPerUnitCents: toCents(p.options.mandatoryTotalPerUnit),
      additionalTotalPerUnitCents: toCents(p.options.additionalTotalPerUnit),
    },
    unitTotalCents: toCents(p.unitTotal),
    unitTotalRange: rangeCents(p.unitTotalRange),
    itemsSubtotalRange: rangeCents(p.itemsSubtotalRange),
    estimatedTotalCents: toCents(p.estimatedTotal),
    estimatedTotalRange: rangeCents(p.estimatedTotalRange),
    interpretations: p.interpretations.map((i) => ({ id: i.id, description: i.description, unitTotalRange: rangeCents(i.unitTotal) })),
    delivery: { feeCents: toCents(p.delivery.fee), promotionalFeeApplied: p.delivery.promotionalFeeApplied, source: p.delivery.source },
    minimumOrder: {
      amountCents: toCents(p.minimumOrder.amount),
      source: p.minimumOrder.source,
      met: p.minimumOrder.met,
      missingAmount: rangeCents(p.minimumOrder.missingAmount),
    },
    listingComparison: {
      listingBasePriceCents: toCents(p.listingComparison.listingBasePrice),
      detailBasePriceCents: toCents(p.listingComparison.detailBasePrice),
      differs: p.listingComparison.differs,
    },
    confirmation: { status: p.confirmation.status, totalCents: null, reason: p.confirmation.reason },
    notes: p.notes,
  };
}

/** Genérico para preservar campos extras (ex.: `ranking` das recomendações) na saída em centavos. */
function candidateCents<C extends Candidate>(c: C) {
  const { listingPrice, pricing, ...rest } = c;
  return {
    ...rest,
    listingPrice: {
      unitPriceCents: toCents(listingPrice.unitPrice),
      promotionalUnitPriceCents: toCents(listingPrice.promotionalUnitPrice),
      definitive: listingPrice.definitive,
    },
    pricing: {
      minimumConfigurable: priceCents(pricing.minimumConfigurable),
      selected: priceCents(pricing.selected),
      confirmedTotalCents: null,
    },
  };
}

/** Resposta de /api/evaluate no contrato do bot (centavos inteiros). */
export function evaluateViewCents(v: ReturnType<typeof evaluateView>) {
  return {
    money: { currency: 'BRL' as const, unit: 'CENTS' as const },
    ...v,
    // `ranking` (dentro de cada recomendação) não tem dinheiro — passa intacto por candidateCents.
    recommendations: v.recommendations.map(candidateCents),
    eligible: v.eligible.map(candidateCents),
    blocked: v.blocked.map(candidateCents),
    needsVerification: v.needsVerification.map(candidateCents),
  };
}
