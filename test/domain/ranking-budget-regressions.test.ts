// Offline: fixtures reais com preços, frete e grupos sintéticos explicitamente controlados.
import { describe, expect, it } from 'vitest';
import { checkCap, evaluateCandidate, type Budget, type UserConstraints } from '../../src/server/domain/eligibility';
import { ABSENT, present, val, type Field } from '../../src/server/domain/fields';
import { normalizePromotion, type NormalizedOption } from '../../src/server/domain/normalize';
import { computePrice } from '../../src/server/domain/pricing';
import { rankCandidates, type RankCandidate } from '../../src/server/domain/ranking';
import { item, listingFor, optionId } from './helpers';

const veganPref = { kind: 'DIETARY', code: 'VEGAN', requirement: 'PREFERENCE' } as const;

function freeDelivery(listing: ReturnType<typeof listingFor>, fee = 0) {
  const delivery = val(listing.merchant.delivery)!;
  listing.merchant.delivery = present({ ...delivery, fee: present(fee), promotionalFee: ABSENT, effectiveFee: fee });
}

/** Grupo obrigatório sintético: bacon +3, vegetal +10; base 20. */
function required(vegetalPrice: Field<number> | false = present(10)) {
  const detail = item('Açai Artesanal');
  const listing = listingFor(detail.itemId);
  detail.price = normalizePromotion({ unitPrice: 20 });
  listing.price = detail.price;
  freeDelivery(listing);
  const bacon: NormalizedOption = {
    optionId: '00000000-0000-4000-8000-000000000001',
    optionGroupId: '00000000-0000-4000-8000-000000000900',
    name: present('Bacon crocante'), description: present(''), additionalPrice: present(3),
  };
  const vegetal: NormalizedOption = { ...bacon, optionId: '00000000-0000-4000-8000-000000000002', name: present('Mix vegetal'), additionalPrice: vegetalPrice || ABSENT };
  detail.optionGroups = present([{
    optionGroupId: bacon.optionGroupId, name: present('Escolha obrigatória'),
    minSelections: present(1), maxSelections: present(1), required: true,
    options: vegetalPrice === false ? [bacon] : [bacon, vegetal], issues: [],
  }]);
  return { detail, listing, serverFilters: [], bacon, vegetal };
}

function alternative(quantity: number, budget?: Budget, price: Field<number> = present(4), fee = 0, explicit = false) {
  const detail = item('Maria salada Veg');
  const listing = listingFor(detail.itemId);
  freeDelivery(listing, fee);
  const id = optionId(detail, 'Bacon crocante vegano');
  for (const group of val(detail.optionGroups)!) {
    const option = group.options.find((o) => o.optionId === id);
    if (option) option.additionalPrice = price;
  }
  const constraints: UserConstraints = { restrictions: [], budget };
  const initial = evaluateCandidate({ detail, listing, serverFilters: [], quantity }, constraints);
  const selection = explicit ? initial.selection!.options : undefined;
  const evaluation = evaluateCandidate({ detail, listing, serverFilters: [], quantity, selection }, constraints);
  const candidate: RankCandidate = { detail, listing, evaluation };
  const before = structuredClone(evaluation);
  const recommendation = rankCandidates([candidate], { likedIngredients: ['bacon'] }, null, constraints).recommendations[0]!;
  expect(evaluation).toEqual(before);
  expect(evaluation.eligible).toBe(true);
  return { proposal: recommendation.alternativeConfiguration, evaluation, detail, listing, id };
}

