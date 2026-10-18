// Issue #9 (RANK-02) — pipeline /api/evaluate: preferências pontuam só a configuração avaliada.
// Fixtures reais de searchOffers/getItem, sem rede. O contrato HTTP (centavos) não muda:
// a configuração alternativa fica no domínio; a view expõe apenas motivos/limitações já existentes.
import { describe, expect, it } from 'vitest';
import { runEvaluation } from '../../src/server/services/evaluate';
import { evaluateView } from '../../src/server/services/evaluate-view';
import { evaluateViewCents } from '../../src/server/services/cents';
import { fake, fx, ITEMS } from './fakes';

const hamburger = () => fake({ pages: [fx('searchOffers-hamburguer-vegan.json')] });
const prefCriterion = (v: ReturnType<typeof evaluateView>, name: string) =>
  v.recommendations.find((r) => r.item.name === name)!.ranking.criteria.find((c) => c.criterion === 'PREFERENCES')!;

describe('issue #9 no pipeline /api/evaluate (fixtures reais)', () => {
  it('Caso A: bacon só em adicional não selecionado não pontua — limitação explícita e alternativa revalidada nos motivos', async () => {
    const v = evaluateView(await runEvaluation({ query: 'hamburguer', restrictions: [], preferences: { likedIngredients: ['bacon'] } }, hamburger()));
    const pref = prefCriterion(v, 'Maria salada Veg'); // "Bacon crocante vegano" é adicional disponível, não escolhido
    expect(pref).toMatchObject({ status: 'SCORED', score: 0 });
    expect(pref.reasons.join(' ')).not.toMatch(/menciona "bacon"/);
    expect(pref.dataLimitations.join(' ')).toMatch(/não selecionado/);

    const rec = v.recommendations.find((r) => r.item.name === 'Maria salada Veg')!;
    expect(rec.ranking.reasons.join(' ')).toMatch(/configuração alternativa revalidada/);
    expect(rec.ranking.reasons.join(' ')).toMatch(/não aplicada/);
  });

  it('Caso B: item cujo item-base afirma bacon pontua (mesmo sem bacon selecionado na configuração)', async () => {
    // Sobrescreve a descrição do getItem de um item detalhado (restaurado ao final do teste).
    const id = 'c29bfc17-0c56-4925-9298-93c946c39075'; // Maria salada Veg
    const original = ITEMS.get(id)!;
    ITEMS.set(id, { ...structuredClone(original) as Record<string, unknown>, itemDescription: 'Hambúrguer vegano com bacon crocante e rúcula' });
    try {
      const v = evaluateView(await runEvaluation({ query: 'hamburguer', restrictions: [], preferences: { likedIngredients: ['bacon'] } }, hamburger()));
      const pref = prefCriterion(v, 'Maria salada Veg');
      expect(pref).toMatchObject({ status: 'SCORED', score: 1 });
      expect(pref.reasons.join(' ')).toMatch(/configuração avaliada menciona "bacon"/);
    } finally {
      ITEMS.set(id, original);
    }
  });

  it('Caso C: negação no texto ("sem ...") não vira presença afirmada', async () => {
    const v = evaluateView(await runEvaluation({ query: 'hamburguer', restrictions: [], preferences: { likedIngredients: ['lactose'] } }, hamburger()));
    // Veggie Burger: "Pão sem glúten e sem lactose, ..."
    const pref = prefCriterion(v, 'Veggie Burger');
    expect(pref.score).toBe(0);
    expect(pref.reasons.join(' ')).toMatch(/menção negativa de "lactose"/);
    expect(pref.reasons.join(' ')).not.toMatch(/menciona "lactose"/);
  });

  it('Caso D: evitado sem evidência textual vira NO_DATA (nunca nota máxima 1)', async () => {
    const v = evaluateView(await runEvaluation({ query: 'hamburguer', restrictions: [], preferences: { avoidedIngredients: ['bacon'] } }, hamburger()));
    const pref = prefCriterion(v, 'Veggie Burger'); // sem bacon em nome/descrição e sem optionGroups
    expect(pref).toMatchObject({ status: 'NO_DATA', score: null });
    expect(pref.dataLimitations.join(' ')).toMatch(/NO_DATA/);
    expect(pref.dataLimitations.join(' ')).toMatch(/ausência do termo não prova ausência/);
  });

  it('Caso E: nome da loja não conta como ingrediente', async () => {
    const v = evaluateView(await runEvaluation({ query: 'hamburguer', restrictions: [], preferences: { likedIngredients: ['bacon'] } }, hamburger()));
    // Nenhum item ganha bônus só por causa do nome do estabelecimento ("Três Marias Burger & Beer", "HAMBURGUERIA BROOKS"...).
    for (const rec of v.recommendations) {
      const pref = rec.ranking.criteria.find((c) => c.criterion === 'PREFERENCES')!;
      for (const r of pref.reasons) expect(r).not.toMatch(/loja|estabelecimento/i);
    }
  });

  it('Caso H (regressão issue #8): preferência PREFERENCE continua pontuando e nunca altera elegibilidade', async () => {
    const base = evaluateView(await runEvaluation({ query: 'hamburguer', restrictions: [] }, hamburger()));
    const deps = hamburger();
    const withPref = evaluateView(
      await runEvaluation({ query: 'hamburguer', restrictions: [{ kind: 'DIETARY', code: 'VEGAN', requirement: 'PREFERENCE' }] }, deps),
    );
    // Preferência nunca vira filtro obrigatório no iFood.
    expect(deps.searchCalls[0]!.refinements?.itemRestrictions ?? []).toEqual([]);
    expect(withPref.serverFilters).toEqual([]);
    // Mesma elegibilidade dos buckets.
    expect(withPref.eligible.map((c) => c.itemId)).toEqual(base.eligible.map((c) => c.itemId));
    expect(withPref.blocked.map((c) => c.itemId)).toEqual(base.blocked.map((c) => c.itemId));
    expect(withPref.needsVerification.map((c) => c.itemId)).toEqual(base.needsVerification.map((c) => c.itemId));
    for (const r of withPref.recommendations) expect(r.restrictions.every((x) => !x.blocking)).toBe(true);
  });

  it('determinismo: mesma requisição duas vezes ⇒ mesmas recomendações e notas com o escopo da evidência', async () => {
    const req = { query: 'hamburguer', restrictions: [], preferences: { likedIngredients: ['bacon'], avoidedIngredients: ['queijo'] } };
    const a = await runEvaluation(req, hamburger());
    const b = await runEvaluation(req, hamburger());
    expect(evaluateView(a).recommendations).toEqual(evaluateView(b).recommendations);
    expect(a.ranking.notes.join(' ')).toMatch(/somente a configuração avaliada/);
    expect(a.ranking.notes.join(' ')).toMatch(/configuração alternativa revalidada/);
  });

  it('contrato em centavos intacto com preferências e com a alternativa no domínio', async () => {
    const v = evaluateView(await runEvaluation({ query: 'hamburguer', restrictions: [], preferences: { likedIngredients: ['bacon'] } }, hamburger()));
    const c = evaluateViewCents(v);
    expect(c.money).toEqual({ currency: 'BRL', unit: 'CENTS' });
    const json = JSON.stringify(c);
    expect(json).not.toMatch(/"(unitTotal|estimatedTotal|listPrice|basePrice|unitPrice|fee|amount|itemsSubtotal)":/);
    for (const r of c.recommendations) {
      const p = r.pricing.minimumConfigurable!;
      expect(Number.isInteger(p.unitTotalCents)).toBe(true);
      // A view não expõe alternativeConfiguration (domínio apenas) — nenhum dinheiro decimal vaza por ela.
      expect((r.ranking as unknown as Record<string, unknown>).alternativeConfiguration).toBeUndefined();
    }
  });
});
