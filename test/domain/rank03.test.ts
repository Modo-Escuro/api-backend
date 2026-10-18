// RANK-03: fixtures reais com custos completos/serviço e prazos SINTÉTICOS, sem rede.
import { describe, expect, it } from 'vitest';
import { evaluateCandidate, type UserConstraints } from '../../src/server/domain/eligibility';
import { ABSENT, present, val } from '../../src/server/domain/fields';
import { centsToBrl } from '../../src/server/domain/money';
import { normalizePromotion } from '../../src/server/domain/normalize';
import { classifyBlockers, rankCandidates, type RankCandidate } from '../../src/server/domain/ranking';
import { completeSyntheticEstimate } from '../helpers/ranking';
import { item, listingFor } from './helpers';

function candidate(name: string, priceCents = 1000, feeCents: number | null = 0, minutes: number | null = 30,
  opts: { quantity?: number; catalog?: boolean; constraints?: UserConstraints; serviceCents?: number } = {}): RankCandidate {
  const detail = item(name);
  const listing = listingFor(detail.itemId);
  detail.price = normalizePromotion({ unitPrice: centsToBrl(priceCents) });
  listing.price = detail.price;
  detail.optionGroups = present([]);
  detail.itemName = listing.itemName = present('Refeição sintética');
  detail.itemDescription = present('Prato de teste');
  listing.merchant.rating = { value: present(4), rawValue: present(4), count: present(20) };
  listing.merchant.delivery = present({ ...val(listing.merchant.delivery)!,
    fee: feeCents === null ? ABSENT : present(feeCents), promotionalFee: ABSENT, effectiveFee: feeCents,
    etaMinutes: { min: minutes === null ? ABSENT : present(minutes), max: minutes === null ? ABSENT : present(minutes) },
  });
  const evaluation = evaluateCandidate({ detail, listing, serverFilters: [], quantity: opts.quantity }, opts.constraints ?? { restrictions: [] });
  const c = { detail, listing, evaluation };
  return opts.catalog || feeCents === null ? c : completeSyntheticEstimate(c, opts.serviceCents);
}

const ids = (r: ReturnType<typeof rankCandidates>) => r.recommendations.map((rec) => rec.itemId);
const order = (cs: RankCandidate[], priority: 'ECONOMY' | 'SPEED' = 'ECONOMY') => rankCandidates(cs, { priority });
const criterion = (r: ReturnType<typeof rankCandidates>, id: string, key: string) =>
  r.recommendations.find((rec) => rec.itemId === id)!.criteria.find((cr) => cr.criterion === key)!;

