import { describe, expect, it } from 'vitest';
import { val } from '../../src/server/domain/fields';
import { normalizeItemDetail, normalizeListingItem, normalizeSearchOffers, NormalizationError } from '../../src/server/domain/normalize';
import { fx, rawItem } from './helpers';

describe('normalizeSearchOffers (fixtures reais)', () => {
  const r = normalizeSearchOffers(fx('searchOffers-pizza.json'));

  it('preserva IDs, nomes e metadados de paginação', () => {
    expect(r.items).toHaveLength(5);
    expect(r.skipped).toEqual([]);
    expect(val(r.interpretedQuery)).toBe('pizza');
    expect(val(r.hasMore)).toBe(true);
    expect(r.items[0]!.itemId).toBe('45a7249f-52b5-4d83-ab89-0424f13f88de');
    expect(r.items[0]!.merchant.merchantId).toBe('780e72eb-fc47-4420-9416-59989207ea07');
    expect(r.items.every((i) => i.priceIsDefinitive === false)).toBe(true);
  });

  it('promoção: base = promo ?? unit, desconto e % calculados', () => {
    const tomate = r.items.find((i) => val(i.itemName) === '1 pizza 22cm + 1 Tomatinho Doce')!;
    expect(tomate.price).toMatchObject({ basePrice: 3390, hasPromotion: true, discountPerUnit: 1000, discountPercent: 23, anomaly: null });
    const semPromo = r.items.find((i) => val(i.itemName) === 'Combo 2 Pizzas')!;
    expect(semPromo.price).toMatchObject({ basePrice: 7999, hasPromotion: false, discountPerUnit: 0 });
  });

  it('loja: avaliação arredondada (float32), contagem, entrega efetiva', () => {
    const m = r.items[0]!.merchant;
    expect(val(m.rating.value)).toBe(4.9);
    expect(val(m.rating.count)).toBeGreaterThan(0);
    expect(val(m.isOpen)).toBe(true);
    const d = val(m.delivery)!;
    expect(d.effectiveFee).toBe(val(d.promotionalFee) ?? val(d.fee));
    expect(val(d.etaMinutes.max)).toBeGreaterThanOrEqual(val(d.etaMinutes.min)!);
  });

  it('item com ID inválido é descartado e reportado, não inventado', () => {
    const raw = fx('searchOffers-pizza.json');
    raw.results[1].itemId = 'nao-e-uuid';
    delete raw.results[2].merchant;
    const out = normalizeSearchOffers(raw);
    expect(out.items).toHaveLength(3);
    expect(out.skipped.map((s) => s.index)).toEqual([1, 2]);
  });
});

describe('ausente ≠ null ≠ vazio', () => {
  it('campos de listagem', () => {
    const raw = fx('searchOffers-pizza.json').results[0];
    delete raw.promotionalUnitPrice;
    raw.merchant.isOpen = null;
    delete raw.merchant.reviewRating;
    raw.merchant.ratingCount = 'muitos';
    const n = normalizeListingItem(raw);
    expect(n.price.promotionalUnitPrice.state).toBe('ABSENT');
    expect(n.price.basePrice).toBe(7800);
    expect(n.merchant.isOpen.state).toBe('NULL');
    expect(n.merchant.rating.value.state).toBe('ABSENT');
    expect(n.merchant.rating.count.state).toBe('INVALID');
  });

  it('optionGroups: [] (sem personalização) vs ausente vs null', () => {
    expect(normalizeItemDetail(rawItem('Veggie Burger')).optionGroups).toEqual({ state: 'PRESENT', value: [] });
    const a = rawItem('Veggie Burger');
    delete a.optionGroups;
    expect(normalizeItemDetail(a).optionGroups.state).toBe('ABSENT');
    expect(normalizeItemDetail({ ...rawItem('Veggie Burger'), optionGroups: null }).optionGroups.state).toBe('NULL');
  });

  it('sem preço nenhum ⇒ basePrice null', () => {
    const r = rawItem('Veggie Burger');
    delete r.unitPrice;
    delete r.promotionalUnitPrice;
    expect(normalizeItemDetail(r).price.basePrice).toBeNull();
  });
});

describe('normalizeItemDetail (fixtures reais)', () => {
  it('pizza: promo do getItem (65) diferente da listagem (78), grupo obrigatório 2–2', () => {
    const d = normalizeItemDetail(rawItem('Promoção pizza grande'));
    expect(d.price).toMatchObject({ basePrice: 6500, discountPerUnit: 1300, discountPercent: 17 });
    expect(val(d.merchantMinimumOrderAmount)).toBe(3000);
    const g = val(d.optionGroups)![0]!;
    expect(g).toMatchObject({ required: true, issues: [] });
    expect(val(g.minSelections)).toBe(2);
    expect(val(g.maxSelections)).toBe(2);
    expect(g.options).toHaveLength(10);
  });

  it('nunca há alérgenos/atributos dietéticos (não vieram em resposta real)', () => {
    for (const raw of fx('getItem-samples.json')) {
      const d = normalizeItemDetail(raw);
      expect(d.allergens.state).toBe('ABSENT');
      expect(d.dietaryAttributes.state).toBe('ABSENT');
      expect(d.unknownFields).toEqual([]);
    }
  });

  it('descrição de opção ausente fica ABSENT; grupo opcional marcado required=false', () => {
    const d = normalizeItemDetail(rawItem('Vegano Brooks'));
    const [acomp, desc] = val(d.optionGroups)!;
    expect(acomp!.required).toBe(false);
    expect(desc!.required).toBe(true);
    expect(acomp!.options.some((o) => o.description.state === 'ABSENT')).toBe(true);
  });

  it('campo novo é listado em unknownFields (não usado)', () => {
    expect(normalizeItemDetail({ ...rawItem('Veggie Burger'), allergenInfo: ['x'] }).unknownFields).toEqual(['allergenInfo']);
  });

  it('limites incoerentes viram issues do grupo', () => {
    const r = rawItem('Vegano Brooks') as { optionGroups: Record<string, unknown>[] };
    r.optionGroups[0]!.minSelections = 3;
    delete r.optionGroups[1]!.maxSelections;
    const [g0, g1] = val(normalizeItemDetail(r).optionGroups)!;
    expect(g0!.issues.join()).toMatch(/minSelections \(3\) > maxSelections \(1\)/);
    expect(g1!.issues).toContain('maxSelections não informado');
  });

  it('rejeita getItem sem IDs válidos', () => {
    expect(() => normalizeItemDetail({ ...rawItem('Veggie Burger'), merchantId: undefined })).toThrow(NormalizationError);
  });
});
