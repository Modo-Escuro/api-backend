import { describe, expect, it } from 'vitest';
import { checkCap, evaluateCandidate } from '../../src/server/domain/eligibility';
import { normalizeListingItem } from '../../src/server/domain/normalize';
import { fx, item, listingFor, optionId } from './helpers';

const VEGAN = { kind: 'DIETARY', code: 'VEGAN' } as const;
const codes = (xs: { code: string }[]) => xs.map((x) => x.code);

describe('checkCap', () => {
  it('PASS só se a faixa inteira cabe; FAIL se nem o mínimo cabe', () => {
    expect(checkCap({ min: 65, max: 143 }, 150)).toBe('PASS');
    expect(checkCap({ min: 65, max: 143 }, 100)).toBe('UNKNOWN');
    expect(checkCap({ min: 65, max: 143 }, 60)).toBe('FAIL');
    expect(checkCap({ min: 40, max: null }, 50)).toBe('UNKNOWN');
  });
});

describe('restrições obrigatórias precedem o resto', () => {
  it('vegano real (filtro iFood, sem conflito) elegível com configuração mínima', () => {
    const d = item('Vegano Brooks');
    const e = evaluateCandidate({ listing: listingFor(d.itemId), detail: d, serverFilters: ['VEGAN'] }, { restrictions: [VEGAN], budget: { maxOrderTotal: 50 } });
    expect(e.eligible).toBe(true);
    expect(e.selection?.source).toBe('MINIMUM_CONFIGURABLE');
    expect(e.pricing.minimumConfigurable).toMatchObject({ status: 'ESTIMATED', estimatedTotal: 42.9 });
    expect(e.pricing.selected).toBeNull();
    expect(e.pricing.confirmedTotal).toBeNull();
    expect(e.budget).toEqual({ itemPrice: null, orderTotal: 'PASS' });
  });

  it('obrigatória UNKNOWN (sem evidência) bloqueia', () => {
    const d = item('Açai Artesanal');
    const e = evaluateCandidate({ listing: listingFor(d.itemId), detail: d, serverFilters: [] }, { restrictions: [VEGAN] });
    expect(e.eligible).toBe(false);
    expect(codes(e.blockers)).toEqual(['RESTRICTION_UNVERIFIED']);
  });

  it('a mesma restrição como preferência só gera aviso', () => {
    const d = item('Açai Artesanal');
    const e = evaluateCandidate({ listing: listingFor(d.itemId), detail: d, serverFilters: [] }, { restrictions: [{ ...VEGAN, requirement: 'PREFERENCE' }] });
    expect(e.eligible).toBe(true);
    expect(codes(e.warnings)).toContain('PREFERENCE_UNKNOWN');
  });

  it('conflito filtro × descrição em obrigatória bloqueia ("Maria salada Veg")', () => {
    const d = item('Maria salada Veg');
    const e = evaluateCandidate({ listing: listingFor(d.itemId), detail: d, serverFilters: ['VEGAN'] }, { restrictions: [VEGAN] });
    expect(e.eligible).toBe(false);
    expect(e.blockers[0]!.message).toMatch(/não é possível concluir/);
  });

  it('FAIL obrigatório bloqueia', () => {
    const d = item('Açaí + Morango e Leite Condensado');
    const e = evaluateCandidate({ listing: listingFor(d.itemId), detail: d, serverFilters: [] }, { restrictions: [VEGAN] });
    expect(codes(e.blockers)).toEqual(['RESTRICTION_FAIL']);
  });

  it('preferência que bloqueia opções ainda as evita na configuração mínima', () => {
    const d = item('Vegano Brooks');
    const e = evaluateCandidate(
      { listing: listingFor(d.itemId), detail: d, serverFilters: [] },
      { restrictions: [{ kind: 'DIETARY', code: 'VEGETARIAN', requirement: 'PREFERENCE' }] },
    );
    expect(e.selection!.options.map((o) => o.optionId)).not.toContain(optionId(d, 'Nuggets de frango'));
  });
});

describe('alergias', () => {
  it('sem evidência ⇒ bloqueia', () => {
    const d = item('Vegano Brooks');
    const e = evaluateCandidate({ listing: listingFor(d.itemId), detail: d, serverFilters: ['VEGAN'] }, { restrictions: [{ kind: 'ALLERGY', code: 'PEANUT' }] });
    expect(codes(e.blockers)).toEqual(['ALLERGY_UNVERIFIED']);
  });

  it('GLUTEN_FREE do iFood em item sem opções ⇒ NÃO elegível (alergia nunca é aprovada pelo catálogo)', () => {
    const d = item('Veggie Burger');
    const e = evaluateCandidate({ listing: listingFor(d.itemId), detail: d, serverFilters: ['GLUTEN_FREE'] }, { restrictions: [{ kind: 'ALLERGY', code: 'GLUTEN' }] });
    expect(e.eligible).toBe(false);
    expect(codes(e.blockers)).toEqual(['ALLERGY_UNVERIFIED']);
    expect(e.restrictions[0]).toMatchObject({ status: 'UNKNOWN', source: 'SERVER_FILTER_INSUFFICIENT' });
  });

  it('GLUTEN_FREE + descrição com "pão" ⇒ UNKNOWN ⇒ bloqueia', () => {
    const d = item('Vegano Brooks');
    const e = evaluateCandidate({ listing: listingFor(d.itemId), detail: d, serverFilters: ['GLUTEN_FREE'] }, { restrictions: [{ kind: 'ALLERGY', code: 'GLUTEN' }] });
    expect(codes(e.blockers)).toEqual(['ALLERGY_UNVERIFIED']);
  });

  it('item com opções obrigatórias e GLUTEN_FREE ⇒ continua bloqueado', () => {
    const a = item('Açai Artesanal');
    const e = evaluateCandidate({ listing: listingFor(a.itemId), detail: a, serverFilters: ['GLUTEN_FREE'] }, { restrictions: [{ kind: 'ALLERGY', code: 'GLUTEN' }] });
    expect(e.eligible).toBe(false);
    expect(e.restrictions[0]!.status).toBe('UNKNOWN');
    expect(codes(e.blockers)).toContain('ALLERGY_UNVERIFIED');
  });
});