describe('RANK-03 ECONOMY e SPEED — DEC-01 D9', () => {
  it('A: 1000 + 2000 frete perde para 2000 + 0; justificativas e chave usam total completo', () => {
    const a = candidate('Vegano Brooks', 1000, 2000);
    const b = candidate('Veggie Burger', 2000, 0);
    const result = order([a, b]);
    expect(ids(result)).toEqual([b.evaluation.itemId, a.evaluation.itemId]);
    expect(result.recommendations.map((rec) => rec.orderingKeys.estimatedTotalCents)).toEqual([2000, 3000]);
    expect(result.recommendations[0]!.reasons.join(' ')).toContain('custo total estimado R$ 20.00');
    expect(result.recommendations[1]!.reasons.join(' ')).toContain('custo total estimado R$ 30.00');
    expect(result.recommendations[0]!.reasons.join(' ')).toContain('não é cotação confirmada');
    expect(a.evaluation.pricing.confirmedTotal).toBeNull();
  });

  it('custo usa quantidade, entrega uma vez e serviço explícito, da configuração selecionada', () => {
    const a = candidate('Vegano Brooks', 1000, 2000, 30, { quantity: 3, serviceCents: 500 });
    const b = candidate('Veggie Burger', 2000, 0, 30, { quantity: 2, serviceCents: 300 });
    // Simula seleção explícita já precificada; mínimo mais barato não pode substituir seu total.
    a.evaluation.pricing.selected = structuredClone(a.evaluation.pricing.minimumConfigurable);
    a.evaluation.pricing.minimumConfigurable!.estimatedTotalRange = { min: 1, max: 1 };
    const result = order([a, b]);
    expect(result.recommendations.map((rec) => rec.orderingKeys.estimatedTotalCents)).toEqual([4300, 5500]);
    expect(result.recommendations[1]!.reasons.join(' ')).toContain('configuração selecionada');
  });

  it('B: mais rápido com frete maior vence SPEED e a dimensão DELIVERY só pontua prazo', () => {
    const fast = candidate('Vegano Brooks', 1000, 5000, 15);
    const slow = candidate('Veggie Burger', 1000, 0, 60);
    const result = order([slow, fast], 'SPEED');
    expect(ids(result)[0]).toBe(fast.evaluation.itemId);
    expect(criterion(result, fast.evaluation.itemId, 'DELIVERY')).toMatchObject({ score: 1, weight: 0.2 });
    expect(criterion(result, slow.evaluation.itemId, 'DELIVERY').score).toBe(0);
    expect(criterion(result, fast.evaluation.itemId, 'DELIVERY').basis).toContain('frete só entra no custo');
    expect(result.recommendations[0]!.orderingKeys.estimatedMinutes).toBe(15);
    expect(ids(order([slow, fast]))[0]).toBe(slow.evaluation.itemId);
  });

  it('limite obrigatório de prazo é validado antes do ranking; alvo flexível não bloqueia', () => {
    const hard = candidate('Vegano Brooks', 1000, 0, 60, { constraints: { restrictions: [], mandatoryLimits: { maxDeliveryTimeMinutes: 30 } } });
    const soft = candidate('Veggie Burger', 1000, 0, 60, { constraints: { restrictions: [], preferredLimits: { maxDeliveryTimeMinutes: 30 } } });
    expect(classifyBlockers(hard.evaluation.blockers)).toBe('BLOCKED');
    expect(hard.evaluation.eligible).toBe(false);
    expect(soft.evaluation.eligible).toBe(true);
    expect(ids(order([hard, soft], 'SPEED'))).toEqual([soft.evaluation.itemId]);
  });

  it('catálogo sem serviço não inventa total ou usa subtotal parcial para economia', () => {
    const a = candidate('Vegano Brooks', 1000, 2000, 30, { catalog: true });
    const b = candidate('Veggie Burger', 2000, 0, 30, { catalog: true });
    const result = order([a, b]);
    for (const rec of result.recommendations) {
      expect(rec.orderingKeys.estimatedTotalCents).toBeNull();
      expect(rec.criteria.find((cr) => cr.criterion === 'PRICE')).toMatchObject({ status: 'NO_DATA', score: null, effectiveWeight: 0 });
      expect(rec.dataLimitations.join(' ')).toContain('subtotal parcial');
    }
    expect(a.evaluation.pricing.minimumConfigurable!.itemsAndDeliverySubtotal).toBe(3000);
    expect(b.evaluation.pricing.minimumConfigurable!.itemsAndDeliverySubtotal).toBe(2000);
  });

  it.each(['open', 'closed'] as const)('faixa de total %s não vira valor único nem dá vantagem sobre conhecido', (kind) => {
    const uncertain = candidate('Vegano Brooks', 100, 0, 10);
    const known = candidate('Veggie Burger', 9000, 0, 60);
    uncertain.evaluation.pricing.minimumConfigurable!.estimatedTotalRange = { min: 100, max: kind === 'open' ? null : 10000 };
    const result = order([uncertain, known]);
    expect(ids(result)[0]).toBe(known.evaluation.itemId);
    expect(result.recommendations[1]!.orderingKeys.estimatedTotalCents).toBeNull();
    expect(result.recommendations[1]!.dataLimitations.join(' ')).toContain('faixa');
  });

  it('frete ausente não vale zero; prazo ausente não vale zero', () => {
    const missingFee = candidate('Vegano Brooks', 100, null, 10);
    const missingEta = candidate('Veggie Burger', 100, 0, null);
    const known = candidate('Maria salada Veg', 9000, 0, 60);
    expect(ids(order([missingFee, known]))[0]).toBe(known.evaluation.itemId);
    const speed = order([missingEta, known], 'SPEED');
    expect(ids(speed)[0]).toBe(known.evaluation.itemId);
    expect(criterion(speed, missingEta.evaluation.itemId, 'DELIVERY').status).toBe('NO_DATA');
    expect(speed.recommendations[1]!.dataLimitations.join(' ')).toContain('nenhum prazo foi inventado');
  });

  it('prazo usa máximo observado; mínimo sozinho ou faixa inválida fica desconhecido', () => {
    const a = candidate('Vegano Brooks', 1000, 0, 60);
    const delivery = val(a.listing.merchant.delivery)!;
    delivery.etaMinutes.min = present(10);
    expect(order([a], 'SPEED').recommendations[0]!.orderingKeys.estimatedMinutes).toBe(60);
    delivery.etaMinutes.max = ABSENT;
    expect(order([a], 'SPEED').recommendations[0]!.orderingKeys.estimatedMinutes).toBeNull();
    delivery.etaMinutes.max = present(5);
    expect(order([a], 'SPEED').recommendations[0]!.orderingKeys.estimatedMinutes).toBeNull();
  });

  it('prazo inválido não recebe nota de cumprimento no alvo flexível de CONTEXT', () => {
    const a = candidate('Vegano Brooks', 1000, 0, 30, { catalog: true });
    val(a.listing.merchant.delivery)!.etaMinutes.min = present(40); // faixa incoerente, sintética
    const soft = { maxDeliveryTimeMinutes: 30 };
    a.evaluation = evaluateCandidate({ listing: a.listing, detail: a.detail, serverFilters: [] },
      { restrictions: [], preferredLimits: soft });
    expect(a.evaluation.eligible).toBe(true);
    const result = rankCandidates([a], { priority: 'SPEED' }, soft);
    expect(criterion(result, a.evaluation.itemId, 'CONTEXT').status).toBe('NO_DATA');
    expect(criterion(result, a.evaluation.itemId, 'DELIVERY').status).toBe('NO_DATA');
    expect(result.recommendations[0]!.orderingKeys).toMatchObject({ estimatedMinutes: null, preferencesSatisfied: null });
  });

  it.each([undefined, 'PREFERENCES'] as const)('sem prioridade D9 (%s), pede esclarecimento sem inventar ordem', (priority) => {
    const result = rankCandidates([candidate('Vegano Brooks')], { priority });
    expect(result).toMatchObject({ status: 'PRIORITY_REQUIRED', recommendations: [], eligibleConsidered: 1, eligibleScored: 0 });
    expect(result.clarification).toContain('ECONOMY');
    expect(result.clarification).toContain('SPEED');
  });
});

