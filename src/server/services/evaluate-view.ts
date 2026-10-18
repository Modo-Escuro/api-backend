// Formata o resultado do pipeline para a API (POST /api/evaluate).
// Campos opcionais saem como valor ou null; o estado real (ABSENT/NULL/INVALID) fica em `missingFields`,
// para a UI distinguir "não informado" de "vazio". Nenhum token, segredo ou coordenada é incluído.

import type { Field } from '../domain/fields.js';
import { indexOptions } from '../domain/normalize.js';
import type { PriceBreakdown } from '../domain/pricing.js';
import type { DetailOutcome, EvaluatedCandidate, EvaluateOutcome } from './evaluate.js';

type FieldState = Exclude<Field<unknown>['state'], 'PRESENT'>;

function collector() {
  const missing: Record<string, FieldState> = {};
  const v = <T>(name: string, f: Field<T>): T | null => {
    if (f.state === 'PRESENT') return f.value;
    missing[name] = f.state;
    return null;
  };
  return { v, missing };
}

const DETAIL_REASON: Record<DetailOutcome['status'], string> = {
  DETAILED: 'getItem executado',
  SKIPPED_CLOSED: 'loja fechada — getItem não executado',
  SKIPPED_LIMIT: 'fora do limite de detalhamento (maxDetails) — getItem não executado',
  SKIPPED_DEADLINE: 'prazo da requisição esgotado — getItem não executado',
  FAILED: 'getItem falhou',
};

function priceView(p: PriceBreakdown | null) {
  if (!p) return null;
  return {
    kind: p.kind,
    status: p.status,
    flags: p.flags,
    quantity: p.quantity,
    unit: p.unit,
    options: {
      mandatory: p.options.mandatory,
      additional: p.options.additional,
      mandatoryTotalPerUnit: p.options.mandatoryTotalPerUnit,
      additionalTotalPerUnit: p.options.additionalTotalPerUnit,
    },
    unitTotal: p.status === 'ESTIMATED' ? p.unitTotal : null,
    unitTotalRange: p.unitTotalRange,
    itemsSubtotalRange: p.itemsSubtotalRange,
    estimatedTotal: p.status === 'ESTIMATED' ? p.estimatedTotal : null,
    estimatedTotalRange: p.estimatedTotalRange,
    itemsAndDeliverySubtotal: p.itemsAndDeliverySubtotal,
    service: p.service,
    interpretations: p.interpretations,
    delivery: p.delivery,
    minimumOrder: p.minimumOrder,
    listingComparison: p.listingComparison,
    confirmation: p.confirmation,
    notes: p.notes,
  };
}

export function candidateView(c: EvaluatedCandidate) {
  const { listing, evaluation: e, detail } = c;
  const { v, missing } = collector();
  const d = detail.status === 'DETAILED' ? detail.detail : null;
  const options = d ? indexOptions(d) : new Map();
  const optName = (id: string) => {
    const o = options.get(id);
    return o && o.option.name.state === 'PRESENT' ? o.option.name.value : null;
  };
  const m = listing.merchant;
  const delivery = v('merchant.delivery', m.delivery);

  return {
    itemId: e.itemId,
    merchantId: e.merchantId,
    eligible: e.eligible,
    item: {
      name: d ? v('itemName', d.itemName) : v('itemName', listing.itemName),
      description: d ? v('itemDescription', d.itemDescription) : null,
      imageUrl: d ? v('itemImageUrl', d.imageUrl) : v('itemImageUrl', listing.imageUrl),
      appDeeplink: d ? v('appDeeplink', d.appDeeplink) : null,
      ingredientsAndAllergens: 'NOT_PROVIDED_BY_IFOOD' as const,
    },
    merchant: {
      name: v('merchant.name', m.name),
      isOpen: v('merchant.isOpen', m.isOpen),
      rating: v('merchant.rating', m.rating.value),
      ratingCount: v('merchant.ratingCount', m.rating.count),
      distanceKm: v('merchant.distanceKm', m.distanceKm),
      deliveryMode: delivery ? v('merchant.delivery.mode', delivery.mode) : null,
      etaMinutes: delivery ? { min: v('merchant.delivery.eta.min', delivery.etaMinutes.min), max: v('merchant.delivery.eta.max', delivery.etaMinutes.max) } : null,
    },
    listingPrice: {
      unitPrice: v('listing.unitPrice', listing.price.unitPrice),
      promotionalUnitPrice: v('listing.promotionalUnitPrice', listing.price.promotionalUnitPrice),
      definitive: false as const,
    },
    detail: {
      status: detail.status,
      reason: DETAIL_REASON[detail.status],
      cached: detail.status === 'DETAILED' ? detail.cached : null,
      error: detail.status === 'FAILED' ? detail.error : null,
    },
    availability: e.availability,
    restrictions: e.restrictions.map((r) => ({
      restriction: r.restriction,
      requirement: r.requirement,
      status: r.status,
      source: r.source,
      heuristic: r.heuristic,
      blocking: r.blocking,
      coversOptions: r.coversOptions,
      reasons: r.reasons,
      evidence: r.hits.map((h) => ({ term: h.term, where: h.where, optionId: h.optionId ?? null })),
      blockedOptions: r.blockedOptionIds.map((id) => ({ optionId: id, name: optName(id) })),
    })),
    configuration: e.selection
      ? {
          source: e.selection.source,
          status: e.configuration?.status ?? null,
          options: e.selection.options.map((o) => ({ optionId: o.optionId, name: optName(o.optionId), quantity: o.quantity ?? 1 })),
          groups: e.configuration?.groups ?? [],
        }
      : null,
    pricing: {
      minimumConfigurable: priceView(e.pricing.minimumConfigurable),
      selected: priceView(e.pricing.selected),
      confirmedTotal: null,
    },
    budget: e.budget,
    limits: e.limits,
    blockers: e.blockers,
    warnings: e.warnings,
    dataLimitations: e.dataLimitations,
    missingFields: missing,
    search: { page: c.page, serverFilters: c.serverFilters },
  };
}

export function evaluateView(o: EvaluateOutcome) {
  const views = o.candidates.map(candidateView);
  const eligible = views.filter((x) => x.eligible);
  const blocked = views.filter((x) => !x.eligible);
  const blockerCounts: Record<string, number> = {};
  for (const b of blocked) for (const code of new Set(b.blockers.map((x) => x.code))) blockerCounts[code] = (blockerCounts[code] ?? 0) + 1;
  return {
    query: o.query,
    interpretedQuery: o.interpretedQuery,
    location: o.location,
    serverFilters: o.serverFilters,
    summary: { candidates: views.length, eligible: eligible.length, blocked: blocked.length, blockerCounts },
    eligible,
    blocked,
    search: o.search,
    details: o.details,
    limits: o.limits,
    durationMs: o.durationMs,
    deadlineReached: o.deadlineReached,
    notes: [
      'Sem ranking: a ordem é a do searchOffers (relevância do iFood ou `refinements.sort`).',
      'Preços são estimativas ou faixas; o total confirmado só existe no carrinho do iFood (fora do escopo).',
      'O iFood não fornece ingredientes/alérgenos estruturados; heurísticas textuais nunca comprovam segurança.',
      'Apenas restrições obrigatórias são enviadas como filtro ao iFood; preferências não excluem itens.',
    ],
  };
}
