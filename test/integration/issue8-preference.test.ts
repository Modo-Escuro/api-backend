// Issue #8 — preferência (restriction com requirement PREFERENCE ou objeto preferences) no pipeline:
// nunca vira filtro de busca e nunca altera elegibilidade/buckets. Fixtures reais, sem rede.
import { describe, expect, it } from 'vitest';
import { runEvaluation } from '../../src/server/services/evaluate';
import { evaluateView } from '../../src/server/services/evaluate-view';
import { fake, fx } from './fakes';

const hamburger = () => fake({ pages: [fx('searchOffers-hamburguer-vegan.json')] });
const byId = (xs: { itemId: string }[]) => new Set(xs.map((x) => x.itemId));

describe('issue #8 — preferência no pipeline /api/evaluate', () => {
  it('C/E: VEGAN como PREFERENCE não filtra a busca nem altera os buckets de elegibilidade', async () => {
    const base = evaluateView(await runEvaluation({ query: 'hamburguer', restrictions: [] }, hamburger()));
    const deps = hamburger();
    const pref = evaluateView(
      await runEvaluation({ query: 'hamburguer', restrictions: [{ kind: 'DIETARY', code: 'VEGAN', requirement: 'PREFERENCE' }] }, deps),
    );

    // Caso E: preferência nunca vira itemRestrictions no searchOffers
    expect(deps.searchCalls[0]!.refinements?.itemRestrictions ?? []).toEqual([]);

    // Caso C: mesma elegibilidade e mesmo conteúdo dos buckets
    expect(byId(pref.eligible)).toEqual(byId(base.eligible));
    expect(byId(pref.blocked)).toEqual(byId(base.blocked));
    expect(byId(pref.needsVerification)).toEqual(byId(base.needsVerification));
    expect(pref.summary.eligible).toBe(base.summary.eligible);
  });

  it('C: objeto preferences (F4) também nunca altera elegibilidade/buckets', async () => {
    const base = evaluateView(await runEvaluation({ query: 'hamburguer', restrictions: [] }, hamburger()));
    const pref = evaluateView(
      await runEvaluation(
        { query: 'hamburguer', restrictions: [], preferences: { foodTypes: ['vegano'], avoidedIngredients: ['alface'] } },
        hamburger(),
      ),
    );
    expect(byId(pref.eligible)).toEqual(byId(base.eligible));
    expect(byId(pref.blocked)).toEqual(byId(base.blocked));
    expect(byId(pref.needsVerification)).toEqual(byId(base.needsVerification));
  });
});
