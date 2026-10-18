// F2 — Normalização de searchOffers/getItem em modelos tipados.
// Somente campos observados em respostas reais (fixtures/). Nada é inventado:
// campos faltantes ficam ABSENT/NULL e campos desconhecidos são apenas listados.
// Função pura: não faz fetch.

import {
  ABSENT,
  type Field,
  isString,
  mapField,
  present,
  readBoolean,
  readField,
  readNumber,
  readString,
  val,
} from './fields.js';
import { brlToCents, cents, formatCents } from './money.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

export class NormalizationError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(`${path}: ${message}`);
  }
}

// ---------------- modelos ----------------
// Todos os campos monetários normalizados abaixo estão em centavos, inclusive os que preservam nomes do MCP.

export interface NormalizedRating {
  /** reviewRating arredondado a 2 casas (o MCP envia float32, ex.: 4.900000095367432). */
  value: Field<number>;
  /** Valor sem arredondamento para conferir limites rígidos; value é só apresentação. */
  rawValue: Field<number>;
  count: Field<number>;
}

export interface NormalizedDelivery {
  deliveryMethodId: Field<string>;
  mode: Field<string>;
  fee: Field<number>;
  promotionalFee: Field<number>;
  /** promotionalFee ?? fee; null se nenhum dos dois veio. */
  effectiveFee: number | null;
  etaMinutes: { min: Field<number>; max: Field<number> };
}

export interface NormalizedMerchant {
  merchantId: string;
  name: Field<string>;
  logoUrl: Field<string>;
  isOpen: Field<boolean>;
  minimumOrderAmount: Field<number>;
  rating: NormalizedRating;
  distanceKm: Field<number>;
  delivery: Field<NormalizedDelivery>;
}

export interface NormalizedPromotion {
  unitPrice: Field<number>;
  promotionalUnitPrice: Field<number>;
  /** promotionalUnitPrice ?? unitPrice (regra 6); null se nenhum veio. */
  basePrice: number | null;
  hasPromotion: boolean;
  discountPerUnit: number;
  /** 0–100, inteiro. */
  discountPercent: number;
  /** promo > preço cheio (não deveria ocorrer) — sinalizado, não corrigido. */
  anomaly: string | null;
}

export interface NormalizedListingItem {
  source: 'searchOffers';
  itemId: string;
  itemName: Field<string>;
  itemEan: Field<string>;
  imageUrl: Field<string>;
  price: NormalizedPromotion;
  merchant: NormalizedMerchant;
  /** Preço de listagem nunca é definitivo — exige getItem (regra 2). */
  priceIsDefinitive: false;
  unknownFields: string[];
}

export interface NormalizedOption {
  optionId: string;
  optionGroupId: string;
  name: Field<string>;
  description: Field<string>;
  additionalPrice: Field<number>;
}

export interface NormalizedOptionGroup {
  optionGroupId: string;
  name: Field<string>;
  minSelections: Field<number>;
  maxSelections: Field<number>;
  /** minSelections >= 1. null se minSelections não veio (não dá para afirmar). */
  required: boolean | null;
  options: NormalizedOption[];
  issues: string[];
}

export interface NormalizedItemDetail {
  source: 'getItem';
  itemId: string;
  merchantId: string;
  itemName: Field<string>;
  itemDescription: Field<string>;
  imageUrl: Field<string>;
  merchantName: Field<string>;
  merchantMinimumOrderAmount: Field<number>;
  price: NormalizedPromotion;
  /** PRESENT([]) = item sem personalização; ABSENT = desconhecido. */
  optionGroups: Field<NormalizedOptionGroup[]>;
  appDeeplink: Field<string>;
  /**
   * Nenhuma resposta real de getItem trouxe ingredientes/alérgenos/atributos dietéticos
   * estruturados (verificado em 12 itens, 2026-10-17). Por isso: sempre ABSENT.
   */
  dietaryAttributes: Field<never>;
  allergens: Field<never>;
  unknownFields: string[];
}

export interface NormalizedSearchResult {
  resultKind: Field<string>;
  interpretedQuery: Field<string>;
  hasMore: Field<boolean>;
  nextPageToken: Field<string>;
  items: NormalizedListingItem[];
  skipped: { index: number; reason: string }[];
}

// ---------------- helpers ----------------

const asObj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

// Não promover dinheiro inválido a zero ou ao preço de fallback.
function readMoney(raw: unknown, key: string): Field<number> {
  const field = readNumber(raw, key);
  if (field.state !== 'PRESENT') return field;
  try { return present(brlToCents(field.value)); }
  catch { return { state: 'INVALID', raw: field.value }; }
}

const round2 = (v: number) => Math.round(v * 100) / 100;

