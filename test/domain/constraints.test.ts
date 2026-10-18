import { describe, expect, it } from 'vitest';
import { evaluateRestriction, findTerms, normalizeText, RULES, serverFiltersFor } from '../../src/server/domain/constraints';
import { item, optionId } from './helpers';

const VEGAN = { kind: 'DIETARY', code: 'VEGAN' } as const;
const NO_PORK = { kind: 'DIETARY', code: 'NO_PORK' } as const;

describe('heurística textual', () => {
  it('normaliza acentos e pontuação', () => expect(normalizeText('Muçarela, Pão & Açaí!')).toBe('mucarela pao acai'));
  it('ignora negação e versão vegana', () => {
    const r = RULES['DIETARY:VEGAN']!;
    expect(findTerms('Bacon crocante vegano', r)).toEqual([]);
    expect(findTerms('Muçarela vegana', r)).toEqual([]);
    expect(findTerms('Lanche sem queijo', r)).toEqual([]);
    expect(findTerms('Nuggets de frango', r)).toEqual(['frango', 'nuggets']);
  });
  it('glúten: "pão sem glúten" e "pão de queijo" não contam', () => {
    const r = RULES['ALLERGY:GLUTEN']!;
    expect(findTerms('Pão sem glúten e sem lactose', r)).toEqual([]);
    expect(findTerms('pão de queijo', r)).toEqual([]);
    expect(findTerms('No pão francês redondo', r)).toEqual(['pao']);
  });
  it('ORGANIC não tem heurística (ausência de termo não prova nada)', () => expect(RULES['DIETARY:ORGANIC']).toBeNull());
});

describe('serverFiltersFor', () => {
  it('mapeia apenas para o enum observado; NO_PORK e alergias sem filtro ficam fora', () => {
    expect(
      serverFiltersFor([VEGAN, NO_PORK, { kind: 'DIETARY', code: 'LACTOSE_FREE' }, { kind: 'ALLERGY', code: 'GLUTEN' }, { kind: 'ALLERGY', code: 'MILK' }]),
    ).toEqual(['VEGAN', 'LAC_FREE', 'GLUTEN_FREE']);
  });
});