describe('RANK-03 cobertura, segurança e determinismo', () => {
  it('C: perder avaliação ruim altera cobertura e pesos diagnósticos, mas não melhora ordenação', () => {
    const a = candidate('Vegano Brooks', 3000);
    const b = candidate('Veggie Burger', 2000);
    a.listing.merchant.rating.value = present(1);
    b.listing.merchant.rating.value = present(5);
    const before = order([a, b]);
    a.listing.merchant.rating = { value: ABSENT, rawValue: ABSENT, count: ABSENT };
    const after = order([a, b]);
    expect(ids(after)).toEqual(ids(before));
    const previous = before.recommendations[1]!;
    const rec = after.recommendations[1]!;
    expect(rec.coverage.scoredCount).toBe(previous.coverage.scoredCount - 1);
    expect(rec.coverage.scoredWeight).toBeCloseTo(previous.coverage.scoredWeight - 0.1);
    expect(rec.coverage.noDataCriteria).toContain('RATING');
    expect(rec.score!).toBeGreaterThan(previous.score!); // aumento diagnóstico explícito, sem subida de posição
    expect(rec.coverage.weightedFraction).toBeCloseTo(rec.coverage.scoredWeight / rec.coverage.configuredWeight, 4);
    expect(rec.criteria.find((cr) => cr.criterion === 'RATING')).toMatchObject({ effectiveWeight: 0, score: null, contribution: null, status: 'NO_DATA' });
    expect(rec.dataLimitations.join(' ')).toContain('score não ordena');
    expect(after.scoreInterpretation).toBe('RELATIVE_DIAGNOSTIC_NOT_PROBABILITY');
    expect(rec.criteria.reduce((sum, cr) => sum + (cr.contribution ?? 0), 0)).toBeCloseTo(rec.score!, 3);
  });

  it('remover menção desfavorável não aumenta a contagem de preferências atendidas', () => {
    const a = candidate('Vegano Brooks');
    const b = candidate('Veggie Burger');
    a.detail!.itemDescription = present('com arroz e bacon');
    const prefs = { priority: 'ECONOMY' as const, likedIngredients: ['arroz'], avoidedIngredients: ['bacon'] };
    const before = rankCandidates([a, b], prefs);
    a.detail!.itemDescription = present('com arroz');
    const after = rankCandidates([a, b], prefs);
    expect(ids(after)).toEqual(ids(before));
    expect(after.recommendations.find((rec) => rec.itemId === a.evaluation.itemId)!.orderingKeys.preferencesSatisfied).toBe(1);
    expect(after.recommendations.find((rec) => rec.itemId === a.evaluation.itemId)!.dataLimitations.join(' ')).toContain('NO_DATA');
  });

  it('D: desconhecido + NOT_DETAILED é BLOCKED em qualquer ordem, motivos intactos', () => {
    const reasons = [{ code: 'NEW_BLOCKER', message: 'novo motivo' }, { code: 'NOT_DETAILED', message: 'sem detalhe' }];
    expect(classifyBlockers(reasons)).toBe('BLOCKED');
    expect(classifyBlockers([...reasons].reverse())).toBe('BLOCKED');
    expect(reasons).toEqual([{ code: 'NEW_BLOCKER', message: 'novo motivo' }, { code: 'NOT_DETAILED', message: 'sem detalhe' }]);
    expect(classifyBlockers([{ code: 'NOT_DETAILED' }, { code: 'ALLERGY_UNVERIFIED' }])).toBe('NEEDS_VERIFICATION');
    expect(classifyBlockers([{ code: 'RESTRICTION_FAIL' }, { code: 'NOT_DETAILED' }])).toBe('BLOCKED');
  });

  it.each(['PRICE_UNVERIFIED', 'CONFIG_UNVERIFIED', 'AVAILABILITY_UNKNOWN', 'LIMIT_MAXDELIVERYTIMEMINUTES_UNVERIFIED', 'LIMIT_MAXDELIVERYFEE_UNVERIFIED'])('DOM-01 %s é pendência conhecida, não incompatibilidade', (code) => {
    expect(classifyBlockers([{ code }])).toBe('NEEDS_VERIFICATION');
    expect(classifyBlockers([{ code }, { code: 'NEW_BLOCKER' }])).toBe('BLOCKED');
  });

  it('F: zero/uma opção elegível não preenche lista com bloqueados ou pendentes', () => {
    const good = candidate('Vegano Brooks');
    const blocked = candidate('Veggie Burger', 1000, 0, 60, { constraints: { restrictions: [], mandatoryLimits: { maxDeliveryTimeMinutes: 30 } } });
    const pending = candidate('Maria salada Veg', 1000, 0, null, { constraints: { restrictions: [], mandatoryLimits: { maxDeliveryTimeMinutes: 30 } } });
    expect(order([blocked, pending]).recommendations).toEqual([]);
    expect(ids(order([blocked, good, pending]))).toEqual([good.evaluation.itemId]);
    expect(order([blocked, pending]).eligibleConsidered).toBe(0);
  });

  it('nenhum critério conhecido mantém score null e cobertura zero sem inventar evidência', () => {
    const a = candidate('Vegano Brooks', 1000, null, null, { catalog: true });
    a.listing.merchant.rating = { value: ABSENT, rawValue: ABSENT, count: ABSENT };
    const rec = order([a]).recommendations[0]!;
    expect(rec.score).toBeNull();
    expect(rec.coverage).toMatchObject({ scoredCount: 0, totalCount: 5, weightedFraction: 0, scoredWeight: 0 });
    expect(rec.coverage.noDataCriteria).toHaveLength(5);
  });

  it('H: mesmas entradas e permutações empatadas têm mesma saída, por IDs', () => {
    const cs = [candidate('Vegano Brooks'), candidate('Veggie Burger'), candidate('Maria salada Veg')];
    const before = structuredClone(cs);
    expect(order(cs)).toEqual(order(cs));
    expect(order([...cs].reverse())).toEqual(order(cs));
    expect(cs).toEqual(before);
  });
});
