// F4 — integração do ranking no pipeline /api/evaluate (fixtures reais, sem rede):
// recomendações ranqueadas só de ELIGIBLE, buckets separados e contrato em centavos intacto.
import { describe, expect, it } from 'vitest';
import { runEvaluation } from '../../src/server/services/evaluate';
import { evaluateView } from '../../src/server/services/evaluate-view';
import { evaluateViewCents } from '../../src/server/services/cents';
import { fake, fx } from './fakes';

const hamburger = () => fake({ pages: [fx('searchOffers-hamburguer-vegan.json')] });
const byId = (list: { itemId: string }[]) => new Set(list.map((x) => x.itemId));

describe('ranking no pipeline /api/evaluate (fixtures reais)', () => {
  it('ordena até 4 recomendações elegíveis com score, critérios, motivos e limitações', async () => {
    const v = evaluateView(await runEvaluation({ query: 'hamburguer', restrictions: [] }, hamburger()));
    expect(v.summary.eligible).toBeGreaterThanOrEqual(3);
    expect(v.summary.recommendations).toBe(Math.min(4, v.summary.eligible));
    expect(v.recommendations).toHaveLength(v.summary.recommendations);

    const eligibleIds = byId(v.eligible);
    const excludedIds = byId([...v.blocked, ...v.needsVerification]);
    const scores: number[] = [];
    for (const [i, r] of v.recommendations.entries()) {
      expect(r.eligible).toBe(true);
      expect(r.restrictions.every((x) => !x.blocking)).toBe(true);
      expect(eligibleIds.has(r.itemId)).toBe(true);
      expect(excludedIds.has(r.itemId)).toBe(false); // bloqueados/pendentes nunca viram recomendação
      expect(r.ranking.rank).toBe(i + 1);
      expect(r.ranking.score).not.toBeNull();
      scores.push(r.ranking.score!);
      expect(r.ranking.criteria.map((c) => c.criterion)).toEqual(['PREFERENCES', 'CONTEXT', 'PRICE', 'DELIVERY', 'RATING']);
      expect(r.ranking.reasons.length).toBeGreaterThan(0);
      expect(r.ranking.dataLimitations.length).toBeGreaterThan(0); // sempre diz o que faltou
      const sum = r.ranking.criteria.reduce((a, c) => a + (c.contribution ?? 0), 0);
      expect(sum).toBeCloseTo(r.ranking.score!, 3);
    }
    for (let i = 1; i < scores.length; i++) expect(scores[i - 1]).toBeGreaterThanOrEqual(scores[i]!); // ordem descrescente

    expect(v.ranking).toMatchObject({
      weights: { PREFERENCES: 0.35, CONTEXT: 0.25, PRICE: 0.2, DELIVERY: 0.1, RATING: 0.1 },
      priority: null,
      maxRecommendations: 4,
      eligibleConsidered: v.summary.eligible,
      eligibleScored: v.summary.eligible,
    });
    expect(v.ranking.notes.join(' ')).toMatch(/Pesos do ranking/);
    expect(v.summary.eligible + v.summary.blocked + v.summary.needsVerification).toBe(v.summary.candidates);
  });

  it('preferências mudam a pontuação e a ordem, mas nunca a elegibilidade', async () => {
    const base = evaluateView(await runEvaluation({ query: 'hamburguer', restrictions: [] }, hamburger()));
    const deps = hamburger();
    const prefs = evaluateView(
      await runEvaluation({ query: 'hamburguer', restrictions: [], preferences: { likedIngredients: ['kibe'] } }, deps),
    );

    // Preferência nunca vira filtro obrigatório no iFood.
    expect(deps.searchCalls[0]!.refinements).not.toMatchObject({ itemRestrictions: ['KIBE'] });
    expect(deps.searchCalls[0]!.refinements?.itemRestrictions ?? []).toEqual([]);

    // Mesma elegibilidade, mesmo conteúdo dos buckets: só a pontuação muda.
    expect(prefs.eligible.map((c) => c.itemId)).toEqual(base.eligible.map((c) => c.itemId));
    expect(prefs.blocked.map((c) => c.itemId)).toEqual(base.blocked.map((c) => c.itemId));
    expect(prefs.needsVerification.map((c) => c.itemId)).toEqual(base.needsVerification.map((c) => c.itemId));
    expect(prefs.summary).toMatchObject({ eligible: base.summary.eligible, blocked: base.summary.blocked, needsVerification: base.summary.needsVerification });

    const brooks = base.eligible.find((c) => c.item.name === 'Vegano Brooks')!;
    const prefCriterion = (v: typeof base, id: string) => v.recommendations.find((r) => r.itemId === id)!.ranking.criteria.find((c) => c.criterion === 'PREFERENCES')!;

    const baseScore = prefCriterion(base, brooks.itemId);
    const newScore = prefCriterion(prefs, brooks.itemId);
    expect(baseScore.status).toBe('NO_DATA'); // nenhuma preferência informada ⇒ sem nota
    expect(newScore).toMatchObject({ status: 'SCORED', score: 1 });
    expect(newScore.reasons.join(' ')).toMatch(/kibe/);
    expect(prefs.recommendations.find((r) => r.itemId === brooks.itemId)!.ranking.score!).toBeGreaterThan(base.recommendations.find((r) => r.itemId === brooks.itemId)!.ranking.score!);

    // Nada que não seja elegível aparece em recommendations.
    const notEligible = byId([...prefs.blocked, ...prefs.needsVerification]);
    expect(prefs.recommendations.some((r) => notEligible.has(r.itemId))).toBe(false);
    expect(prefs.summary.recommendations).toBe(prefs.recommendations.length);
  });

  it('sem candidato elegível: recommendations [] com a explicação registrada', async () => {
    const deps = fake({ pages: [{ ...fx('searchOffers-lanche-glutenfree.json'), hasMore: false, nextPageToken: undefined }] });
    const v = evaluateView(await runEvaluation({ query: 'lanche', restrictions: [{ kind: 'ALLERGY', code: 'GLUTEN' }] }, deps));
    expect(v.summary).toMatchObject({ eligible: 0, recommendations: 0 });
    expect(v.recommendations).toEqual([]);
    expect(v.eligible).toEqual([]);
    expect(v.summary.eligible + v.summary.blocked + v.summary.needsVerification).toBe(v.summary.candidates);
    expect(v.summary.blocked + v.summary.needsVerification).toBe(v.summary.candidates);
    expect(v.ranking.eligibleScored).toBe(0);
    expect(v.ranking.notes.join(' ')).toMatch(/Nenhuma opção pôde ser confirmada como compatível/);
    expect(v.notes.join(' ')).toMatch(/Nenhuma opção pôde ser confirmada/);
    expect(v.serverFilters).toEqual(['GLUTEN_FREE']);
    for (const c of [...v.blocked, ...v.needsVerification]) expect(c.item.name).toBe('Veggie Burger');
  });

  it('pendentes de verificação (sem getItem) ficam fora das recomendações', async () => {
    const deps = fake({ pages: [{ ...fx('searchOffers-acai.json'), hasMore: false, nextPageToken: undefined }] });
    const v = evaluateView(await runEvaluation({ query: 'açai', restrictions: [] }, deps));
    expect(v.summary.needsVerification).toBeGreaterThan(0); // busca traz mais itens do que há detalhe
    expect(v.recommendations.length).toBe(Math.min(4, v.summary.eligible));
    const excluded = byId([...v.blocked, ...v.needsVerification]);
    for (const r of v.recommendations) expect(excluded.has(r.itemId)).toBe(false);
    for (const c of v.needsVerification) expect(c.eligible).toBe(false);
    expect(byId([...v.eligible, ...v.blocked, ...v.needsVerification]).size).toBe(v.summary.candidates);
  });

  it('saída em centavos preserva o ranking e não deixa dinheiro decimal escapar', async () => {
    const v = evaluateView(await runEvaluation({ query: 'hamburguer', restrictions: [] }, hamburger()));
    const c = evaluateViewCents(v);
    expect(c.money).toEqual({ currency: 'BRL', unit: 'CENTS' });
    expect(c.recommendations).toHaveLength(v.recommendations.length);

    for (const [i, r] of c.recommendations.entries()) {
      expect(r.ranking).toEqual(v.recommendations[i]!.ranking); // ranking (sem dinheiro) passa intacto
      const p = r.pricing.minimumConfigurable!;
      expect(Number.isInteger(p.unitTotalCents)).toBe(true);
      expect(Number.isInteger(p.unitTotalRange.minCents)).toBe(true);
      expect(p.estimatedTotalRange.maxCents).toBeNull(); // serviço desconhecido impede teto completo
      expect(Number.isInteger(p.estimatedTotalRange.minCents)).toBe(true);
    }
    for (const r of [...c.eligible, ...c.blocked, ...c.needsVerification]) expect(r.pricing.confirmedTotalCents).toBeNull();

    const json = JSON.stringify(c);
    // Nenhuma chave escalar de dinheiro decimal sobra (containers como estimatedTotalRange têm *Cents dentro).
    expect(json).not.toMatch(/"(unitTotal|estimatedTotal|listPrice|basePrice|unitPrice|fee|amount|itemsSubtotal)":/);
    expect(json).toMatch(/"unitTotalCents"/);
  });
});
