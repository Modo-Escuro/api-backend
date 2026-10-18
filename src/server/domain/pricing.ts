// F3 — Composição honesta de preço (CLAUDE.md regra 6, requirements FR-6). Função pura.
//
// Três níveis, nunca confundidos:
//  1. MINIMUM_CONFIGURABLE — menor preço de uma configuração válida (opções obrigatórias mais baratas,
//     nenhuma adicional). É o "a partir de" honesto do item.
//  2. SELECTED — estimativa para a configuração escolhida pelo usuário.
//  3. Total CONFIRMADO — só existe num carrinho (getCart), proibido no MVP ⇒ sempre null aqui.
//
// Regra documentada (interpretação BASE_PLUS_OPTIONS):
//   unidade = (promotionalUnitPrice ?? unitPrice) + Σ additionalPrice × qtd
//
// Ambiguidade observada no MCP real (docs/pricing-audit.md): em 11 de 38 itens auditados, unitPrice é
// EXATAMENTE a soma das opções obrigatórias mais baratas (ex.: pizza 78 = 2 sabores × 39). Nesses itens
// unitPrice parece ser um "a partir de" derivado das opções, e somar os dois contaria o preço duas vezes.
// Como o MCP não documenta a semântica e só o carrinho confirmaria, NÃO escolhemos: o preço vira uma faixa
// [OPTIONS_ARE_PRICE com promo, BASE_PLUS_OPTIONS] e o status fica UNCERTAIN.

import { money, val } from './fields.js';
import { indexOptions, type NormalizedItemDetail, type NormalizedListingItem } from './normalize.js';
import { cheapestRequiredSelection, type OptionSelection } from './configuration.js';

export type PriceKind = 'MINIMUM_CONFIGURABLE' | 'SELECTED';

export type PriceFlag =
  /** Alguma opção escolhida sem additionalPrice: limite superior desconhecido. */
  | 'OPTION_PRICE_MISSING'
  /** unitPrice = Σ opções obrigatórias mínimas: semântica de additionalPrice ambígua. */
  | 'AMBIGUOUS_OPTION_PRICING'
  /** Opção com quantidade > 1: o MCP não informa se/como repetições são cobradas. */
  | 'OPTION_REPEAT_UNVERIFIED'
  /** promotionalUnitPrice > unitPrice. */
  | 'PRICE_ANOMALY';

export interface PriceRange {
  min: number | null;
  max: number | null;
}

export interface PricedOption {
  optionId: string;
  optionGroupId: string;
  groupName: string | null;
  name: string | null;
  quantity: number;
  unitAdditionalPrice: number | null;
  total: number | null;
}

export interface PriceInterpretation {
  id: 'BASE_PLUS_OPTIONS' | 'OPTIONS_ARE_PRICE';
  description: string;
  unitTotal: PriceRange;
}

export interface FromPricePattern {
  detected: boolean;
  /** Σ das opções obrigatórias mais baratas (minSelections por grupo). */
  requiredMinimumSum: number | null;
  matches: 'UNIT_PRICE' | 'PROMOTIONAL_PRICE' | null;
  groupIds: string[];
}

export interface PriceBreakdown {
  kind: PriceKind;
  currency: 'BRL';
  /** ESTIMATED: valor único; UNCERTAIN: ver flags e faixas; UNAVAILABLE: sem preço-base. */
  status: 'ESTIMATED' | 'UNCERTAIN' | 'UNAVAILABLE';
  flags: PriceFlag[];
  confirmation: { status: 'NOT_CONFIRMED'; total: null; reason: string };
  quantity: number;
  unit: {
    listPrice: number | null;
    promotionalPrice: number | null;
    basePrice: number | null;
    promotionApplied: boolean;
    discountPerUnit: number;
    discountPercent: number;
  };
  options: {
    mandatory: PricedOption[];
    additional: PricedOption[];
    mandatoryTotalPerUnit: number;
    additionalTotalPerUnit: number;
  };
  /** Pela regra documentada (BASE_PLUS_OPTIONS). Quando status=UNCERTAIN, use as faixas. */
  unitTotal: number | null;
  unitTotalRange: PriceRange;
  itemsSubtotal: number | null;
  itemsSubtotalRange: PriceRange;
  interpretations: PriceInterpretation[];
  fromPricePattern: FromPricePattern;
  totalDiscount: number;
  delivery: { fee: number | null; promotionalFeeApplied: boolean; source: 'searchOffers' | null };
  estimatedTotal: number | null;
  estimatedTotalRange: PriceRange;
  minimumOrder: {
    amount: number | null;
    source: 'getItem' | 'searchOffers' | null;
    /** null quando não dá para afirmar (sem mínimo, sem subtotal, ou faixa cruza o mínimo). */
    met: boolean | null;
    missingAmount: PriceRange;
  };
  listingComparison: { listingBasePrice: number | null; detailBasePrice: number | null; differs: boolean | null };
  notes: string[];
}

