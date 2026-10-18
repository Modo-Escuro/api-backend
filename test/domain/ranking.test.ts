// F4 — classificação de elegibilidade + ranking explicável (domain/ranking.ts).
// Candidatos vêm de fixtures REAIS de getItem/searchOffers; preço e dados de loja são controlados
// pelo teste para isolar um critério por vez. Só funções puras: sem rede, sem relógio.
import { describe, expect, it } from 'vitest';
import type { RestrictionKey } from '../../src/server/domain/constraints';
import { ABSENT, present } from '../../src/server/domain/fields';
import { evaluateCandidate, type Budget } from '../../src/server/domain/eligibility';
import { normalizePromotion } from '../../src/server/domain/normalize';
import {
  CRITERIA,
  DEFAULT_WEIGHTS,
  MAX_RECOMMENDATIONS,
  classifyBlockers,
  rankCandidates as rankWithDeclaredPriority,
  weightsFor,
  type RankCandidate,
} from '../../src/server/domain/ranking';
import type { ItemRestriction } from '../../src/server/mcp/types';
import { item, listingFor } from './helpers';
import { completeSyntheticEstimate } from '../helpers/ranking';

// Estes cenários de critérios declaram economia; ausência/ambiguidade é testada em rank03.test.ts.
const rankCandidates: typeof rankWithDeclaredPriority = (cs, prefs, context, constraints) =>
  rankWithDeclaredPriority(cs, { priority: 'ECONOMY', ...prefs }, context, constraints);

interface CandidateOpts {
  /** Preço por unidade sintético (zera optionGroups ⇒ preço fixo, sem faixa). */
  price?: number;
  /** Igualiza rating/distância/entrega entre candidatos (isola o critério preço). */
  equalize?: boolean;
  /** Remove a avaliação do estabelecimento (caminho NO_DATA de RATING). */
  dropRating?: boolean;
  restrictions?: RestrictionKey[];
  budget?: Budget;
  serverFilters?: ItemRestriction[];
}

function candidate(name: string, opts: CandidateOpts = {}): RankCandidate {
  const d = item(name);
  const l = listingFor(d.itemId);
  if (opts.price !== undefined) {
    const promo = normalizePromotion({ unitPrice: opts.price });
    d.price = promo;
    l.price = promo; // listagem coerente com o detalhe (evita aviso LISTING_PRICE_DIFFERS)
    d.optionGroups = present([]); // sem opções obrigatórias ⇒ unitTotal === preço-base
  }
  if (opts.equalize) {
    l.merchant.rating = { value: present(4.5), rawValue: present(4.5), count: present(100) };
    l.merchant.distanceKm = present(1);
    l.merchant.delivery = present({
      deliveryMethodId: present('DEFAULT'),
      mode: present('DELIVERY'),
      fee: present(490),
      promotionalFee: present(490),
      effectiveFee: 490,
      etaMinutes: { min: present(30), max: present(30) },
    });
  }
  if (opts.dropRating) l.merchant.rating = { value: ABSENT, rawValue: ABSENT, count: ABSENT };
  const evaluation = evaluateCandidate({ listing: l, detail: d, serverFilters: opts.serverFilters ?? [] }, { restrictions: opts.restrictions ?? [], budget: opts.budget });
  const result = { evaluation, listing: l, detail: d };
  return opts.price === undefined ? result : completeSyntheticEstimate(result);
}

const ids = (r: ReturnType<typeof rankCandidates>) => r.recommendations.map((x) => x.itemId);
const category = (c: RankCandidate) => classifyBlockers(c.evaluation.blockers);

