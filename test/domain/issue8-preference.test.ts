// Issue #8 (P0 RANK-01) — preferência opcional (requirement: 'PREFERENCE') nunca pode bloquear:
// não gera NO_VALID_CONFIGURATION, não invalida configuração e não exclui candidato do ranking.
// Casos A–F de docs/requirements.md (testes obrigatórios da issue). Funções puras, fixtures reais + grupos sintéticos.
import { describe, expect, it } from 'vitest';
import {
  blockedOptions,
  evaluateRestrictions,
  preferenceAvoidedOptions,
  serverFiltersFor,
  type RestrictionCheck,
} from '../../src/server/domain/constraints';
import { evaluateCandidate } from '../../src/server/domain/eligibility';
import { present } from '../../src/server/domain/fields';
import type { NormalizedItemDetail, NormalizedOption, NormalizedOptionGroup } from '../../src/server/domain/normalize';
import { item, listingFor } from './helpers';

const VEGAN = { kind: 'DIETARY', code: 'VEGAN' } as const;
const VEGAN_PREF = { ...VEGAN, requirement: 'PREFERENCE' } as const;
const codes = (xs: { code: string }[]) => xs.map((x) => x.code);
const prefWarnings = (xs: { code: string }[]) => codes(xs).filter((c) => c.startsWith('PREFERENCE_'));

// OptionIds sintéticos só em teste (nunca em dados de produção); formato UUID preservado.
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const opt = (n: number, name: string, price: number): NormalizedOption => ({
  optionId: uuid(n),
  optionGroupId: uuid(900),
  name: present(name),
  description: present(''),
  additionalPrice: present(price * 100),
});
const group = (options: NormalizedOption[]): NormalizedOptionGroup => ({
  optionGroupId: uuid(900),
  name: present('Adicionais'),
  minSelections: present(1),
  maxSelections: present(1),
  required: true,
  options,
  issues: [],
});

/** Açai Artesanal é textualmente neutro para VEGAN + grupo obrigatório sintético. */
function withGroup(options: NormalizedOption[]): { d: NormalizedItemDetail; l: ReturnType<typeof listingFor> } {
  const d = item('Açai Artesanal');
  d.optionGroups = present([group(options)]);
  return { d, l: listingFor(d.itemId) };
}

const evaluate = (
  d: NormalizedItemDetail,
  l: ReturnType<typeof listingFor>,
  restrictions: Parameters<typeof evaluateCandidate>[1]['restrictions'],
  selection?: { optionId: string }[],
) => evaluateCandidate({ listing: l, detail: d, serverFilters: [], ...(selection ? { selection } : {}) }, { restrictions });

