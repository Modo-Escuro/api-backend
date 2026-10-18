import { describe, expect, it } from 'vitest';
import { computeMinimumConfigurablePrice, computePrice, detectFromPricePattern } from '../../src/server/domain/pricing';
import { normalizeItemDetail } from '../../src/server/domain/normalize';
import { item, listingFor, optionId, rawItem } from './helpers';

describe('detectFromPricePattern (auditoria em dados reais)', () => {
  it.each([
    ['Promoção pizza grande', 78, 'UNIT_PRICE'], // 2 sabores × 39
    ['GRANDE 2 SABORES (8 PEDAÇOS)', 44.98, 'UNIT_PRICE'], // 22.49 + 22.49
    ['Pizzas Doces Grandes', 75.99, 'UNIT_PRICE'], // 1 sabor × 75.99
    ['Açai Artesanal', 24, 'UNIT_PRICE'], // tamanho 300g = 24
  ])('%s: unitPrice = Σ opções obrigatórias mínimas (%s)', (name, sum, matches) => {
    expect(detectFromPricePattern(item(name))).toMatchObject({ detected: true, requiredMinimumSum: Math.round(sum * 100), matches });
  });

  it.each(['Combo Individual - 1 Pizza 22cm + 1 Pizza Doce 22cm.', 'Pizza Grande | 8 Pedaços', 'Maria salada Veg', 'Veggie Burger'])(
    '%s: opções como acréscimo (sem padrão)',
    (name) => expect(detectFromPricePattern(item(name)).detected).toBe(false),
  );
});

describe('pizza de R$ 143 — preço ambíguo, nunca valor único', () => {
  const d = item('Promoção pizza grande');
  const listing = listingFor(d.itemId);
  const sel = [{ optionId: optionId(d, 'Margherita') }, { optionId: optionId(d, 'Calabria') }];
  const p = computePrice({ detail: d, listing, selection: sel });

  it('regra documentada dá 143 (65 promo + 2 × 39), mas status é UNCERTAIN', () => {
    expect(p.unit).toMatchObject({ listPrice: 7800, promotionalPrice: 6500, basePrice: 6500, discountPerUnit: 1300 });
    expect(p.options.mandatoryTotalPerUnit).toBe(7800);
    expect(p.unitTotal).toBe(14300);
    expect(p.status).toBe('UNCERTAIN');
    expect(p.flags).toEqual(['AMBIGUOUS_OPTION_PRICING']);
  });

  it('duas interpretações e faixa R$ 65–143', () => {
    expect(p.interpretations).toEqual([
      expect.objectContaining({ id: 'BASE_PLUS_OPTIONS', unitTotal: { min: 14300, max: 14300 } }),
      expect.objectContaining({ id: 'OPTIONS_ARE_PRICE', unitTotal: { min: 6500, max: 7800 } }),
    ]);
    expect(p.unitTotalRange).toEqual({ min: 6500, max: 14300 });
  });

  it('entrega promocional (4.99 → 0) e faixa do total estimado', () => {
    expect(p.delivery).toEqual({ fee: 0, promotionalFeeApplied: true, source: 'searchOffers' });
    expect(p.estimatedTotalRange).toEqual({ min: 6500, max: null }); // serviço desconhecido
  });

  it('mínimo da loja (30) atingido em qualquer interpretação', () => {
    expect(p.minimumOrder).toMatchObject({ amount: 3000, met: true, missingAmount: { min: 0, max: 0 } });
  });

  it('total confirmado nunca é afirmado', () => {
    expect(p.confirmation).toMatchObject({ status: 'NOT_CONFIRMED', total: null });
  });

  it('seleção que não cobre o grupo que define o preço ⇒ limite inferior indefinido', () => {
    const q = computePrice({ detail: d, listing });
    expect(q.unitTotalRange).toEqual({ min: null, max: null });
    expect(q.status).toBe('UNCERTAIN');
  });
});