describe('classifyBlockers — segurança alimentar antes de qualquer pontuação', () => {
  it('1. produto com ingrediente incompatível com a alergia é BLOCKED e nunca entra no ranking', () => {
    const c = candidate('Açaí + Morango e Leite Condensado', { restrictions: [{ kind: 'ALLERGY', code: 'MILK' }] });
    expect(c.evaluation.blockers.map((b) => b.code)).toContain('RESTRICTION_FAIL');
    expect(category(c)).toBe('BLOCKED');
    expect(rankCandidates([c]).recommendations).toEqual([]); // defesa em profundidade
  });

  it('2. alérgeno não verificável é NEEDS_VERIFICATION e fica fora das recomendações', () => {
    const unknown = candidate('Veggie Burger', { restrictions: [{ kind: 'ALLERGY', code: 'PEANUT' }] });
    expect(unknown.evaluation.blockers.map((b) => b.code)).toContain('ALLERGY_UNVERIFIED');
    expect(category(unknown)).toBe('NEEDS_VERIFICATION');

    const ok = candidate('Vegano Brooks', { price: 40, equalize: true });
    expect(category(ok)).toBe('ELIGIBLE');
    const r = rankCandidates([unknown, ok]);
    expect(ids(r)).toEqual([ok.evaluation.itemId]);
    expect(r.eligibleConsidered).toBe(1);
  });

  it('3. filtro no servidor não basta para alergia: nunca vira PASS nem "seguro"', () => {
    const c = candidate('Veggie Burger', {
      restrictions: [{ kind: 'ALLERGY', code: 'GLUTEN' }],
      serverFilters: ['GLUTEN_FREE'],
    });
    expect(c.evaluation.restrictions[0]).toMatchObject({ status: 'UNKNOWN', source: 'SERVER_FILTER_INSUFFICIENT' });
    expect(c.evaluation.eligible).toBe(false);
    expect(category(c)).toBe('NEEDS_VERIFICATION');
    expect(rankCandidates([c]).recommendations).toEqual([]);
  });

  it('4. restrição obrigatória sem informação suficiente é NEEDS_VERIFICATION, não ELIGIBLE', () => {
    const c = candidate('Açai Artesanal', { restrictions: [{ kind: 'DIETARY', code: 'VEGAN' }] });
    expect(c.evaluation.blockers.map((b) => b.code)).toContain('RESTRICTION_UNVERIFIED');
    expect(category(c)).toBe('NEEDS_VERIFICATION');
    expect(rankCandidates([c]).recommendations).toEqual([]);
  });

  it('5. acima do orçamento obrigatório é BLOCKED', () => {
    const c = candidate('Promoção pizza grande', { budget: { maxItemPrice: 6000 } }); // faixa real 65–143
    expect(c.evaluation.blockers.map((b) => b.code)).toContain('OVER_ITEM_BUDGET');
    expect(category(c)).toBe('BLOCKED');
    expect(rankCandidates([c]).recommendations).toEqual([]);
  });

  it('código de blocker desconhecido é tratado como incompatibilidade (conservador)', () => {
    expect(classifyBlockers([])).toBe('ELIGIBLE');
    expect(classifyBlockers([{ code: 'NOT_DETAILED' }])).toBe('NEEDS_VERIFICATION');
    expect(classifyBlockers([{ code: 'MERCHANT_CLOSED' }])).toBe('BLOCKED');
    expect(classifyBlockers([{ code: 'CODE_NOVO_QUALQUER' }])).toBe('BLOCKED');
    expect(classifyBlockers([{ code: 'MERCHANT_CLOSED' }, { code: 'NOT_DETAILED' }])).toBe('BLOCKED'); // incompatibilidade vence
  });
});

