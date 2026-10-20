// Regressão (issue #3): alergia nunca é aprovada só pela classificação do catálogo.
// ALLERGY:GLUTEN + filtro GLUTEN_FREE do iFood ⇒ UNKNOWN e eligible=false (contaminação cruzada e opções não verificadas).
import { describe, expect, it } from 'vitest';
import { evaluateRestriction, serverFiltersFor, ALLERGENS } from '../../src/server/domain/constraints';
import { evaluateCandidate } from '../../src/server/domain/eligibility';
import { item, listingFor } from './helpers';

const GLUTEN = { kind: 'ALLERGY', code: 'GLUTEN' } as const;

describe('alergia ao glúten com apenas GLUTEN_FREE', () => {
  it('item sem opções e sem termos suspeitos (Veggie Burger) ⇒ UNKNOWN, bloqueante', () => {
    const c = evaluateRestriction(GLUTEN, { detail: item('Veggie Burger'), serverFilters: ['GLUTEN_FREE'] });
    expect(c).toMatchObject({ status: 'UNKNOWN', source: 'SERVER_FILTER_INSUFFICIENT', blocking: true, requirement: 'MANDATORY' });
    expect(c.reasons.join(' ')).toMatch(/não comprova segurança/);
  });

  it('eligible=false com ALLERGY_UNVERIFIED (não ALLERGY_OPTIONS_UNVERIFIED)', () => {
    const d = item('Veggie Burger');
    const e = evaluateCandidate({ listing: listingFor(d.itemId), detail: d, serverFilters: ['GLUTEN_FREE'] }, { restrictions: [GLUTEN] });
    expect(e.eligible).toBe(false);
    expect(e.blockers.map((b) => b.code)).toEqual(['ALLERGY_UNVERIFIED']);
    expect(e.restrictions[0]!.status).toBe('UNKNOWN');
  });

  it('o filtro GLUTEN_FREE continua sendo enviado ao iFood (só estreita a busca)', () => {
    expect(serverFiltersFor([GLUTEN])).toEqual(['GLUTEN_FREE']);
  });

  it('nenhuma alergia jamais resulta PASS, com qualquer combinação de filtros', () => {
    const all = ['VEGAN', 'VEGETARIAN', 'LAC_FREE', 'GLUTEN_FREE', 'ORGANIC', 'SUGAR_FREE'] as const;
    for (const code of ALLERGENS) {
      for (const name of ['Veggie Burger', 'Vegano Brooks', 'Açai Artesanal']) {
        const c = evaluateRestriction({ kind: 'ALLERGY', code }, { detail: item(name), serverFilters: [...all] });
        expect(c.status, `${code}/${name}`).not.toBe('PASS');
        expect(c.blocking).toBe(true);
      }
    }
  });

  it('termo de glúten no nome ⇒ FAIL heurístico mesmo com o filtro', () => {
    // "Combo Individual - 1 Pizza..." contém "pizza" no nome
    const c = evaluateRestriction(GLUTEN, { detail: item('Combo Individual - 1 Pizza 22cm + 1 Pizza Doce 22cm.'), serverFilters: ['GLUTEN_FREE'] });
    expect(c.status).toBe('FAIL');
    expect(c.blocking).toBe(true);
  });

  it('restrição alimentar GLUTEN_FREE (não alergia) continua aceitando o filtro do iFood', () => {
    const c = evaluateRestriction({ kind: 'DIETARY', code: 'GLUTEN_FREE' }, { detail: item('Veggie Burger'), serverFilters: ['GLUTEN_FREE'] });
    expect(c).toMatchObject({ status: 'PASS', source: 'SERVER_FILTER' });
  });
});