describe('orçamento e preço ambíguo', () => {
  const d = item('Promoção pizza grande');
  const l = listingFor(d.itemId);

  it('faixa 65–143 com teto 100 ⇒ não verificável ⇒ bloqueia', () => {
    const e = evaluateCandidate({ listing: l, detail: d, serverFilters: [] }, { restrictions: [], budget: { maxItemPrice: 100 } });
    expect(e.budget.itemPrice).toBe('UNKNOWN');
    expect(codes(e.blockers)).toEqual(['ITEM_BUDGET_UNVERIFIED']);
    expect(codes(e.warnings)).toContain('PRICE_AMBIGUOUS');
  });

  it('teto acima da faixa inteira ⇒ PASS; abaixo do mínimo ⇒ FAIL', () => {
    expect(evaluateCandidate({ listing: l, detail: d, serverFilters: [] }, { restrictions: [], budget: { maxItemPrice: 150 } }).eligible).toBe(true);
    const e = evaluateCandidate({ listing: l, detail: d, serverFilters: [] }, { restrictions: [], budget: { maxItemPrice: 60 } });
    expect(codes(e.blockers)).toEqual(['OVER_ITEM_BUDGET']);
  });
});

describe('configuração do usuário', () => {
  const d = item('Promoção pizza grande');
  const l = listingFor(d.itemId);

  it('inválida bloqueia e não gera preço selecionado', () => {
    const e = evaluateCandidate({ listing: l, detail: d, serverFilters: [], selection: [{ optionId: optionId(d, 'Margherita') }] }, { restrictions: [] });
    expect(codes(e.blockers)).toEqual(['CONFIG_BELOW_MIN']);
    expect(e.pricing.selected).toBeNull();
    expect(e.pricing.minimumConfigurable).not.toBeNull();
  });

  it('repetição de sabor ⇒ avisos de semântica, preço UNCERTAIN', () => {
    const e = evaluateCandidate(
      { listing: l, detail: d, serverFilters: [], selection: [{ optionId: optionId(d, 'Margherita'), quantity: 2 }] },
      { restrictions: [] },
    );
    expect(e.configuration!.status).toBe('UNKNOWN');
    expect(codes(e.warnings)).toEqual(expect.arrayContaining(['CONFIG_LIMIT_SEMANTICS_UNKNOWN', 'CONFIG_OPTION_REPEAT_UNVERIFIED', 'PRICE_REPEAT_UNVERIFIED']));
    expect(e.pricing.selected!.status).toBe('UNCERTAIN');
  });
});

describe('disponibilidade e detalhe', () => {
  it('loja fechada bloqueia; isOpen ausente vira aviso', () => {
    const d = item('Veggie Burger');
    const raw = fx('searchOffers-hamburguer-vegan.json').results.find((r: { itemId: string }) => r.itemId === d.itemId);
    raw.merchant.isOpen = false;
    expect(codes(evaluateCandidate({ listing: normalizeListingItem(raw), detail: d, serverFilters: [] }, { restrictions: [] }).blockers)).toEqual(['MERCHANT_CLOSED']);
    delete raw.merchant.isOpen;
    const e = evaluateCandidate({ listing: normalizeListingItem(raw), detail: d, serverFilters: [] }, { restrictions: [] });
    expect(e).toMatchObject({ availability: 'UNKNOWN', eligible: true });
  });

  it('sem getItem ⇒ não recomendável', () => {
    const e = evaluateCandidate({ listing: listingFor(item('Veggie Burger').itemId), detail: null, serverFilters: [] }, { restrictions: [] });
    expect(e).toMatchObject({ eligible: false, pricing: { minimumConfigurable: null, selected: null, confirmedTotal: null } });
    expect(codes(e.blockers)).toEqual(['NOT_DETAILED']);
  });

  it('rejeita getItem de outro item', () => {
    const l = listingFor(item('Veggie Burger').itemId);
    expect(() => evaluateCandidate({ listing: l, detail: item('Vegano Brooks'), serverFilters: [] }, { restrictions: [] })).toThrow(/IDs diferentes/);
  });
});