describe('evaluateRestriction (itens reais)', () => {
  it('PASS via filtro do servidor; opção "Nuggets de frango" bloqueada', () => {
    const d = item('Vegano Brooks');
    const c = evaluateRestriction(VEGAN, { detail: d, serverFilters: ['VEGAN'] });
    expect(c).toMatchObject({ status: 'PASS', source: 'SERVER_FILTER', blocking: false });
    expect(c.blockedOptionIds).toEqual([optionId(d, 'Nuggets de frango')]);
  });

  it('sem filtro e nome/descrição sem termo suspeito ⇒ UNKNOWN (ausência de palavra-chave não é PASS)', () => {
    const c = evaluateRestriction(VEGAN, { detail: item('Açai Artesanal'), serverFilters: [] });
    expect(c).toMatchObject({ status: 'UNKNOWN', source: 'NO_DATA' });
    expect(c.reasons[0]).toMatch(/informação indisponível/);
    // complementos opcionais com leite/mel ficam bloqueados (heurística), sem afetar o status do item
    expect(c.hits.every((h) => h.where === 'OPTION')).toBe(true);
    expect(c.blockedOptionIds.length).toBeGreaterThan(0);
  });

  describe('obrigatória × preferência', () => {
    it('obrigatória (default) UNKNOWN bloqueia', () => {
      const c = evaluateRestriction(VEGAN, { detail: item('Açai Artesanal'), serverFilters: [] });
      expect(c).toMatchObject({ requirement: 'MANDATORY', status: 'UNKNOWN', blocking: true });
    });
    it('preferência UNKNOWN ou FAIL não bloqueia', () => {
      const pref = { ...VEGAN, requirement: 'PREFERENCE' } as const;
      expect(evaluateRestriction(pref, { detail: item('Açai Artesanal'), serverFilters: [] })).toMatchObject({ status: 'UNKNOWN', blocking: false });
      expect(evaluateRestriction(pref, { detail: item('Açaí + Morango e Leite Condensado'), serverFilters: [] })).toMatchObject({ status: 'FAIL', blocking: false });
    });
    it('alergia não pode ser preferência', () => {
      expect(() =>
        evaluateRestriction({ kind: 'ALLERGY', code: 'PEANUT', requirement: 'PREFERENCE' } as never, { detail: item('Veggie Burger'), serverFilters: [] }),
      ).toThrow(/preferência/);
    });
    it('PASS do filtro nunca cobre opções', () => {
      expect(evaluateRestriction(VEGAN, { detail: item('Vegano Brooks'), serverFilters: ['VEGAN'] }).coversOptions).toBe(false);
    });
  });

  it('VEGAN implica NO_PORK (só para restrições alimentares)', () => {
    const c = evaluateRestriction(NO_PORK, { detail: item('Maria salada Veg'), serverFilters: ['VEGAN'] });
    expect(c).toMatchObject({ status: 'PASS', source: 'SERVER_FILTER_IMPLIED' });
  });

  describe('conflitos entre filtro do iFood e descrição', () => {
    it('VEGAN filtrado, mas descrição cita "muçarela" e "maionese" ⇒ UNKNOWN/CONFLICT (bloqueia se obrigatória)', () => {
      const c = evaluateRestriction(VEGAN, { detail: item('Maria salada Veg'), serverFilters: ['VEGAN'] });
      expect(c).toMatchObject({ status: 'UNKNOWN', source: 'CONFLICT', heuristic: true, blocking: true });
      expect(c.reasons.join()).toMatch(/mucarela.*maionese|maionese.*mucarela/);
    });
    it('mesmo conflito como preferência ⇒ UNKNOWN sem bloquear', () => {
      const c = evaluateRestriction({ ...VEGAN, requirement: 'PREFERENCE' }, { detail: item('Maria salada Veg'), serverFilters: ['VEGAN'] });
      expect(c).toMatchObject({ status: 'UNKNOWN', source: 'CONFLICT', blocking: false });
    });
    it('VEGAN filtrado, descrição cita "queijo ... de mandioca" ⇒ conflito (heurística não prova que é vegetal)', () => {
      const c = evaluateRestriction(VEGAN, { detail: item('Veggie Burger'), serverFilters: ['VEGAN'] });
      expect(c).toMatchObject({ status: 'UNKNOWN', source: 'CONFLICT' });
    });
    it('LACTOSE_FREE: "queijo artesanal de mandioca" não é termo de laticínio ⇒ PASS pelo filtro VEGAN implicado', () => {
      const c = evaluateRestriction({ kind: 'DIETARY', code: 'LACTOSE_FREE' }, { detail: item('Veggie Burger'), serverFilters: ['VEGAN'] });
      expect(c).toMatchObject({ status: 'PASS', source: 'SERVER_FILTER_IMPLIED' });
    });
    it('nome do item conflitante com o filtro ⇒ UNKNOWN, nunca PASS', () => {
      const c = evaluateRestriction(VEGAN, { detail: item('Açaí + Morango e Leite Condensado'), serverFilters: ['VEGAN'] });
      expect(c).toMatchObject({ status: 'UNKNOWN', source: 'CONFLICT', blocking: true });
    });
  });

  it('nome do item com laticínio ⇒ FAIL heurístico', () => {
    const c = evaluateRestriction(VEGAN, { detail: item('Açaí + Morango e Leite Condensado'), serverFilters: [] });
    expect(c).toMatchObject({ status: 'FAIL', source: 'HEURISTIC', blocking: true, heuristic: true });
  });

  it('grupo obrigatório sem opção compatível ⇒ FAIL (todos os sabores da pizza têm queijo)', () => {
    const c = evaluateRestriction(VEGAN, { detail: item('Promoção pizza grande'), serverFilters: [] });
    expect(c.status).toBe('FAIL');
    expect(c.reasons.join()).toMatch(/grupo obrigatório sem opção compatível/);
  });

  it('NO_PORK na pizza: "Presunto" bloqueado, item UNKNOWN (há sabores restantes) e bloqueante', () => {
    const d = item('Promoção pizza grande');
    const c = evaluateRestriction(NO_PORK, { detail: d, serverFilters: [] });
    expect(c).toMatchObject({ status: 'UNKNOWN', blocking: true });
    expect(c.blockedOptionIds).toContain(optionId(d, 'Presunto'));
    expect(c.blockedOptionIds).not.toContain(optionId(d, 'Margherita'));
  });

  describe('alergias: tudo que não for PASS bloqueia', () => {
    it('sem evidência ⇒ UNKNOWN bloqueante', () => {
      const c = evaluateRestriction({ kind: 'ALLERGY', code: 'PEANUT' }, { detail: item('Veggie Burger'), serverFilters: ['VEGAN'] });
      expect(c).toMatchObject({ status: 'UNKNOWN', blocking: true });
    });
    it('LAC_FREE não serve como evidência para alergia ao leite', () => {
      const c = evaluateRestriction({ kind: 'ALLERGY', code: 'MILK' }, { detail: item('Veggie Burger'), serverFilters: ['LAC_FREE', 'VEGAN'] });
      expect(c).toMatchObject({ status: 'UNKNOWN', blocking: true });
    });
    it('GLUTEN_FREE do servidor ⇒ UNKNOWN (filtro insuficiente para alergia), bloqueante', () => {
      const c = evaluateRestriction({ kind: 'ALLERGY', code: 'GLUTEN' }, { detail: item('Veggie Burger'), serverFilters: ['GLUTEN_FREE'] });
      expect(c).toMatchObject({ status: 'UNKNOWN', source: 'SERVER_FILTER_INSUFFICIENT', blocking: true });
      expect(c.reasons.join()).toMatch(/contaminação cruzada/);
    });
    it('filtro do servidor + descrição com termo de glúten ⇒ UNKNOWN (descrição pode listar opções)', () => {
      const c = evaluateRestriction({ kind: 'ALLERGY', code: 'GLUTEN' }, { detail: item('Vegano Brooks'), serverFilters: ['GLUTEN_FREE'] });
      expect(c).toMatchObject({ status: 'UNKNOWN', source: 'SERVER_FILTER_INSUFFICIENT', blocking: true });
      expect(c.reasons.join()).toMatch(/descrição menciona: pao/);
    });
    it('opção "castanha" é bloqueada; grupo ainda tem alternativas', () => {
      const d = item('Maria salada Veg');
      const c = evaluateRestriction({ kind: 'ALLERGY', code: 'TREE_NUTS' }, { detail: d, serverFilters: [] });
      expect(c.blockedOptionIds).toEqual([optionId(d, 'Grão de bico c/ castanha do pará')]);
      expect(c.blocking).toBe(true);
    });
  });
});
