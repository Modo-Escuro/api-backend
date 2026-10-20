// HTTP real em memória, pipeline com mocks/fixtures offline; sem OAuth ou MCP remoto.
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { EvaluateResponseSchema } from '../../src/server/contracts/evaluate';
import { classifyBlockers, rankCandidates } from '../../src/server/domain/ranking';
import { registerEvaluate } from '../../src/server/routes/evaluate';
import { runEvaluation, type EvaluateOutcome } from '../../src/server/services/evaluate';
import { fake, fx } from './fakes';
import { completeSyntheticEstimate } from '../helpers/ranking';

function app(transform: (outcome: EvaluateOutcome) => void = () => {}) {
  const api = new Hono();
  registerEvaluate(api, async (_ctx, request) => {
    const deps = fake({ pages: [fx('searchOffers-hamburguer-vegan.json')] });
    const outcome = await runEvaluation(request, deps);
    transform(outcome);
    return outcome;
  });
  return api;
}

async function evaluate(api: Hono, body: Record<string, unknown> = {}) {
  const response = await api.request('/api/evaluate', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: 'hamburguer', preferences: { priority: 'ECONOMY' }, ...body }),
  });
  expect(response.status).toBe(200);
  const json = await response.json();
  return EvaluateResponseSchema.parse(json);
}

