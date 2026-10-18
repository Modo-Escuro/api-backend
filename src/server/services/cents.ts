// Projeção dos centavos do domínio para nomes *Cents do contrato do bot, sem multiplicar novamente.
// Todo campo monetário do contrato do bot termina em `Cents`. Textos (notes/mensagens) continuam em "R$ x,yz".

import { cents } from '../domain/money.js';
import type { PriceRange } from '../domain/pricing.js';
import type { candidateView, evaluateView } from './evaluate-view.js';

const centsValue = (v: number | null | undefined): number | null => v == null ? null : cents(v);

const rangeCents = (r: PriceRange) => ({ minCents: centsValue(r.min), maxCents: centsValue(r.max) });

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
    unitAdditionalPriceCents: centsValue(o.unitAdditionalPrice),
    totalCents: centsValue(o.total),
  });
  return {
    kind: p.kind,
    status: p.status,
    flags: p.flags,
    quantity: p.quantity,
    unit: {
      listPriceCents: centsValue(p.unit.listPrice),
      promotionalPriceCents: centsValue(p.unit.promotionalPrice),
      basePriceCents: centsValue(p.unit.basePrice),
      promotionApplied: p.unit.promotionApplied,
      discountPerUnitCents: centsValue(p.unit.discountPerUnit),
      discountPercent: p.unit.discountPercent,
    },
    options: {
      mandatory: p.options.mandatory.map(opt),
      additional: p.options.additional.map(opt),
      mandatoryTotalPerUnitCents: centsValue(p.options.mandatoryTotalPerUnit),
      additionalTotalPerUnitCents: centsValue(p.options.additionalTotalPerUnit),
    },
    unitTotalCents: centsValue(p.unitTotal),
    unitTotalRange: rangeCents(p.unitTotalRange),
    itemsSubtotalRange: rangeCents(p.itemsSubtotalRange),
    estimatedTotalCents: centsValue(p.estimatedTotal),
    estimatedTotalRange: rangeCents(p.estimatedTotalRange),
    itemsAndDeliverySubtotalCents: centsValue(p.itemsAndDeliverySubtotal),
    service: { feeCents: centsValue(p.service.fee), status: p.service.status },
    interpretations: p.interpretations.map((i) => ({ id: i.id, description: i.description, unitTotalRange: rangeCents(i.unitTotal) })),
    delivery: { feeCents: centsValue(p.delivery.fee), promotionalFeeApplied: p.delivery.promotionalFeeApplied, source: p.delivery.source },
    minimumOrder: {
      amountCents: centsValue(p.minimumOrder.amount),
      source: p.minimumOrder.source,
      met: p.minimumOrder.met,
      missingAmount: rangeCents(p.minimumOrder.missingAmount),
    },
    listingComparison: {
      listingBasePriceCents: centsValue(p.listingComparison.listingBasePrice),
      detailBasePriceCents: centsValue(p.listingComparison.detailBasePrice),
      differs: p.listingComparison.differs,
    },
    confirmation: { status: p.confirmation.status, totalCents: null, reason: p.confirmation.reason },
    notes: p.notes,
  };
}

/** Genérico para preservar campos extras (ex.: `ranking` das recomendações) na saída em centavos. */
function candidateCents<C extends Candidate>(c: C) {
  const { listingPrice, pricing, limits, ...rest } = c;
  return {
    ...rest,
    limits: limits.map((check) => {
      if (check.metric !== 'maxDeliveryFee') return check;
      const observed = check.observed && typeof check.observed === 'object' ? rangeCents(check.observed) : null;
      return { metric: 'maxDeliveryFeeCents', requirement: check.requirement, status: check.status,
        limitCents: centsValue(check.limit as number), observed };
    }),
    listingPrice: {
      unitPriceCents: centsValue(listingPrice.unitPrice),
      promotionalUnitPriceCents: centsValue(listingPrice.promotionalUnitPrice),
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
    // `ranking.orderingKeys.estimatedTotalCents` já é centavos; preserva sem reconversão.
    recommendations: v.recommendations.map(candidateCents),
    eligible: v.eligible.map(candidateCents),
    blocked: v.blocked.map(candidateCents),
    needsVerification: v.needsVerification.map(candidateCents),
  };
}