export interface PriceInput {
  detail: NormalizedItemDetail;
  /** Item da listagem (taxa de entrega e mínimo de fallback). */
  listing?: NormalizedListingItem | null;
  selection?: OptionSelection[];
  quantity?: number;
  kind?: PriceKind;
}

const CONFIRMATION = {
  status: 'NOT_CONFIRMED' as const,
  total: null,
  reason: 'Total confirmado só existe no carrinho do iFood (fora do escopo do MVP); taxas de serviço e cupons não incluídos',
};

const EPS = 0.005;
const near = (a: number, b: number) => Math.abs(a - b) < EPS;
const mulRange = (r: PriceRange, k: number): PriceRange => ({
  min: r.min === null ? null : money(r.min * k),
  max: r.max === null ? null : money(r.max * k),
});
const addRange = (r: PriceRange, v: number | null): PriceRange => ({
  min: r.min === null || v === null ? null : money(r.min + v),
  max: r.max === null || v === null ? null : money(r.max + v),
});

/** Detecta o padrão "unitPrice = Σ opções obrigatórias mínimas" (evidência de preço 'a partir de'). */
export function detectFromPricePattern(detail: NormalizedItemDetail): FromPricePattern {
  const none: FromPricePattern = { detected: false, requiredMinimumSum: null, matches: null, groupIds: [] };
  const groups = val(detail.optionGroups);
  if (!groups) return none;
  let sum = 0;
  const groupIds: string[] = [];
  for (const g of groups) {
    const min = val(g.minSelections);
    if (min === undefined) return none;
    if (min < 1) continue;
    const prices = g.options.map((o) => val(o.additionalPrice));
    if (prices.some((p) => p === undefined) || prices.length < min) return none;
    const cheapest = (prices as number[]).sort((a, b) => a - b).slice(0, min).reduce((a, b) => a + b, 0);
    if (cheapest > 0) groupIds.push(g.optionGroupId);
    sum += cheapest;
  }
  sum = money(sum);
  if (sum <= 0) return { ...none, requiredMinimumSum: sum };
  const unit = val(detail.price.unitPrice);
  const promo = val(detail.price.promotionalUnitPrice);
  const matches = unit !== undefined && near(sum, unit) ? 'UNIT_PRICE' : promo !== undefined && near(sum, promo) ? 'PROMOTIONAL_PRICE' : null;
  return { detected: matches !== null, requiredMinimumSum: sum, matches, groupIds: matches ? groupIds : [] };
}