describe('preços com opções obrigatórias e promoções', () => {
  it('Açaí: promo 21 + tamanho obrigatório (padrão "a partir de") ⇒ faixa 21–45', () => {
    const d = item('Açai Artesanal');
    const sel = [{ optionId: optionId(d, '300g') }, { optionId: optionId(d, 'Não colher') }];
    const p = computePrice({ detail: d, listing: listingFor(d.itemId), selection: sel });
    expect(p.unitTotal).toBe(4500);
    expect(p.unitTotalRange).toEqual({ min: 2100, max: 4500 });
    expect(p.estimatedTotalRange).toEqual({ min: 2399, max: null }); // + entrega 2.99; serviço desconhecido
  });

  it('Pizza Grande 8 pedaços: promo 51.9 + sabor +3.9 + borda +14.9 (sem ambiguidade) ⇒ valor único', () => {
    const d = item('Pizza Grande | 8 Pedaços');
    const sel = [
      { optionId: optionId(d, '1/2 - Calabresa Catupiry') },
      { optionId: optionId(d, '1/2 - Toscana') },
      { optionId: optionId(d, 'Borda Recheada - Catupiry') },
    ];
    const p = computePrice({ detail: d, selection: sel });
    expect(p.status).toBe('ESTIMATED');
    expect(p.unit).toMatchObject({ basePrice: 5190, promotionApplied: true, discountPerUnit: 1300, discountPercent: 20 });
    expect(p.options.mandatoryTotalPerUnit).toBe(1880);
    expect(p.unitTotal).toBe(7070);
    expect(p.unitTotalRange).toEqual({ min: 7070, max: 7070 });
  });

  it('obrigatórias vs adicionais, quantidade de itens e taxa de entrega', () => {
    const d = item('Maria salada Veg');
    const sel = [
      { optionId: optionId(d, 'Lanche Totalmente Vegano') },
      { optionId: optionId(d, 'Hambúrguer do futuro') }, // +3
      { optionId: optionId(d, 'Batata Frita P') }, // +8.9
      { optionId: optionId(d, 'Ketchup') },
      { optionId: optionId(d, 'Muçarela vegana') }, // +4 (opcional)
      { optionId: optionId(d, 'Picles') }, // +3 (opcional)
    ];
    const p = computePrice({ detail: d, listing: listingFor(d.itemId), selection: sel, quantity: 2 });
    expect(p.status).toBe('ESTIMATED');
    expect(p.options.mandatoryTotalPerUnit).toBe(1190);
    expect(p.options.additionalTotalPerUnit).toBe(700);
    expect(p.unitTotal).toBe(4880);
    expect(p.itemsSubtotal).toBe(9760);
    expect(p.itemsAndDeliverySubtotal).toBe(10459);
    expect(p.estimatedTotal).toBeNull();
    expect(p.minimumOrder).toMatchObject({ amount: 1590, source: 'getItem', met: true });
  });
});

describe('três níveis de preço', () => {
  it('mínimo configurável ≠ estimativa da seleção; nenhum é confirmado', () => {
    const d = item('Pizza Grande | 8 Pedaços');
    const min = computeMinimumConfigurablePrice(d, null);
    expect(min.price).toMatchObject({ kind: 'MINIMUM_CONFIGURABLE', unitTotal: 5190, status: 'ESTIMATED' });
    expect(min.price!.options.additional).toEqual([]);
    const sel = computePrice({ detail: d, selection: [...min.selection!, { optionId: optionId(d, 'Coca Cola 2l') }] });
    expect(sel).toMatchObject({ kind: 'SELECTED', unitTotal: 7180 });
    for (const p of [min.price!, sel]) expect(p.confirmation.total).toBeNull();
  });

  it('mínimo configurável respeita opções bloqueadas', () => {
    const d = item('Maria salada Veg');
    const blocked = new Set([optionId(d, 'Feijão Roxo'), optionId(d, 'Grão de bico c/ castanha do pará')]);
    expect(computeMinimumConfigurablePrice(d, null, blocked).price!.unitTotal).toBe(3290); // Hambúrguer do futuro +3
  });
});