describe('RANK-03 E — contrato HTTP versionado', () => {
  it('estimativa completa SINTÉTICA mantém os mesmos centavos nas chaves, componentes e preço HTTP', async () => {
    const body = await evaluate(app((outcome) => {
      const candidates = outcome.candidates.map((c) => ({ evaluation: c.evaluation, listing: c.listing,
        detail: c.detail.status === 'DETAILED' ? c.detail.detail : null }));
      for (const c of candidates) {
        const p = c.evaluation.pricing.selected ?? c.evaluation.pricing.minimumConfigurable;
        if (c.evaluation.eligible && p?.status === 'ESTIMATED' && p.delivery.fee !== null) completeSyntheticEstimate(c, 123);
      }
      outcome.ranking = rankCandidates(candidates, { priority: 'ECONOMY' });
    }));
    const rec = body.recommendations.find((c) => c.ranking.orderingKeys.estimatedTotalCents !== null)!;
    expect(rec).toBeDefined();
    const price = rec.pricing.selected ?? rec.pricing.minimumConfigurable!;
    expect(price.service).toEqual({ feeCents: 123, status: 'KNOWN' });
    expect(rec.ranking.orderingKeys.estimatedTotalCents).toBe(price.estimatedTotalCents);
    expect(price.estimatedTotalRange).toEqual({ minCents: price.estimatedTotalCents, maxCents: price.estimatedTotalCents });
    expect(price.estimatedTotalCents).toBe(price.itemsAndDeliverySubtotalCents! + 123);
    expect(price.status).toBe('ESTIMATED');
  });

  it('schema rejeita versão diferente e dinheiro fracionário', async () => {
    const body = await evaluate(app());
    expect(EvaluateResponseSchema.safeParse({ ...body, contractVersion: '1.0' }).success).toBe(false);
    body.recommendations[0]!.ranking.orderingKeys.estimatedTotalCents = 1.5;
    expect(EvaluateResponseSchema.safeParse(body).success).toBe(false);
  });

  it('2.0 conserva categorias, motivos, pesos, cobertura, chaves e dinheiro em centavos', async () => {
    const body = await evaluate(app());
    expect(body.contractVersion).toBe('2.0');
    expect(body.ranking).toMatchObject({ contractVersion: '2.0', status: 'RANKED', orderingPolicy: 'DEC_01_D9',
      scoreInterpretation: 'RELATIVE_DIAGNOSTIC_NOT_PROBABILITY', missingDataPolicy: 'UNKNOWN_LAST_SCORE_DIAGNOSTIC_ONLY',
      weights: { PRICE: 0.4, DELIVERY: 0.1 }, clarification: null });
    expect(body.money).toEqual({ currency: 'BRL', unit: 'CENTS' });
    expect(body.recommendations.length).toBeGreaterThan(0);
    for (const rec of body.recommendations) {
      expect(rec.category).toBe('ELIGIBLE');
      expect(rec.blockers).toEqual([]);
      expect(rec.ranking.coverage.scoredCount + rec.ranking.coverage.noDataCriteria.length).toBe(5);
      expect(rec.ranking.coverage.noDataCriteria).toContain('PRICE');
      const price = rec.pricing.selected ?? rec.pricing.minimumConfigurable!;
      expect(price.service).toEqual({ feeCents: null, status: 'UNKNOWN' });
      expect(price.estimatedTotalCents).toBeNull();
      expect(price.estimatedTotalRange.maxCents).toBeNull();
      expect(rec.ranking.orderingKeys.estimatedTotalCents).toBeNull();
      for (const cr of rec.ranking.criteria) {
        if (cr.status === 'NO_DATA') expect(cr).toMatchObject({ score: null, effectiveWeight: 0, contribution: null });
      }
      expect(rec.ranking.dataLimitations.join(' ')).toContain('subtotal parcial');
    }
    for (const rec of body.needsVerification) {
      expect(rec.category).toBe('NEEDS_VERIFICATION');
      expect(rec.eligible).toBe(false);
      expect(rec.blockers.length).toBeGreaterThan(0);
    }
    const maria = body.eligible.find((c) => c.itemId === 'c29bfc17-0c56-4925-9298-93c946c39075')!;
    expect(maria.pricing.minimumConfigurable!.unitTotalCents).toBe(2990); // nenhuma conversão dupla
    expect(JSON.stringify(body)).not.toMatch(/"(unitTotal|estimatedTotal|basePrice|unitPrice|fee|amount|itemsSubtotal)":/);
    expect(body.summary.eligible + body.summary.blocked + body.summary.needsVerification).toBe(body.summary.candidates);
  });

  it('D: código desconhecido com NOT_DETAILED preserva todos os motivos no bucket BLOCKED', async () => {
    const body = await evaluate(app((outcome) => {
      const c = outcome.candidates.find((candidate) => candidate.category === 'NEEDS_VERIFICATION')!;
      expect(c.evaluation.blockers.map((b) => b.code)).toContain('NOT_DETAILED');
      c.evaluation.blockers.push({ code: 'FUTURE_BLOCKER', message: 'Diagnóstico sintético desconhecido' });
      c.category = classifyBlockers(c.evaluation.blockers);
    }));
    const unknown = body.blocked.find((c) => c.blockers.some((b) => b.code === 'FUTURE_BLOCKER'))!;
    expect(unknown.category).toBe('BLOCKED');
    expect(unknown.blockers).toEqual(expect.arrayContaining([
      { code: 'FUTURE_BLOCKER', message: 'Diagnóstico sintético desconhecido' },
      { code: 'NOT_DETAILED', message: expect.any(String) },
    ]));
    expect(body.recommendations.some((rec) => rec.itemId === unknown.itemId)).toBe(false);
    expect(body.summary.blockerCounts.FUTURE_BLOCKER).toBe(1);
    expect(body.summary.blockerCounts.NOT_DETAILED).toBeGreaterThan(0);
  });

  it('G: alergia não verificada e orçamento completo UNKNOWN continuam pendentes, não recomendados', async () => {
    const allergy = await evaluate(app(), { restrictions: [{ kind: 'ALLERGY', code: 'PEANUT' }] });
    expect(allergy.recommendations).toEqual([]);
    expect(allergy.needsVerification.some((c) => c.blockers.some((b) => b.code === 'ALLERGY_UNVERIFIED'))).toBe(true);
    const budget = await evaluate(app(), { budget: { maxOrderTotalCents: 100000 } });
    expect(budget.recommendations).toEqual([]);
    expect(budget.needsVerification.some((c) => c.blockers.some((b) => b.code === 'ORDER_BUDGET_UNVERIFIED'))).toBe(true);
  });

  it('sem prioridade, cliente recebe esclarecimento e todos os buckets de diagnóstico', async () => {
    const body = await evaluate(app(), { preferences: {} });
    expect(body.ranking.status).toBe('PRIORITY_REQUIRED');
    expect(body.ranking.clarification).toContain('ECONOMY');
    expect(body.recommendations).toEqual([]);
    expect(body.eligible.length).toBeGreaterThan(0);
    expect(body.needsVerification.length).toBeGreaterThan(0);
  });

  it('F: zero/uma opção elegível não são completadas com pendentes no HTTP', async () => {
    for (const keep of [0, 1]) {
      const body = await evaluate(app((outcome) => {
        let eligibleKept = 0;
        for (const c of outcome.candidates) {
          if (c.category === 'ELIGIBLE' && eligibleKept++ >= keep) {
            c.evaluation.blockers.push({ code: 'ALLERGY_UNVERIFIED', message: 'Pendência sintética para testar cardinalidade' });
            c.evaluation.eligible = false;
            c.category = classifyBlockers(c.evaluation.blockers);
          }
        }
        outcome.ranking = rankCandidates(outcome.candidates.map((c) => ({ listing: c.listing, evaluation: c.evaluation,
          detail: c.detail.status === 'DETAILED' ? c.detail.detail : null })), { priority: 'ECONOMY' });
      }));
      expect(body.recommendations).toHaveLength(keep);
      expect(body.eligible).toHaveLength(keep);
      expect(body.needsVerification.length).toBeGreaterThan(0);
    }
  });

  it('alvos flexíveis pontuam CONTEXT; limites rígidos ficam na elegibilidade, sem duplicar frete', async () => {
    const soft = await evaluate(app(), { softLimits: { maxDeliveryTimeMinutes: 30 } });
    expect(soft.recommendations.some((rec) => rec.ranking.criteria.find((cr) => cr.criterion === 'CONTEXT')!.status === 'SCORED')).toBe(true);
    const hard = await evaluate(app(), { refinements: { maxDeliveryTimeMinutes: 1 } });
    expect(hard.recommendations).toEqual([]);
    expect(hard.blocked.some((c) => c.blockers.some((b) => b.code === 'LIMIT_MAXDELIVERYTIMEMINUTES_EXCEEDED'))).toBe(true);
  });
});