describe('preferência opcional respeita viabilidade e mantém mínimo real', () => {
  it('prefere fallback de 23 ao vegetal de 30 sob teto de 25; ranking usa o bacon escolhido', () => {
    const input = required();
    const budget = { maxItemPrice: 25 };
    const base = evaluateCandidate(input, { restrictions: [], budget });
    const evaluation = evaluateCandidate(input, { restrictions: [veganPref], budget });
    expect(base.eligible).toBe(true);
    expect(evaluation.eligible).toBe(true);
    expect(evaluation.selection!.options).toEqual(base.selection!.options);
    expect(evaluation.pricing.minimumConfigurable!.unitTotal).toBe(23);
    expect(evaluation.budget.itemPrice).toBe('PASS');
    expect(evaluation.warnings.map((w) => w.code)).toContain('PREFERENCE_NOT_MET');
    const rec = rankCandidates([{ ...input, evaluation }], { likedIngredients: ['bacon'] }).recommendations[0]!;
    expect(rec.criteria.find((c) => c.criterion === 'PREFERENCES')!.reasons.join(' ')).toContain('menciona "bacon"');
    expect(rec.criteria.find((c) => c.criterion === 'PRICE')!.reasons.join(' ')).toContain('23.00');
  });

  it('atende preferência quando cabe e preserva mínimo de 23 separado do selecionado de 30', () => {
    const input = required();
    const evaluation = evaluateCandidate(input, { restrictions: [veganPref], budget: { maxItemPrice: 30 } });
    expect(evaluation.eligible).toBe(true);
    expect(evaluation.selection).toMatchObject({ source: 'PREFERENCE', options: [{ optionId: input.vegetal.optionId }] });
    expect(evaluation.pricing.minimumConfigurable!.unitTotal).toBe(23);
    expect(evaluation.pricing.selected!.unitTotal).toBe(30);
    expect(evaluation.warnings.map((w) => w.code)).not.toContain('PREFERENCE_NOT_MET');
    const rec = rankCandidates([{ ...input, evaluation }], { likedIngredients: ['vegetal'] }).recommendations[0]!;
    expect(rec.criteria.find((c) => c.criterion === 'PRICE')!.reasons.join(' ')).toContain('30.00');
    expect(rec.criteria.find((c) => c.criterion === 'PREFERENCES')!.reasons.join(' ')).toContain('menciona "vegetal"');
  });

  it('sem opção preferida, avisa sem bloquear', () => {
    const evaluation = evaluateCandidate(required(false), { restrictions: [veganPref], budget: { maxItemPrice: 25 } });
    expect(evaluation.eligible).toBe(true);
    expect(evaluation.warnings.map((w) => w.code)).toContain('PREFERENCE_NOT_MET');
  });

  it('preço preferido UNKNOWN não exclui mínimo viável sob teto', () => {
    const evaluation = evaluateCandidate(required(ABSENT), { restrictions: [veganPref], budget: { maxItemPrice: 25 } });
    expect(evaluation.eligible).toBe(true);
    expect(evaluation.pricing.minimumConfigurable!.unitTotal).toBe(23);
    expect(evaluation.budget.itemPrice).toBe('PASS');
  });

  it('teto do pedido considera quantidade e entrega ao escolher fallback', () => {
    const input = required();
    freeDelivery(input.listing, 5);
    const evaluation = evaluateCandidate({ ...input, quantity: 2 }, { restrictions: [veganPref], budget: { maxOrderTotal: 55 } });
    expect(evaluation.eligible).toBe(true);
    expect(evaluation.pricing.minimumConfigurable!.estimatedTotal).toBe(51);
    expect(evaluation.budget.orderTotal).toBe('PASS');
  });

  it('seleção explícita não é trocada; MANDATORY e alergia continuam bloqueando', () => {
    const input = required();
    const explicit = evaluateCandidate({ ...input, selection: [{ optionId: input.vegetal.optionId }] }, { restrictions: [veganPref], budget: { maxItemPrice: 25 } });
    expect(explicit.eligible).toBe(false);
    expect(explicit.selection!.source).toBe('USER');
    for (const restriction of [{ ...veganPref, requirement: 'MANDATORY' as const }, { kind: 'ALLERGY' as const, code: 'PEANUT' as const }]) {
      const evaluation = evaluateCandidate(required(false), { restrictions: [restriction, veganPref], budget: { maxItemPrice: 25 } });
      expect(evaluation.eligible).toBe(false);
      expect(evaluation.blockers.length).toBeGreaterThan(0);
      expect(rankCandidates([{ ...input, evaluation }]).recommendations).toEqual([]);
    }
  });
});

describe('alternativas revalidadas preservam quantidade e incerteza', () => {
  it('duas unidades originais de 59,80 não autorizam alternativa de 67,80 sob teto 65', () => {
    const { proposal, evaluation } = alternative(2, { maxOrderTotal: 65 });
    expect(evaluation.pricing.minimumConfigurable!.estimatedTotal).toBe(59.8);
    expect(proposal).toBeNull();
  });

  it.each([false, true])('quantidade original cabe no teto 68 (seleção explícita: %s)', (explicit) => {
    const { proposal } = alternative(2, { maxOrderTotal: 68 }, present(4), 0, explicit);
    expect(proposal!.pricing.quantity).toBe(2);
    expect(proposal!.pricing.estimatedTotalRange).toEqual({ min: 67.8, max: 67.8 });
    expect(proposal!.budget.orderTotal).toBe('PASS');
  });

  it('inclui entrega no teto do pedido', () => {
    expect(alternative(2, { maxOrderTotal: 68 }, present(4), 1).proposal).toBeNull();
    expect(alternative(2, { maxOrderTotal: 69 }, present(4), 1).proposal!.pricing.estimatedTotal).toBe(68.8);
  });

  it.each([ABSENT, { state: 'NULL' } as const])('preço %j dá UNKNOWN e impede proposta com qualquer teto', (price) => {
    for (const budget of [{ maxItemPrice: 32 }, { maxOrderTotal: 32 }]) {
      const { proposal, detail, listing, id } = alternative(1, budget, price);
      const original = evaluateCandidate({ detail, listing, serverFilters: [] }, { restrictions: [] });
      const pricing = computePrice({ detail, listing, selection: [...original.selection!.options, { optionId: id }] });
      expect(pricing.unitTotalRange).toEqual({ min: 29.9, max: null });
      expect(checkCap(pricing.unitTotalRange, 32)).toBe('UNKNOWN');
      expect(proposal).toBeNull();
      expect(val(detail.optionGroups)!.flatMap((g) => g.options).find((o) => o.optionId === id)!.additionalPrice).toEqual(price);
    }
  });

  it('preço zero é conhecido e autoriza proposta dentro do teto', () => {
    const { proposal } = alternative(1, { maxItemPrice: 32 }, present(0));
    expect(proposal!.addedOption.additionalPrice).toBe(0);
    expect(proposal!.budget.itemPrice).toBe('PASS');
    expect(proposal!.pricing.unitTotalRange).toEqual({ min: 29.9, max: 29.9 });
  });

  it('sem teto, faixa aberta permanece incerta nos números e na explicação', () => {
    const { proposal } = alternative(1, undefined, ABSENT);
    expect(proposal!.pricing.status).toBe('UNCERTAIN');
    expect(proposal!.pricing.unitTotalRange).toEqual({ min: 29.9, max: null });
    expect(proposal!.pricing.unitTotal).toBeNull();
    expect(proposal!.pricing.itemsSubtotal).toBeNull();
    expect(proposal!.pricing.estimatedTotal).toBeNull();
    expect(proposal!.reasons.join(' ')).toContain('R$ 29.90–? (preço incerto)');
  });
});
