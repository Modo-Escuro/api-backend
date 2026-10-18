// Issue #9 (RANK-02) — preferências textuais pontuam SOMENTE a configuração avaliada.
// Casos A–H da issue + limites do classificador + determinismo. Só funções puras: fixtures reais
// de getItem/searchOffers, sem rede, sem relógio.
import { describe, expect, it } from 'vitest';
import type { RestrictionKey } from '../../src/server/domain/constraints';
import { findTermMention } from '../../src/server/domain/constraints';
import { ABSENT, present } from '../../src/server/domain/fields';
import { evaluateCandidate, type Budget } from '../../src/server/domain/eligibility';
import { normalizePromotion } from '../../src/server/domain/normalize';
import { rankCandidates, type RankCandidate } from '../../src/server/domain/ranking';
import type { ItemRestriction } from '../../src/server/mcp/types';
import { item, listingFor, optionId } from './helpers';

interface CandidateOpts {
  price?: number;
  equalize?: boolean;
  restrictions?: RestrictionKey[];
  budget?: Budget;
  serverFilters?: ItemRestriction[];
  /** Seleção explícita (optionIds reais do getItem) — a configuração avaliada. */
  selection?: { optionId: string; quantity?: number }[];
  /** Sobrescreve a descrição do item (testa negação/ausência sem depender da fixture). */
  description?: string;
  /** Sobrescreve o nome do estabelecimento (testa que loja não é evidência de ingrediente). */
  merchantName?: string;
}