describe('rankCandidates — pontuação explicável', () => {
  it('6. produtos elegíveis são ordenados por total conhecido, com pontuação diagnóstica', () => {
    const expensive = candidate('Veggie Burger', { price: 50, equalize: true });
    const cheap = candidate('Vegano Brooks', { price: 30, equalize: true });
    const mid = candidate('Maria salada Veg', { price: 40, equalize: true });
    expect([expensive, cheap, mid].map(category)).toEqual(['ELIGIBLE', 'ELIGIBLE', 'ELIGIBLE']);

    // Ordem da busca: mais caro, mais barato, intermediário.
    const r = rankCandidates([expensive, cheap, mid]);
    expect(ids(r)).toEqual([cheap.evaluation.itemId, mid.evaluation.itemId, expensive.evaluation.itemId]);
    expect(r.recommendations.map((x) => x.rank)).toEqual([1, 2, 3]);

    const scores = r.recommendations.map((x) => x.score!);
    expect(scores[0]).toBeCloseTo(0.8333, 4); // total 30+4,90: peso diagnóstico PRICE 0.4, prazo/rating 0.1 cada
    expect(scores[1]).toBeCloseTo(0.5, 4);
    expect(scores[2]).toBeCloseTo(0.1666, 4); // soma das duas contribuições arredondadas a 4 casas

    for (const rec of r.recommendations) {
      expect(rec.criteria.map((c) => c.criterion)).toEqual([...CRITERIA]);
      expect(rec.reasons.length).toBeGreaterThan(0);
      const sum = rec.criteria.reduce((a, c) => a + (c.contribution ?? 0), 0);
      expect(sum).toBeCloseTo(rec.score!, 3); // contribuições fecham com o score total
      const pref = rec.criteria.find((c) => c.criterion === 'PREFERENCES')!;
      expect(pref.status).toBe('NO_DATA');
      expect(pref.score).toBeNull();
      expect(pref.effectiveWeight).toBe(0);
    }
    expect(r.eligibleConsidered).toBe(3);
    expect(r.eligibleScored).toBe(3);
    expect(r.maxRecommendations).toBe(MAX_RECOMMENDATIONS);
  });

  it('7. preferência muda o diagnóstico, mas não compensa custo total maior nem altera elegibilidade', () => {
    const brooks = candidate('Vegano Brooks', { price: 50, equalize: true }); // mais caro ⇒ último
    const maria = candidate('Maria salada Veg', { price: 40, equalize: true });
    const veggie = candidate('Veggie Burger', { price: 30, equalize: true });
    expect([brooks, maria, veggie].map(category)).toEqual(['ELIGIBLE', 'ELIGIBLE', 'ELIGIBLE']);

    const base = rankCandidates([brooks, maria, veggie]);
    expect(ids(base)).toEqual([veggie.evaluation.itemId, maria.evaluation.itemId, brooks.evaluation.itemId]);

    // "kibe" aparece só no texto do Vegano Brooks.
    const withPrefs = rankCandidates([brooks, maria, veggie], { likedIngredients: ['kibe'] });
    expect(ids(withPrefs)).toEqual(ids(base)); // D9: custo precede preferência

    const pref = withPrefs.recommendations.find((rec) => rec.itemId === brooks.evaluation.itemId)!.criteria.find((c) => c.criterion === 'PREFERENCES')!;
    expect(pref).toMatchObject({ status: 'SCORED', score: 1 });
    expect(pref.reasons.join(' ')).toMatch(/kibe/);
    // Mesma composição de candidatos: score não libera restrição nem substitui D9.
    expect(ids(withPrefs).sort()).toEqual(ids(base).sort());
    expect([brooks, maria, veggie].map(category)).toEqual(['ELIGIBLE', 'ELIGIBLE', 'ELIGIBLE']);
  });

  it('8. dado ausente não vira pontuação inventada: NO_DATA redistribui o peso', () => {
    const noRating = candidate('Vegano Brooks', { price: 30, equalize: true, dropRating: true });
    const other = candidate('Veggie Burger', { price: 50, equalize: true });
    expect([noRating, other].map(category)).toEqual(['ELIGIBLE', 'ELIGIBLE']);

    const r = rankCandidates([noRating, other]);
    const rec = r.recommendations.find((x) => x.itemId === noRating.evaluation.itemId)!;
    const rating = rec.criteria.find((c) => c.criterion === 'RATING')!;
    expect(rating).toMatchObject({ status: 'NO_DATA', score: null, contribution: null, effectiveWeight: 0 });
    expect(rating.dataLimitations.join(' ')).toMatch(/avaliação do estabelecimento não informada/);
    expect(rec.dataLimitations.join(' ')).toMatch(/critério RATING sem dado \(NO_DATA\)/);

    // (0.4×1 + 0.1×0.5) / 0.5 — redistribuição apenas diagnóstica, sem inventar nota de avaliação.
    expect(rec.score).toBeCloseTo(0.9, 3);
    expect(rec.score).not.toBeCloseTo(0.625, 2);
    expect(rec.score).not.toBeNull();
    expect(r.eligibleScored).toBe(2);
  });

  it('9. prioridade do usuário dobra um critério e é exposta no resultado', () => {
    const a = candidate('Vegano Brooks', { price: 30, equalize: true });
    const b = candidate('Veggie Burger', { price: 50, equalize: true });
    const r = rankCandidates([a, b], { priority: 'ECONOMY' });
    expect(r.priority).toBe('ECONOMY');
    expect(r.weights).toEqual({ ...DEFAULT_WEIGHTS, PRICE: 0.4 });
    expect(r.notes.join(' ')).toMatch(/prioridade ECONOMY dobra o peso de PRICE/);
    expect(r.recommendations[0]!.itemId).toBe(a.evaluation.itemId); // mais barato vence
    expect(r.recommendations[0]!.criteria.find((c) => c.criterion === 'PRICE')!.weight).toBe(0.4);
  });

  it('10. empates geram ordenação determinística (mesma entrada ⇒ mesma saída)', () => {
    const a = candidate('Vegano Brooks', { price: 40, equalize: true });
    const b = candidate('Veggie Burger', { price: 40, equalize: true });
    const c = candidate('Maria salada Veg', { price: 40, equalize: true });
    const input = [a, b, c];

    const r1 = rankCandidates(input);
    const r2 = rankCandidates(input);
    expect(ids(r1)).toEqual(ids(r2));
    expect(r1.recommendations).toEqual(r2.recommendations);
    expect(r1.recommendations.map((x) => x.score)).toEqual([0.5, 0.5, 0.5]); // empate real
    const orderedIds = [...input].sort((x, y) => x.evaluation.merchantId < y.evaluation.merchantId ? -1 : x.evaluation.merchantId > y.evaluation.merchantId ? 1 : x.evaluation.itemId < y.evaluation.itemId ? -1 : 1).map((x) => x.evaluation.itemId);
    expect(ids(r1)).toEqual(orderedIds); // D9: IDs, não ordem da busca
    expect(rankCandidates([c, b, a])).toEqual(rankCandidates([c, b, a]));
    expect(ids(rankCandidates([c, b, a]))).toEqual(orderedIds);
  });

  it('respeita o limite de 4 recomendações, sempre na melhor ordem', () => {
    const cs = [
      candidate('Vegano Brooks', { price: 30, equalize: true }),
      candidate('Veggie Burger', { price: 50, equalize: true }),
      candidate('Maria salada Veg', { price: 40, equalize: true }),
      candidate('Veggie Três Marias Fest burguer', { price: 35, equalize: true }),
      candidate('Açai Artesanal', { price: 45, equalize: true }),
    ];
    expect(cs.map(category)).toEqual(['ELIGIBLE', 'ELIGIBLE', 'ELIGIBLE', 'ELIGIBLE', 'ELIGIBLE']);
    const r = rankCandidates(cs);
    expect(r.recommendations).toHaveLength(MAX_RECOMMENDATIONS);
    expect(r.recommendations.map((x) => x.rank)).toEqual([1, 2, 3, 4]);
    expect(ids(r)).toEqual([cs[0]!.evaluation.itemId, cs[3]!.evaluation.itemId, cs[2]!.evaluation.itemId, cs[4]!.evaluation.itemId]);
    expect(r.eligibleConsidered).toBe(5); // o 5º fica fora só por ter menos pontos
  });

  it('sem candidato elegível: sem recomendação e com explicação registrada', () => {
    const r = rankCandidates([candidate('Açai Artesanal', { restrictions: [{ kind: 'DIETARY', code: 'VEGAN' }] })]);
    expect(r.recommendations).toEqual([]);
    expect(r.eligibleScored).toBe(0);
    expect(r.notes.join(' ')).toMatch(/Nenhuma opção pôde ser confirmada como compatível/);
  });
});

describe('pesos', () => {
  it('pesos padrão somam 100% e prioridade dobra exatamente um critério', () => {
    expect(DEFAULT_WEIGHTS).toEqual({ PREFERENCES: 0.35, CONTEXT: 0.25, PRICE: 0.2, DELIVERY: 0.1, RATING: 0.1 });
    expect(Object.values(DEFAULT_WEIGHTS).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    expect(weightsFor('ECONOMY')).toEqual({ ...DEFAULT_WEIGHTS, PRICE: 0.4 });
    expect(weightsFor('SPEED')).toEqual({ ...DEFAULT_WEIGHTS, DELIVERY: 0.2 });
    expect(weightsFor('PREFERENCES')).toEqual({ ...DEFAULT_WEIGHTS, PREFERENCES: 0.7 });
    expect(weightsFor()).toEqual(DEFAULT_WEIGHTS);
  });
});