export function computePrice({ detail, listing, selection = [], quantity = 1, kind = 'SELECTED' }: PriceInput): PriceBreakdown {
  if (!Number.isInteger(quantity) || quantity < 1) throw new RangeError(`quantidade inválida: ${quantity}`);
  if (listing && (listing.itemId !== detail.itemId || listing.merchant.merchantId !== detail.merchantId)) {
    throw new Error('listing e getItem referem-se a itens/lojas diferentes');
  }
  const notes: string[] = [];
  const flags = new Set<PriceFlag>();
  const p = detail.price;
  const listPrice = val(p.unitPrice) ?? null;
  const promotionalPrice = val(p.promotionalUnitPrice) ?? null;
  const basePrice = p.basePrice;
  if (p.anomaly) {
    flags.add('PRICE_ANOMALY');
    notes.push(`Anomalia de preço: ${p.anomaly}`);
  }

  // ---- opções
  const index = indexOptions(detail);
  const mandatory: PricedOption[] = [];
  const additional: PricedOption[] = [];
  for (const s of selection) {
    const e = index.get(s.optionId);
    if (!e) throw new Error(`optionId não pertence a este item: ${s.optionId}`);
    const q = s.quantity ?? 1;
    if (!Number.isInteger(q) || q < 1) throw new RangeError(`quantidade inválida para opção ${s.optionId}: ${q}`);
    if (q > 1) {
      flags.add('OPTION_REPEAT_UNVERIFIED');
      notes.push(`"${val(e.option.name) ?? s.optionId}" ×${q}: cobrança de repetição não informada pelo iFood (assumido preço × quantidade)`);
    }
    const unitAdd = val(e.option.additionalPrice) ?? null;
    if (unitAdd === null) {
      flags.add('OPTION_PRICE_MISSING');
      notes.push(`Preço da opção "${val(e.option.name) ?? s.optionId}" não informado`);
    }
    const priced: PricedOption = {
      optionId: s.optionId,
      optionGroupId: e.group.optionGroupId,
      groupName: val(e.group.name) ?? null,
      name: val(e.option.name) ?? null,
      quantity: q,
      unitAdditionalPrice: unitAdd,
      total: unitAdd === null ? null : money(unitAdd * q),
    };
    (e.group.required ? mandatory : additional).push(priced);
  }
  const sum = (xs: PricedOption[]) => money(xs.reduce((a, o) => a + (o.total ?? 0), 0));
  const mandatoryTotalPerUnit = sum(mandatory);
  const additionalTotalPerUnit = sum(additional);
  const optionsSum = money(mandatoryTotalPerUnit + additionalTotalPerUnit);
  const missingPrice = flags.has('OPTION_PRICE_MISSING');

  // ---- interpretações
  const pattern = detectFromPricePattern(detail);
  const interpretations: PriceInterpretation[] = [];
  let unitTotal: number | null = null;
  let unitTotalRange: PriceRange = { min: null, max: null };
  if (basePrice === null) {
    notes.push('Preço-base indisponível (getItem sem unitPrice/promotionalUnitPrice)');
  } else {
    unitTotal = money(basePrice + optionsSum);
    const a: PriceRange = { min: unitTotal, max: missingPrice ? null : unitTotal };
    interpretations.push({ id: 'BASE_PLUS_OPTIONS', description: 'preço-base + Σ additionalPrice (regra documentada)', unitTotal: a });
    unitTotalRange = a;
    if (pattern.detected) {
      flags.add('AMBIGUOUS_OPTION_PRICING');
      // Se as opções SÃO o preço, a promo do item pode ou não se aplicar sobre elas: faixa.
      // Seleção que não cobre os grupos que carregam o preço ⇒ limite inferior indefinido.
      const chosenGroups = new Set([...mandatory, ...additional].map((o) => o.optionGroupId));
      const covers = pattern.groupIds.every((g) => chosenGroups.has(g));
      if (!covers) notes.push('Seleção não cobre os grupos obrigatórios que definem o preço — limite inferior indefinido');
      const b: PriceRange = covers
        ? { min: money(Math.max(0, optionsSum - p.discountPerUnit)), max: missingPrice ? null : optionsSum }
        : { min: null, max: null };
      interpretations.push({
        id: 'OPTIONS_ARE_PRICE',
        description: 'unitPrice é "a partir de" (= Σ opções obrigatórias mínimas); o preço vem das opções escolhidas',
        unitTotal: b,
      });
      unitTotalRange = {
        min: a.min === null || b.min === null ? null : Math.min(a.min, b.min),
        max: a.max === null || b.max === null ? null : Math.max(a.max, b.max),
      };
      const fmt = (v: number | null) => (v === null ? '?' : `R$ ${v.toFixed(2)}`);
      notes.push(
        `Semântica de preço ambígua: unitPrice (${pattern.matches === 'UNIT_PRICE' ? listPrice : promotionalPrice}) = Σ opções obrigatórias mínimas (${pattern.requiredMinimumSum}). ` +
          `Faixa ${fmt(unitTotalRange.min)}–${fmt(unitTotalRange.max)} por unidade; só o carrinho confirma.`,
      );
    }
  }
  const itemsSubtotal = unitTotal === null ? null : money(unitTotal * quantity);
  const itemsSubtotalRange = mulRange(unitTotalRange, quantity);
  const totalDiscount = money(p.discountPerUnit * quantity);

  // ---- entrega (somente listagem; não confirmada)
  const dm = listing ? val(listing.merchant.delivery) : undefined;
  const fee = dm?.effectiveFee ?? null;
  if (!listing) notes.push('Taxa de entrega desconhecida (sem dados da listagem)');
  else if (fee === null) notes.push('Taxa de entrega não informada');
  else notes.push('Taxa de entrega da listagem (searchOffers) — pode mudar no carrinho');
  const estimatedTotal = itemsSubtotal === null || fee === null ? null : money(itemsSubtotal + fee);
  const estimatedTotalRange = addRange(itemsSubtotalRange, fee);

  // ---- pedido mínimo (getItem é a fonte principal; listagem como fallback). Compara com o subtotal de itens.
  const minDetail = val(detail.merchantMinimumOrderAmount);
  const minListing = listing ? val(listing.merchant.minimumOrderAmount) : undefined;
  const amount = minDetail ?? minListing ?? null;
  const source = minDetail !== undefined ? 'getItem' : minListing !== undefined ? 'searchOffers' : null;
  let met: boolean | null = null;
  let missingAmount: PriceRange = { min: null, max: null };
  if (amount !== null) {
    const lo = itemsSubtotalRange.min;
    const hi = itemsSubtotalRange.max;
    if (lo !== null && lo >= amount) met = true;
    else if (hi !== null && hi < amount) met = false;
    // Quanto falta: menor valor quando o subtotal é máximo, maior quando é mínimo.
    missingAmount = {
      min: hi === null ? null : money(Math.max(0, amount - hi)),
      max: lo === null ? null : money(Math.max(0, amount - lo)),
    };
    if (met === false) notes.push(`Abaixo do pedido mínimo: faltam R$ ${missingAmount.max!.toFixed(2)}`);
    if (met === null && lo !== null) notes.push('Não é possível afirmar se o pedido mínimo é atingido (preço em faixa)');
  }

  const listingBase = listing?.price.basePrice ?? null;
  const differs = listingBase === null || basePrice === null ? null : listingBase !== basePrice;
  if (differs) notes.push(`Preço da listagem (R$ ${listingBase!.toFixed(2)}) difere do getItem (R$ ${basePrice!.toFixed(2)}); vale o getItem`);

  const flagList = [...flags];
  return {
    kind,
    currency: 'BRL',
    status: basePrice === null ? 'UNAVAILABLE' : flagList.length ? 'UNCERTAIN' : 'ESTIMATED',
    flags: flagList,
    confirmation: CONFIRMATION,
    quantity,
    unit: {
      listPrice,
      promotionalPrice,
      basePrice,
      promotionApplied: p.hasPromotion,
      discountPerUnit: p.discountPerUnit,
      discountPercent: p.discountPercent,
    },
    options: { mandatory, additional, mandatoryTotalPerUnit, additionalTotalPerUnit },
    unitTotal,
    unitTotalRange,
    itemsSubtotal,
    itemsSubtotalRange,
    interpretations,
    fromPricePattern: pattern,
    totalDiscount,
    delivery: {
      fee,
      promotionalFeeApplied: dm ? val(dm.promotionalFee) !== undefined && val(dm.promotionalFee) !== val(dm.fee) : false,
      source: fee === null ? null : 'searchOffers',
    },
    estimatedTotal,
    estimatedTotalRange,
    minimumOrder: { amount, source, met, missingAmount },
    listingComparison: { listingBasePrice: listingBase, detailBasePrice: basePrice, differs },
    notes,
  };
}

/** Preço mínimo sob condições obrigatórias, sem adicionais. Preferências só desempatam preços iguais;
 * uma configuração preferida mais cara deve ser precificada separadamente como SELECTED. */
export function computeMinimumConfigurablePrice(
  detail: NormalizedItemDetail,
  listing: NormalizedListingItem | null | undefined,
  blocked: ReadonlySet<string> = new Set(),
  quantity = 1,
  avoided: ReadonlySet<string> = new Set(),
): { price: PriceBreakdown | null; selection: OptionSelection[] | null; problems: string[]; preferenceGaps: string[] } {
  const minimal = cheapestRequiredSelection(detail, blocked, avoided);
  if (!minimal.selection) return { price: null, selection: null, problems: minimal.problems, preferenceGaps: [] };
  return {
    price: computePrice({ detail, listing, selection: minimal.selection, quantity, kind: 'MINIMUM_CONFIGURABLE' }),
    selection: minimal.selection,
    problems: [],
    preferenceGaps: minimal.preferenceGaps,
  };
}