describe('opções repetidas, faltantes e casos-limite', () => {
  it('opção ×2 é cobrada como preço × qtd, mas marcada como não verificada', () => {
    const d = item('Maria salada Veg');
    const base = ['Lanche Totalmente Vegano', 'Feijão Roxo', 'Nenhum combo', 'Ketchup'].map((n) => ({ optionId: optionId(d, n) }));
    const p = computePrice({ detail: d, selection: [...base, { optionId: optionId(d, 'Picles'), quantity: 2 }] });
    expect(p.options.additionalTotalPerUnit).toBe(600);
    expect(p.status).toBe('UNCERTAIN');
    expect(p.flags).toEqual(['OPTION_REPEAT_UNVERIFIED']);
  });

  it('opção sem preço ⇒ UNCERTAIN com limite superior desconhecido', () => {
    const r = rawItem('Vegano Brooks') as { optionGroups: { options: Record<string, unknown>[] }[] };
    delete r.optionGroups[0]!.options[0]!.additionalPrice;
    const d = normalizeItemDetail(r);
    const p = computePrice({ detail: d, selection: [{ optionId: r.optionGroups[0]!.options[0]!.optionId as string }] });
    expect(p.flags).toEqual(['OPTION_PRICE_MISSING']);
    expect(p.unitTotalRange).toEqual({ min: 4290, max: null });
  });

  it('sem preço-base ⇒ UNAVAILABLE', () => {
    const r = rawItem('Veggie Burger');
    delete r.unitPrice;
    delete r.promotionalUnitPrice;
    const p = computePrice({ detail: normalizeItemDetail(r) });
    expect(p).toMatchObject({ status: 'UNAVAILABLE', unitTotal: null, unitTotalRange: { min: null, max: null } });
  });

  it('abaixo do pedido mínimo informa quanto falta', () => {
    const r = rawItem('Veggie Burger');
    r.merchantMinimumOrderAmount = 80;
    const d = normalizeItemDetail(r);
    const p = computePrice({ detail: d, listing: listingFor(d.itemId) });
    expect(p.minimumOrder).toMatchObject({ amount: 8000, met: false, missingAmount: { min: 2020, max: 2020 } });
  });

  it('faixa que cruza o mínimo ⇒ met = null (não afirma)', () => {
    const r = rawItem('Promoção pizza grande');
    r.merchantMinimumOrderAmount = 100;
    const d = normalizeItemDetail(r);
    const sel = [{ optionId: optionId(d, 'Margherita') }, { optionId: optionId(d, 'Calabria') }];
    expect(computePrice({ detail: d, selection: sel }).minimumOrder).toMatchObject({ met: null, missingAmount: { min: 0, max: 3500 } });
  });

  it('mínimo ausente no getItem ⇒ usa listagem; ausente nos dois ⇒ null', () => {
    const r = rawItem('Vegano Brooks');
    delete r.merchantMinimumOrderAmount;
    const d = normalizeItemDetail(r);
    const sel = [{ optionId: optionId(d, 'Não desejo descartáveis') }];
    expect(computePrice({ detail: d, listing: listingFor(d.itemId), selection: sel }).minimumOrder.source).toBe('searchOffers');
    expect(computePrice({ detail: d, selection: sel }).minimumOrder).toMatchObject({ amount: null, source: null, met: null });
  });

  it('sem listagem ⇒ sem taxa ⇒ total estimado null', () => {
    const p = computePrice({ detail: item('Veggie Burger') });
    expect(p.itemsSubtotal).toBe(5980);
    expect(p.estimatedTotal).toBeNull();
  });

  it('rejeita optionId alheio, quantidades inválidas e listing de outro item', () => {
    const d = item('Veggie Burger');
    expect(() => computePrice({ detail: d, selection: [{ optionId: 'x' }] })).toThrow(/não pertence/);
    expect(() => computePrice({ detail: d, quantity: 0 })).toThrow(RangeError);
    const v = item('Vegano Brooks');
    expect(() => computePrice({ detail: v, selection: [{ optionId: optionId(v, 'Não desejo descartáveis'), quantity: 0 }] })).toThrow(RangeError);
    expect(() => computePrice({ detail: d, listing: listingFor(v.itemId) })).toThrow(/diferentes/);
  });
});