describe('issue #8 — preferência opcional nunca bloqueia', () => {
  it('A: grupo obrigatório só com opção incompatível com PREFERENCE segue elegível (aviso, não NO_VALID_CONFIGURATION)', () => {
    const bacon = opt(1, 'Bacon crocante', 3);
    const { d, l } = withGroup([bacon]);

    const pref = evaluate(d, l, [VEGAN_PREF]);
    expect(pref.eligible).toBe(true);
    expect(pref.blockers).toEqual([]);
    expect(pref.selection!.options.map((o) => o.optionId)).toEqual([bacon.optionId]);
    expect(pref.pricing.minimumConfigurable).not.toBeNull();
    expect(pref.pricing.minimumConfigurable!.unitTotal).toBeCloseTo((d.price.basePrice ?? 0) + 300, 6);
    expect(prefWarnings(pref.warnings).length).toBeGreaterThan(0);
    expect(codes(pref.warnings)).toContain('PREFERENCE_NOT_MET'); // gap registra aviso, não bloqueio

    // a mesma restrição como MANDATORY continua inelegível (segurança alimentar intacta)
    const mand = evaluate(d, l, [VEGAN]);
    expect(mand.eligible).toBe(false);
    expect(codes(mand.blockers)).toContain('RESTRICTION_FAIL');
    expect(codes(mand.blockers)).toContain('NO_VALID_CONFIGURATION');
  });

  it('B: entre as configurações viáveis prefere a opção compatível (IDs e preço conferidos)', () => {
    const bacon = opt(1, 'Bacon crocante', 3);
    const veg = opt(2, 'Mix vegetal', 5);
    const { d, l } = withGroup([bacon, veg]);
    const base = d.price.basePrice ?? 0;

    const pref = evaluate(d, l, [VEGAN_PREF]);
    expect(pref.eligible).toBe(true);
    expect(pref.selection!.options.map((o) => o.optionId)).toEqual([veg.optionId]); // prefere vegetal
    expect(pref.pricing.selected!.unitTotal).toBeCloseTo(base + 500, 6);
    expect(pref.pricing.minimumConfigurable!.unitTotal).toBeCloseTo(base + 300, 6);
    expect(pref.configuration!.status).toBe('VALID');
    expect(codes(pref.blockers)).not.toContain('CONFIG_PREFERENCE_OPTION');

    // sem preferência, vale a mais barata (bacon) — a preferência só desemprega
    const none = evaluate(d, l, []);
    expect(none.selection!.options.map((o) => o.optionId)).toEqual([bacon.optionId]);
    expect(none.pricing.minimumConfigurable!.unitTotal).toBeCloseTo(base + 300, 6);
  });

  it('C: preferência nunca torna inelegível um candidato base elegível', () => {
    const { d, l } = withGroup([opt(1, 'Bacon crocante', 3)]);
    expect(evaluate(d, l, []).eligible).toBe(true);
    expect(evaluate(d, l, [VEGAN_PREF]).eligible).toBe(true);

    // varredura sobre fixtures reais: se o candidato base é elegível, com VEGAN/PREFERENCE continua
    for (const name of ['Vegano Brooks', 'Veggie Burger', 'Açai Artesanal', 'Maria salada Veg', 'Promoção pizza grande']) {
      const detail = item(name);
      const listing = listingFor(detail.itemId);
      const base = evaluate(detail, listing, []);
      if (base.eligible) expect(evaluate(detail, listing, [VEGAN_PREF]).eligible).toBe(true);
    }
  });

  it('D: alergia sem dado vira aviso (não bloqueio) mesmo com preferências presentes', () => {
    const { d, l } = withGroup([opt(1, 'Bacon crocante', 3)]);
    const e = evaluate(d, l, [{ kind: 'ALLERGY', code: 'PEANUT' }, VEGAN_PREF]);
    expect(codes(e.blockers)).not.toContain('ALLERGY_UNVERIFIED');
    expect(codes(e.warnings)).toContain('ALLERGY_UNVERIFIED');
    // a preferência continua só gerando aviso
    expect(prefWarnings(e.warnings).length).toBeGreaterThan(0);
  });

  it('E: preferência nunca vira filtro de busca (serverFiltersFor) nem proíbe opções (blockedOptions)', () => {
    expect(serverFiltersFor([{ kind: 'DIETARY', code: 'VEGAN', requirement: 'PREFERENCE' }])).toEqual([]);
    expect(serverFiltersFor([{ kind: 'DIETARY', code: 'VEGAN' }, { kind: 'DIETARY', code: 'VEGETARIAN', requirement: 'PREFERENCE' }])).toEqual(['VEGAN']);

    const { d } = withGroup([opt(1, 'Bacon crocante', 3)]);
    const checks: RestrictionCheck[] = evaluateRestrictions([VEGAN_PREF], { detail: d, serverFilters: [] });
    expect(blockedOptions(checks).size).toBe(0); // PREFERENCE não proíbe
    expect([...preferenceAvoidedOptions(checks)]).toEqual([uuid(1)]); // só desemprega
  });

  it('F: seleção explícita incompatível só com PREFERENCE gera aviso, não CONFIG_BLOCKED_OPTION; com MANDATORY bloqueia', () => {
    const bacon = opt(1, 'Bacon crocante', 3);
    const { d, l } = withGroup([bacon]);
    const selection = [{ optionId: bacon.optionId }];

    const pref = evaluate(d, l, [VEGAN_PREF], selection);
    expect(pref.eligible).toBe(true);
    expect(pref.configuration!.status).toBe('VALID');
    expect(codes(pref.warnings)).toContain('CONFIG_PREFERENCE_OPTION');
    expect(codes(pref.blockers)).not.toContain('CONFIG_BLOCKED_OPTION');
    expect(pref.pricing.selected).not.toBeNull();

    const mand = evaluate(d, l, [VEGAN], selection);
    expect(mand.eligible).toBe(false);
    expect(codes(mand.blockers)).toContain('CONFIG_BLOCKED_OPTION');
  });
});