function unknownKeys(o: Record<string, unknown>, known: readonly string[]): string[] {
  return Object.keys(o).filter((k) => !known.includes(k));
}

export function normalizePromotion(o: unknown): NormalizedPromotion {
  const unitPrice = readMoney(o, 'unitPrice');
  const promotionalUnitPrice = readMoney(o, 'promotionalUnitPrice');
  const unit = val(unitPrice);
  const promo = val(promotionalUnitPrice);
  const invalid = unitPrice.state === 'INVALID' || promotionalUnitPrice.state === 'INVALID';
  const basePrice = invalid ? null : promo ?? unit ?? null;
  let discountPerUnit = 0;
  let anomaly: string | null = invalid ? 'Preço monetário inválido no MCP' : null;
  if (unit !== undefined && promo !== undefined) {
    if (promo < unit) discountPerUnit = cents(unit - promo);
    else if (promo > unit) anomaly = `promotionalUnitPrice (${formatCents(promo)}) maior que unitPrice (${formatCents(unit)})`;
  }
  return {
    unitPrice,
    promotionalUnitPrice,
    basePrice,
    hasPromotion: discountPerUnit > 0,
    discountPerUnit,
    discountPercent: unit && discountPerUnit > 0 ? Number((BigInt(discountPerUnit) * 100n + BigInt(unit) / 2n) / BigInt(unit)) : 0,
    anomaly,
  };
}

function normalizeDelivery(raw: unknown): Field<NormalizedDelivery> {
  if (raw === undefined) return ABSENT;
  if (raw === null) return { state: 'NULL' };
  const d = asObj(raw);
  if (!d) return { state: 'INVALID', raw };
  const fee = readMoney(d, 'fee');
  const promotionalFee = readMoney(d, 'promotionalFee');
  const eta = asObj(d.estimatedMinutes);
  return present({
    deliveryMethodId: readString(d, 'deliveryMethodId'),
    mode: readString(d, 'deliveryMethodMode'),
    fee,
    promotionalFee,
    effectiveFee: fee.state === 'INVALID' || promotionalFee.state === 'INVALID' ? null : val(promotionalFee) ?? val(fee) ?? null,
    etaMinutes: { min: readNumber(eta, 'min'), max: readNumber(eta, 'max') },
  });
}

export function normalizeMerchant(raw: unknown, path = 'merchant'): NormalizedMerchant {
  const m = asObj(raw);
  if (!m) throw new NormalizationError('merchant ausente ou inválido', path);
  if (!isUuid(m.merchantId)) throw new NormalizationError('merchantId ausente ou não-UUID', `${path}.merchantId`);
  return {
    merchantId: m.merchantId,
    name: readString(m, 'merchantName'),
    logoUrl: readString(m, 'merchantLogoUrl'),
    isOpen: readBoolean(m, 'isOpen'),
    minimumOrderAmount: readMoney(m, 'minimumOrderAmount'),
    rating: { value: mapField(readNumber(m, 'reviewRating'), round2), rawValue: readNumber(m, 'reviewRating'), count: readNumber(m, 'ratingCount') },
    distanceKm: readNumber(m, 'straightLineDistanceKm'),
    delivery: 'deliveryMethod' in m ? normalizeDelivery(m.deliveryMethod) : ABSENT,
  };
}

const LISTING_KEYS = ['itemId', 'itemName', 'itemEan', 'itemImageUrl', 'unitPrice', 'promotionalUnitPrice', 'merchant'] as const;

export function normalizeListingItem(raw: unknown, path = 'item'): NormalizedListingItem {
  const o = asObj(raw);
  if (!o) throw new NormalizationError('item inválido', path);
  if (!isUuid(o.itemId)) throw new NormalizationError('itemId ausente ou não-UUID', `${path}.itemId`);
  return {
    source: 'searchOffers',
    itemId: o.itemId,
    itemName: readString(o, 'itemName'),
    itemEan: readString(o, 'itemEan'),
    imageUrl: readString(o, 'itemImageUrl'),
    price: normalizePromotion(o),
    merchant: normalizeMerchant(o.merchant, `${path}.merchant`),
    priceIsDefinitive: false,
    unknownFields: unknownKeys(o, LISTING_KEYS),
  };
}

/** searchOffers (resultKind=ITEM). Itens com IDs inválidos são descartados e reportados em `skipped`. */
export function normalizeSearchOffers(raw: unknown): NormalizedSearchResult {
  const o = asObj(raw);
  if (!o) throw new NormalizationError('resposta inválida', 'searchOffers');
  const items: NormalizedListingItem[] = [];
  const skipped: { index: number; reason: string }[] = [];
  const results = Array.isArray(o.results) ? o.results : [];
  results.forEach((r, i) => {
    try {
      items.push(normalizeListingItem(r, `results[${i}]`));
    } catch (e) {
      skipped.push({ index: i, reason: e instanceof Error ? e.message : String(e) });
    }
  });
  return {
    resultKind: readString(o, 'resultKind'),
    interpretedQuery: readString(o, 'interpretedQuery'),
    hasMore: readBoolean(o, 'hasMore'),
    nextPageToken: readString(o, 'nextPageToken'),
    items,
    skipped,
  };
}