function candidate(name: string, opts: CandidateOpts = {}): RankCandidate {
  const d = item(name);
  const l = listingFor(d.itemId);
  if (opts.price !== undefined) {
    const promo = normalizePromotion({ unitPrice: opts.price });
    d.price = promo;
    l.price = promo;
    d.optionGroups = present([]);
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
  if (opts.description !== undefined) d.itemDescription = present(opts.description);
  if (opts.merchantName !== undefined) {
    l.merchant.name = present(opts.merchantName);
    d.merchantName = present(opts.merchantName);
  }
  const evaluation = evaluateCandidate(
    { listing: l, detail: d, serverFilters: opts.serverFilters ?? [], selection: opts.selection },
    { restrictions: opts.restrictions ?? [], budget: opts.budget },
  );
  return { evaluation, listing: l, detail: d };
}

const prefOf = (c: RankCandidate, prefs: Parameters<typeof rankCandidates>[1], constraints?: Parameters<typeof rankCandidates>[3]) =>
  rankCandidates([c], { priority: 'ECONOMY', ...prefs }, null, constraints).recommendations[0]!.criteria.find((x) => x.criterion === 'PREFERENCES')!;

const recOf = (c: RankCandidate, prefs: Parameters<typeof rankCandidates>[1], constraints?: Parameters<typeof rankCandidates>[3]) =>
  rankCandidates([c], { priority: 'ECONOMY', ...prefs }, null, constraints).recommendations[0]!;

describe('issue #9 — Caso A: adicional não selecionado nunca é bônus de preferência', () => {
  it('bacon só no adicional disponível (não escolhido) não pontua — e vira limitação explícita', () => {
    const c = candidate('Maria salada Veg'); // mínimo configurável, sem bacon
    expect(c.evaluation.selection?.source).toBe('MINIMUM_CONFIGURABLE');
    const pref = prefOf(c, { likedIngredients: ['bacon'] });
    expect(pref).toMatchObject({ status: 'SCORED', score: 0 }); // nunca 1
    expect(pref.reasons.join(' ')).not.toMatch(/menciona "bacon"/);
    expect(pref.dataLimitations.join(' ')).toMatch(/não selecionado/);
    expect(pref.dataLimitations.join(' ')).toMatch(/fora da configuração avaliada/);
  });

  it('só a configuração que realmente leva bacon ganha o bônus; a sem bacon fica sem bônus', () => {
    const withBacon = candidate('Maria salada Veg', {
      selection: [
        { optionId: optionId(item('Maria salada Veg'), 'Lanche Totalmente Vegano') },
        { optionId: optionId(item('Maria salada Veg'), 'Feijão Roxo') },
        { optionId: optionId(item('Maria salada Veg'), 'Nenhum combo') },
        { optionId: optionId(item('Maria salada Veg'), 'Ketchup') },
        { optionId: optionId(item('Maria salada Veg'), 'Bacon crocante vegano') },
      ],
    });
    const without = candidate('Maria salada Veg');
    const prefBacon = prefOf(withBacon, { likedIngredients: ['bacon'] });
    const prefPlain = prefOf(without, { likedIngredients: ['bacon'] });
    expect(prefBacon.score).toBe(1);
    expect(prefBacon.reasons.join(' ')).toMatch(/configuração avaliada menciona "bacon"/);
    expect(prefPlain.score).toBe(0);
  });

  it('evitado só em adicional não selecionado é NO_DATA (nunca a nota máxima 1)', () => {
    const c = candidate('Maria salada Veg');
    const pref = prefOf(c, { avoidedIngredients: ['bacon'] });
    expect(pref).toMatchObject({ status: 'NO_DATA', score: null });
    expect(pref.dataLimitations.join(' ')).toMatch(/NO_DATA/);
    expect(pref.dataLimitations.join(' ')).toMatch(/adicional não selecionado/);
  });
});

describe('issue #9 — Caso B: bacon selecionado pontua e o preço é da mesma configuração', () => {
  it('seleção do usuário com bacon: PREFERENCES 1 e PRICE rotulado como configuração selecionada', () => {
    const c = candidate('Maria salada Veg', {
      selection: [
        { optionId: optionId(item('Maria salada Veg'), 'Lanche Totalmente Vegano') },
        { optionId: optionId(item('Maria salada Veg'), 'Feijão Roxo') },
        { optionId: optionId(item('Maria salada Veg'), 'Nenhum combo') },
        { optionId: optionId(item('Maria salada Veg'), 'Ketchup') },
        { optionId: optionId(item('Maria salada Veg'), 'Bacon crocante vegano') },
      ],
    });
    expect(c.evaluation.selection?.source).toBe('USER');
    const rec = recOf(c, { likedIngredients: ['bacon'] });
    const pref = rec.criteria.find((x) => x.criterion === 'PREFERENCES')!;
    expect(pref).toMatchObject({ status: 'SCORED', score: 1 });
    const price = rec.criteria.find((x) => x.criterion === 'PRICE')!;
    expect(price.reasons.join(' ')).toMatch(/configuração selecionada/);
    expect(price.reasons.join(' ')).toMatch(/R\$ 33\.90/); // 29.90 + 4.00 do bacon
  });

  it('sem seleção: preço e preferência falam da MESMA configuração (mínima, sem adicionais)', () => {
    const c = candidate('Maria salada Veg');
    const rec = recOf(c, { likedIngredients: ['bacon'] });
    const price = rec.criteria.find((x) => x.criterion === 'PRICE')!;
    expect(price.reasons.join(' ')).toMatch(/configuração mínima/);
    expect(price.reasons.join(' ')).toMatch(/R\$ 29\.90/);
  });
});

describe('issue #9 — Caso C: negação não é presença nem merece bônus', () => {
  it('"sem glúten e sem lactose" não é presença afirmada de lactose', () => {
    const c = candidate('Veggie Burger'); // "Pão sem glúten e sem lactose, ..."
    const pref = prefOf(c, { likedIngredients: ['lactose'] });
    expect(pref.score).toBe(0);
    expect(pref.reasons.join(' ')).toMatch(/menção negativa de "lactose"/);
    expect(pref.reasons.join(' ')).not.toMatch(/menciona "lactose"/);
  });

  it('gostar de item "sem bacon" não gera justificativa positiva', () => {
    const c = candidate('Veggie Burger', { description: 'Hambúrguer artesanal sem bacon, com queijo' });
    const pref = prefOf(c, { likedIngredients: ['bacon'] });
    expect(pref.score).toBe(0);
    expect(pref.reasons.join(' ')).not.toMatch(/menciona "bacon"/);
  });

  it('evitado explicitamente ausente ("sem X") é indício de ausência, com aviso de que não é prova', () => {
    const c = candidate('Veggie Burger', { description: 'Hambúrguer artesanal sem bacon, com queijo' });
    const pref = prefOf(c, { avoidedIngredients: ['bacon'] });
    expect(pref.score).toBe(1);
    expect(pref.reasons.join(' ')).toMatch(/indício de ausência do ingrediente evitado/);
    expect(pref.dataLimitations.join(' ')).toMatch(/não é confirmação/);
  });
});

describe('issue #9 — Caso D: item sem descrição + evitado ausente = NO_DATA, nunca nota máxima', () => {
  it('evitado sem qualquer evidência textual vira NO_DATA com limitação (peso redistribuído)', () => {
    const c = candidate('Veggie Burger');
    c.detail!.itemDescription = ABSENT;
    const rec = recOf(c, { avoidedIngredients: ['bacon'] });
    const pref = rec.criteria.find((x) => x.criterion === 'PREFERENCES')!;
    expect(pref).toMatchObject({ status: 'NO_DATA', score: null, effectiveWeight: 0 });
    expect(pref.dataLimitations.join(' ')).toMatch(/ingrediente evitado "bacon"/);
    expect(pref.dataLimitations.join(' ')).toMatch(/ausência do termo não prova ausência/);
    expect(pref.dataLimitations.join(' ')).toMatch(/item sem descrição no iFood/);
    expect(pref.reasons).toEqual([]); // nenhuma justificativa inventada
  });
});

describe('issue #9 — Caso E: nome do estabelecimento não é evidência de ingrediente', () => {
  it('loja "Bacon House" não pontua bacon no item', () => {
    const c = candidate('Veggie Burger', { description: 'Hambúrguer de grão de bico com rúcula', merchantName: 'Bacon House' });
    const pref = prefOf(c, { likedIngredients: ['bacon'] });
    expect(pref.score).toBe(0);
    expect(pref.reasons.join(' ')).not.toMatch(/menciona "bacon"/);
    expect(pref.dataLimitations.join(' ')).toMatch(/sem evidência textual de "bacon"/);
  });
});

describe('issue #9 — Caso F: configuração alternativa revalidada (nunca aplicada em silêncio)', () => {
  it('propõe adicionar bacon com seleção real, configuração VALID, preço recalculado e avaliação explícita', () => {
    const c = candidate('Maria salada Veg');
    const rec = recOf(c, { likedIngredients: ['bacon'] });
    const alt = rec.alternativeConfiguration!;
    expect(alt).not.toBeNull();
    expect(alt.forPreference).toBe('bacon');
    expect(alt.addedOption.name).toBe('Bacon crocante vegano');
    expect(alt.selection.some((s) => s.optionId === optionId(item('Maria salada Veg'), 'Bacon crocante vegano'))).toBe(true);
    expect(alt.configuration.status).toBe('VALID');
    expect(alt.pricing.unitTotalRange.min).toBe(3390);
    expect(alt.reasons.join(' ')).toMatch(/não aplicada/);
    expect(alt.reasons.join(' ')).toMatch(/configuração avaliada e o preço permanecem os mesmos/);
    // A configuração avaliada continua sendo a mínima, com o preço antigo.
    expect(rec.reasons.join(' ')).toMatch(/configuração alternativa revalidada/);
    expect(c.evaluation.pricing.selected).toBeNull();
    expect(c.evaluation.pricing.minimumConfigurable!.unitTotalRange.min).toBe(2990);
  });

  it('teto de orçamento que rejeita a alternativa impede a proposta (configuração avaliada segue elegível)', () => {
    const c = candidate('Maria salada Veg', { budget: { maxItemPrice: 3000 } }); // mínima 29.90 cabe; +bacon 33.90 não
    expect(c.evaluation.eligible).toBe(true);
    const rec = recOf(c, { likedIngredients: ['bacon'] }, { restrictions: [], budget: { maxItemPrice: 3000 } });
    expect(rec.alternativeConfiguration).toBeNull();
  });

  it('sem preferência de ingrediente ausente não há proposta', () => {
    const c = candidate('Veggie Burger'); // grupos vazios, sem opções para propor
    const rec = recOf(c, { likedIngredients: ['bacon'] });
    expect(rec.alternativeConfiguration).toBeNull();
  });
});

describe('issue #9 — Caso G: segurança alimentar nunca é contornada pela alternativa', () => {
  it('restrição obrigatória que bloqueia a opção de bacon anula a proposta, sem afetar elegibilidade', () => {
    // Renomeia a opção sem o marcador "vegano" (que a tornaria compatível com NO_PORK).
    const d = item('Maria salada Veg');
    for (const g of d.optionGroups.state === 'PRESENT' ? d.optionGroups.value : [])
      for (const o of g.options)
        if (o.name.state === 'PRESENT' && o.name.value === 'Bacon crocante vegano') o.name = present('Bacon crocante');
    const l = listingFor(d.itemId);
    const evaluation = evaluateCandidate(
      { listing: l, detail: d, serverFilters: ['VEGAN'] },
      { restrictions: [{ kind: 'DIETARY', code: 'NO_PORK', requirement: 'MANDATORY' }] },
    );
    const c: RankCandidate = { evaluation, listing: l, detail: d };
    expect(c.evaluation.eligible).toBe(true); // item-base compatível (filtro do iFood implica NO_PORK)
    const bacon = optionId(d, 'Bacon crocante');
    const check = c.evaluation.restrictions.find((r) => r.restriction.code === 'NO_PORK')!;
    expect(check.status).toBe('PASS');
    expect(check.blockedOptionIds).toContain(bacon);

    const rec = recOf(c, { likedIngredients: ['bacon'] }, { restrictions: [{ kind: 'DIETARY', code: 'NO_PORK', requirement: 'MANDATORY' }] });
    expect(rec.alternativeConfiguration).toBeNull();
    expect(rec.itemId).toBe(c.evaluation.itemId); // continua elegível, sem troca silenciosa
  });
});

describe('issue #9 — Caso H: regressão das preferências PREFERENCE (issue #8)', () => {
  it('restrição VEGAN como PREFERENCE continua pontuando PASS/FAIL e nunca bloqueia', () => {
    const ok = candidate('Vegano Brooks', { restrictions: [{ kind: 'DIETARY', code: 'VEGAN', requirement: 'PREFERENCE' }], serverFilters: ['VEGAN'] });
    expect(ok.evaluation.eligible).toBe(true);
    const pass = prefOf(ok, null, { restrictions: [{ kind: 'DIETARY', code: 'VEGAN', requirement: 'PREFERENCE' }] });
    expect(pass).toMatchObject({ status: 'SCORED', score: 1 });
    expect(pass.reasons.join(' ')).toMatch(/preferência VEGAN atendida/);

    const unknown = candidate('Veggie Burger', { restrictions: [{ kind: 'DIETARY', code: 'VEGAN', requirement: 'PREFERENCE' }] });
    const unk = prefOf(unknown, null, { restrictions: [{ kind: 'DIETARY', code: 'VEGAN', requirement: 'PREFERENCE' }] });
    expect(unk.dataLimitations.join(' ')).toMatch(/preferência VEGAN não verificável/);
    expect(unknown.evaluation.eligible).toBe(true);
  });
});

describe('issue #9 — limites do classificador de texto', () => {
  it('negação só vale colada ao termo: "sem gluten e bacon" NÃO nega bacon', () => {
    expect(findTermMention('hamburguer sem gluten e bacon', 'bacon')).toEqual({ mentioned: true, asserted: true });
    expect(findTermMention('hamburguer sem gluten e bacon', 'gluten')).toEqual({ mentioned: true, asserted: false });
  });
  it('outros marcadores de negação e fronteira de palavra', () => {
    expect(findTermMention('zero bacon', 'bacon').asserted).toBe(false);
    expect(findTermMention('livre de lactose', 'lactose').asserted).toBe(false);
    expect(findTermMention('baconhouse', 'bacon')).toEqual({ mentioned: false, asserted: false });
    expect(findTermMention('com bacon crocante', 'bacon crocante')).toEqual({ mentioned: true, asserted: true });
  });
});

describe('issue #9 — determinismo e nota de escopo', () => {
  it('mesma entrada ⇒ mesmas recomendações (incluindo alternativeConfiguration)', () => {
    const cs = [
      candidate('Maria salada Veg', { price: 40, equalize: true }),
      candidate('Vegano Brooks', { price: 40, equalize: true }),
    ];
    const prefs = { likedIngredients: ['bacon'], avoidedIngredients: ['queijo'] };
    const r1 = rankCandidates(cs, { priority: 'ECONOMY', ...prefs }, null, { restrictions: [], budget: {} });
    const r2 = rankCandidates(cs, { priority: 'ECONOMY', ...prefs }, null, { restrictions: [], budget: {} });
    expect(r1.recommendations).toEqual(r2.recommendations);
  });

  it('notes documentam o escopo da evidência (loja/adicionais fora; ausência não prova ausência)', () => {
    const r = rankCandidates([candidate('Maria salada Veg')], { priority: 'ECONOMY', likedIngredients: ['bacon'] });
    expect(r.notes.join(' ')).toMatch(/somente a configuração avaliada/);
    expect(r.notes.join(' ')).toMatch(/nome da loja e adicionais não selecionados não contam/);
    expect(r.notes.join(' ')).toMatch(/ausência do termo não prova ausência/);
  });
});