function normalizeOptionGroup(raw: unknown, path: string): NormalizedOptionGroup {
  const g = asObj(raw);
  if (!g) throw new NormalizationError('optionGroup inválido', path);
  if (!isString(g.optionGroupId) || !g.optionGroupId) throw new NormalizationError('optionGroupId ausente', `${path}.optionGroupId`);
  const groupId = g.optionGroupId;
  const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
  const minSelections = readField(g, 'minSelections', isCount);
  const maxSelections = readField(g, 'maxSelections', isCount);
  const issues: string[] = [];
  const options: NormalizedOption[] = [];
  const rawOptions = Array.isArray(g.options) ? g.options : [];
  if (!Array.isArray(g.options)) issues.push('options ausente');
  rawOptions.forEach((op, i) => {
    const x = asObj(op);
    if (!x || !isString(x.optionId) || !x.optionId) {
      issues.push(`options[${i}] sem optionId — descartada`);
      return;
    }
    options.push({
      optionId: x.optionId,
      optionGroupId: groupId,
      name: readString(x, 'name'),
      description: readString(x, 'description'),
      additionalPrice: readMoney(x, 'additionalPrice'),
    });
  });
  const min = val(minSelections);
  const max = val(maxSelections);
  if (min === undefined) issues.push('minSelections não informado');
  if (max === undefined) issues.push('maxSelections não informado');
  if (min !== undefined && max !== undefined && min > max) issues.push(`minSelections (${min}) > maxSelections (${max})`);
  if (min !== undefined && min > options.length) issues.push(`minSelections (${min}) maior que nº de opções (${options.length})`);
  return {
    optionGroupId: groupId,
    name: readString(g, 'name'),
    minSelections,
    maxSelections,
    required: min === undefined ? null : min >= 1,
    options,
    issues,
  };
}

const DETAIL_KEYS = [
  'itemId',
  'itemName',
  'itemDescription',
  'itemImageUrl',
  'merchantId',
  'merchantName',
  'merchantMinimumOrderAmount',
  'unitPrice',
  'promotionalUnitPrice',
  'optionGroups',
  'appDeeplink',
  'agentHints',
] as const;

export function normalizeItemDetail(raw: unknown): NormalizedItemDetail {
  const o = asObj(raw);
  if (!o) throw new NormalizationError('resposta inválida', 'getItem');
  if (!isUuid(o.itemId)) throw new NormalizationError('itemId ausente ou não-UUID', 'getItem.itemId');
  if (!isUuid(o.merchantId)) throw new NormalizationError('merchantId ausente ou não-UUID', 'getItem.merchantId');
  let optionGroups: Field<NormalizedOptionGroup[]>;
  if (!('optionGroups' in o) || o.optionGroups === undefined) optionGroups = ABSENT;
  else if (o.optionGroups === null) optionGroups = { state: 'NULL' };
  else if (!Array.isArray(o.optionGroups)) optionGroups = { state: 'INVALID', raw: o.optionGroups };
  else optionGroups = present(o.optionGroups.map((g, i) => normalizeOptionGroup(g, `getItem.optionGroups[${i}]`)));
  return {
    source: 'getItem',
    itemId: o.itemId,
    merchantId: o.merchantId,
    itemName: readString(o, 'itemName'),
    itemDescription: readString(o, 'itemDescription'),
    imageUrl: readString(o, 'itemImageUrl'),
    merchantName: readString(o, 'merchantName'),
    merchantMinimumOrderAmount: readMoney(o, 'merchantMinimumOrderAmount'),
    price: normalizePromotion(o),
    optionGroups,
    appDeeplink: readField(o, 'appDeeplink', isString),
    dietaryAttributes: ABSENT,
    allergens: ABSENT,
    unknownFields: unknownKeys(o, DETAIL_KEYS),
  };
}

/** Todas as opções do item, indexadas por optionId. */
export function indexOptions(detail: NormalizedItemDetail): Map<string, { option: NormalizedOption; group: NormalizedOptionGroup }> {
  const map = new Map<string, { option: NormalizedOption; group: NormalizedOptionGroup }>();
  for (const group of val(detail.optionGroups) ?? []) for (const option of group.options) map.set(option.optionId, { option, group });
  return map;
}
