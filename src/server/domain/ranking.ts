// F4 — Classificação de elegibilidade + ranking explicável dos candidatos (requirements FR-7/FR-8).
//
// Ordem das decisões: as restrições OBRIGATÓRIAS são avaliadas em domain/constraints.ts e
// domain/eligibility.ts ANTES daqui. Este módulo só pontua quem já é ELIGIBLE; nenhuma pontuação
// compensa restrição obrigatória (preço, promoção, avaliação e preferência nunca alteram categoria).
//
// Política de dado ausente (explícita):
//  - critério sem informação suficiente ⇒ `status: 'NO_DATA'` e `score: null` — NUNCA um valor inventado;
//  - o total é a média ponderada SOMENTE dos critérios avaliados (o peso do critério NO_DATA é
//    redistribuído entre os demais) APENAS para diagnóstico, com cobertura explícita;
//  - score não ordena: DEC-01 D9 exige chaves estritas, desconhecidos depois dos conhecidos.
// Evidência de preferência (issue #9): só a configuração EFETIVAMENTE avaliada pontua.
//  - fontes: nome/descrição do item-base + opções de `evaluation.selection` (as mesmas que compõem
//    o preço avaliado); nome do estabelecimento e adicionais disponíveis NÃO selecionados nunca
//    contam como ingrediente presente;
//  - negações explícitas ("sem bacon", "zero açúcar", "livre de lactose") não são presença;
//  - ausência de termo não prova ausência: para ingrediente evitado sem evidência ⇒ `NO_DATA`
//    (+ `dataLimitations`), nunca nota máxima; `NO_DATA` não é nota zero;
//  - preço e sinais de preferência referem-se SEMPRE à mesma configuração avaliada.
// Normalização:
//  - preço/entrega/avaliação: min–max entre os candidatos ELEGIBLE desta consulta (0–1);
//  - preferências e contexto: valores absolutos 0–1 já derivados dos dados (não dependem do conjunto);
//  - empate de min–max (valores iguais) ⇒ 0.5 neutro.
// Determinismo: funções puras — sem fetch, relógio ou aleatoriedade. Empates: merchantId → itemId.

import type { EligibilityResult, Issue, UserConstraints } from './eligibility.js';
import { checkCap } from './eligibility.js';
import { blockedOptions, findTermMention, normalizeText, preferenceAvoidedOptions, type TriState } from './constraints.js';
import { validateSelection, type ConfigValidation, type OptionSelection } from './configuration.js';
import { computePrice, type PriceBreakdown } from './pricing.js';
import { val } from './fields.js';
import { formatCents } from './money.js';
import type { NormalizedItemDetail, NormalizedListingItem } from './normalize.js';

// ---------------- classificação (segurança antes de qualquer pontuação) ----------------

export type EligibilityCategory = 'ELIGIBLE' | 'BLOCKED' | 'NEEDS_VERIFICATION';

/** Incompatibilidade identificada: não entra no ranking nem em pendentes. */
const INCOMPATIBILITY_CODES = new Set<string>([
  'MERCHANT_CLOSED',
  'RESTRICTION_FAIL',
  'OVER_ITEM_BUDGET',
  'OVER_ORDER_BUDGET',
  'NO_VALID_CONFIGURATION',
  'CONFIG_UNKNOWN_OPTION',
  'CONFIG_INVALID_QUANTITY',
  'CONFIG_BELOW_MIN',
  'CONFIG_ABOVE_MAX',
  'CONFIG_BLOCKED_OPTION',
]);

/** Falta de informação: não dá para confirmar a compatibilidade (nunca vira PASS nem "seguro"). */
const INSUFFICIENT_DATA_CODES = new Set<string>([
  'NOT_DETAILED',
  'RESTRICTION_UNVERIFIED',
  'ALLERGY_UNVERIFIED',
  'ALLERGY_OPTIONS_UNVERIFIED',
  'ITEM_BUDGET_UNVERIFIED',
  'ORDER_BUDGET_UNVERIFIED',
  'PRICE_UNAVAILABLE',
  'PRICE_UNVERIFIED',
  'CONFIG_UNVERIFIED',
  'AVAILABILITY_UNKNOWN',
]);

// DOM-01: apenas métricas conhecidas são classificadas como limites locais.
for (const metric of ['MAXDELIVERYTIMEMINUTES', 'MAXDELIVERYFEE', 'MAXDISTANCEKM', 'MINRATING', 'ONLYWITHPROMOTION']) {
  INCOMPATIBILITY_CODES.add(`LIMIT_${metric}_EXCEEDED`);
  INSUFFICIENT_DATA_CODES.add(`LIMIT_${metric}_UNVERIFIED`);
}

/**
 * Particiona um candidato em ELIGIBLE | BLOCKED | NEEDS_VERIFICATION a partir dos blockers já
 * calculados por `evaluateCandidate`. Incompatibilidade identificada tem precedência sobre falta de
 * informação; código desconhecido é tratado como incompatibilidade (conservador: não recomendar).
 * Um candidato sem blockers é ELIGIBLE (equivalente a `evaluation.eligible === true`).
 */
export function classifyBlockers(blockers: readonly Pick<Issue, 'code'>[]): EligibilityCategory {
  if (blockers.length === 0) return 'ELIGIBLE';
  // Confirmado OU código não reconhecido prevalece sobre pendências conhecidas.
  // BLOCKED por código desconhecido é um fallback conservador, não prova de incompatibilidade.
  if (blockers.some((b) => INCOMPATIBILITY_CODES.has(b.code) || !INSUFFICIENT_DATA_CODES.has(b.code))) return 'BLOCKED';
  return 'NEEDS_VERIFICATION';
}

// ---------------- pesos ----------------

export const CRITERIA = ['PREFERENCES', 'CONTEXT', 'PRICE', 'DELIVERY', 'RATING'] as const;
export type Criterion = (typeof CRITERIA)[number];
export type Weights = Record<Criterion, number>;

export const DEFAULT_WEIGHTS: Weights = { PREFERENCES: 0.35, CONTEXT: 0.25, PRICE: 0.2, DELIVERY: 0.1, RATING: 0.1 };

export const PRIORITIES = ['ECONOMY', 'SPEED', 'PREFERENCES'] as const;
export type Priority = (typeof PRIORITIES)[number];

/** Pesos diagnósticos legados: dobrar peso NÃO substitui as chaves estritas de DEC-01 D9. */
export const PRIORITY_CRITERION: Record<Priority, Criterion> = { ECONOMY: 'PRICE', SPEED: 'DELIVERY', PREFERENCES: 'PREFERENCES' };
export const PRIORITY_BOOST_FACTOR = 2;

export function weightsFor(priority?: Priority | null): Weights {
  const w: Weights = { ...DEFAULT_WEIGHTS };
  if (priority) w[PRIORITY_CRITERION[priority]] *= PRIORITY_BOOST_FACTOR;
  return w;
}

// ---------------- entrada/saída ----------------

export interface UserPreferences {
  /** Tipos de comida preferidos (ex.: "pizza"). */
  foodTypes?: string[];
  /** Ingredientes de que a pessoa gosta. */
  likedIngredients?: string[];
  /** Ingredientes a evitar POR PREFERÊNCIA (nunca vira restrição obrigatória). */
  avoidedIngredients?: string[];
  /** Ocasião da refeição (ex.: "almoco", "lanche"). */
  occasion?: string;
  /** Prioridade entre economia, rapidez e preferências pessoais. */
  priority?: Priority;
}

export interface ContextLimits {
  maxDistanceKm?: number;
  maxDeliveryTimeMinutes?: number;
  minRating?: number;
  maxDeliveryFee?: number;
}

export interface RankCandidate {
  evaluation: EligibilityResult;
  listing: NormalizedListingItem;
  /** getItem quando disponível (texto de preferências); null ⇒ usa só a listagem. */
  detail: NormalizedItemDetail | null;
}

export interface CriterionScore {
  criterion: Criterion;
  /** Peso configurado (após prioridade). */
  weight: number;
  /** Peso efetivamente aplicado neste candidato (0 quando NO_DATA). */
  effectiveWeight: number;
  status: 'SCORED' | 'NO_DATA';
  /** 0–1; null somente quando status é NO_DATA. */
  score: number | null;
  /** effectiveWeight × score; null quando NO_DATA. A soma é o score total. */
  contribution: number | null;
  /** Como o critério foi calculado (fonte e normalização). */
  basis: string;
  reasons: string[];
  dataLimitations: string[];
}

/**
 * Configuração alternativa sugerida para atender a uma preferência (issue #9, caso F).
 * Nunca substitui a configuração avaliada: é uma proposta explícita, revalidada do zero —
 * seleção com IDs reais do getItem, configuração `VALID`, restrições obrigatórias (opção não
 * bloqueada) e orçamento reavaliados, preço recalculado. Nada aqui é recomendado como elegível
 * sem essas verificações.
 */
export interface AlternativeConfiguration {
  /** Termo da preferência que a alternativa atenderia. */
  forPreference: string;
  /** Seleção explícita completa: configuração avaliada + opção sugerida (optionIds reais). */
  selection: OptionSelection[];
  addedOption: { optionId: string; optionGroupId: string; name: string | null; additionalPrice: number | null };
  /** Revalidação da seleção proposta (exigido status VALID). */
  configuration: ConfigValidation;
  /** Preço recalculado para a seleção proposta. */
  pricing: PriceBreakdown;
  /** Tetos de orçamento reavaliados sobre o preço novo (null = sem teto informado). */
  budget: { itemPrice: TriState | null; orderTotal: TriState | null };
  /** Explicação (seleção, restrições, orçamento e preço revalidados; nada foi substituído). */
  reasons: string[];
}

export interface RankedRecommendation {
  itemId: string;
  merchantId: string;
  /** Posição no ranking, começando em 1. */
  rank: number;
  score: number | null;
  coverage: DataCoverage;
  orderingKeys: OrderingKeys;
  criteria: CriterionScore[];
  reasons: string[];
  dataLimitations: string[];
  /** Proposta revalidada ou null. A configuração avaliada (e seu preço) nunca é trocada em silêncio. */
  alternativeConfiguration: AlternativeConfiguration | null;
}

export interface RankingResult {
  contractVersion: typeof RANKING_CONTRACT_VERSION;
  status: 'RANKED' | 'PRIORITY_REQUIRED';
  orderingPolicy: 'DEC_01_D9';
  scoreInterpretation: 'RELATIVE_DIAGNOSTIC_NOT_PROBABILITY';
  missingDataPolicy: 'UNKNOWN_LAST_SCORE_DIAGNOSTIC_ONLY';
  clarification: string | null;
  weights: Weights;
  priority: Priority | null;
  maxRecommendations: number;
  /** Candidatos ELEGIBLE recebidos pelo ranking. */
  eligibleConsidered: number;
  /** Candidatos com score total não nulo. */
  eligibleScored: number;
  recommendations: RankedRecommendation[];
  notes: string[];
}

export interface DataCoverage {
  scoredCriteria: Criterion[];
  noDataCriteria: Criterion[];
  scoredCount: number;
  totalCount: number;
  configuredWeight: number;
  scoredWeight: number;
  /** Fração do peso configurado sustentada por critérios com algum sinal avaliável, não confiança. */
  weightedFraction: number;
}

export interface OrderingKeys {
  /** Total completo estimado em centavos; nunca subtotal parcial nem extremo de faixa. */
  estimatedTotalCents: number | null;
  /** Máximo observado do intervalo de entrega, em minutos; sem máximo ⇒ desconhecido. */
  estimatedMinutes: number | null;
  /** Contagem de preferências explicitamente atendidas, não média só das evidências restantes. */
  preferencesSatisfied: number | null;
}

export const RANKING_CONTRACT_VERSION = '2.0' as const;

export const MAX_RECOMMENDATIONS = 4;

// ---------------- helpers ----------------

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const round4 = (v: number) => Math.round(v * 10000) / 10000;
const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const brl = formatCents;
const km = (v: number) => `${Math.round(v * 100) / 100} km`;

/** Folga relativa ao limite informado: 1 = sem consumo do limite, 0 = no limite. Limite 0 ⇒ só vazio serve. */
const headroom = (value: number, limit: number) => (limit > 0 ? clamp01(1 - value / limit) : value <= 0 ? 1 : 0);

function minMax(values: (number | null)[], higherIsBetter: boolean): Map<number, number | null> {
  const out = new Map<number, number | null>();
  const idx = values.map((v, i) => ({ i, v })).filter((x): x is { i: number; v: number } => x.v !== null);
  for (let i = 0; i < values.length; i++) if (values[i] === null) out.set(i, null);
  if (!idx.length) return out;
  let min = Infinity;
  let max = -Infinity;
  for (const { v } of idx) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (max - min < 1e-9) {
    for (const { i } of idx) out.set(i, 0.5); // conjunto uniforme ⇒ neutro, não "melhor"
    return out;
  }
  for (const { i, v } of idx) out.set(i, round4(higherIsBetter ? (v - min) / (max - min) : (max - v) / (max - min)));
  return out;
}

interface Signal {
  score: number | null;
  basis: string;
  reasons: string[];
  dataLimitations: string[];
}

const noData = (basis: string, dataLimitations: string[] = []): Signal => ({ score: null, basis, reasons: [], dataLimitations });

// ---------------- dados brutos (só o que o pipeline já coletou) ----------------

/**
 * Evidência textual da configuração EFETIVAMENTE avaliada (issue #9):
 *  - `evaluated`: nome/descrição do item-base (listagem + getItem) + textos das opções que compõem
 *    `evaluation.selection` — exatamente o que foi escolhido e o que o preço avaliado representa;
 *  - `unselected`: opções disponíveis FORA da seleção — nunca são presença (só explicam NO_DATA).
 * O nome do estabelecimento (listagem/getItem) deliberadamente fica fora: loja chamada "Bacon House"
 * não é evidência de ingrediente do produto.
 */
interface ConfigEvidence {
  evaluated: string;
  unselected: string;
}

function configEvidence(c: RankCandidate): ConfigEvidence {
  const d = c.detail;
  const base = [val(c.listing.itemName), d ? val(d.itemName) : undefined, d ? val(d.itemDescription) : undefined].filter(
    (x): x is string => Boolean(x),
  );
  const chosenIds = new Set((c.evaluation.selection?.options ?? []).map((o) => o.optionId));
  const chosen: string[] = [];
  const available: string[] = [];
  if (d) {
    for (const g of val(d.optionGroups) ?? []) {
      for (const o of g.options) {
        const text = `${val(o.name) ?? ''} ${val(o.description) ?? ''}`.trim();
        (chosenIds.has(o.optionId) ? chosen : available).push(text);
      }
    }
  }
  return { evaluated: normalizeText([...base, ...chosen].join(' ')), unselected: normalizeText(available.join(' ')) };
}

type TextEvidence = /** termo afirmado na configuração avaliada */ 'PRESENT' | /** só em negação ("sem X") */ 'NEGATED' |
  /** só em opção disponível não selecionada */ 'ONLY_UNSELECTED' | /** nenhuma menção */ 'NONE';

function evidenceFor(ev: ConfigEvidence, term: string): TextEvidence {
  const inConfig = findTermMention(ev.evaluated, term);
  if (inConfig.asserted) return 'PRESENT';
  if (inConfig.mentioned) return 'NEGATED';
  if (findTermMention(ev.unselected, term).mentioned) return 'ONLY_UNSELECTED';
  return 'NONE';
}

/** Só total completo de valor único é uma chave conhecida. Faixa não vira ponto médio/mínimo. */
function pricePoint(c: RankCandidate): {
  value: number | null;
  limitation: string | null;
  discountPercent: number;
  /** Qual configuração o preço representa — a mesma que sustenta os sinais de preferência. */
  source: 'SELECTED' | 'MINIMUM_CONFIGURABLE' | null;
} {
  const selected = c.evaluation.pricing.selected;
  const p = selected ?? c.evaluation.pricing.minimumConfigurable;
  if (!p) return { value: null, limitation: 'preço não calculado para este item', discountPercent: 0, source: null };
  const source = selected ? 'SELECTED' : 'MINIMUM_CONFIGURABLE';
  const { min, max } = p.estimatedTotalRange;
  const discountPercent = p.unit.discountPercent;
  const validCents = (v: number | null) => v !== null && Number.isSafeInteger(v) && v >= 0;
  if (validCents(min) && min === max && p.service.status === 'KNOWN' && p.delivery.fee !== null && p.status === 'ESTIMATED') {
    return { value: min, limitation: null, discountPercent, source };
  }
  return { value: null, limitation: `total completo desconhecido ou em faixa (${min === null ? '?' : brl(min)}–${max === null ? '?' : brl(max)}); ` +
    'subtotal parcial e extremos da faixa não são usados como total; taxas ausentes não valem zero', discountPercent, source };
}

const ratingOf = (c: RankCandidate): number | null => val(c.listing.merchant.rating.value) ?? null;
const ratingCountOf = (c: RankCandidate): number | null => val(c.listing.merchant.rating.count) ?? null;
const distanceOf = (c: RankCandidate): number | null => val(c.listing.merchant.distanceKm) ?? null;

/** Intervalo da entrega (min–max) da listagem; null quando não informado. */
function etaRange(c: RankCandidate): { min: number | null; max: number | null } {
  const d = val(c.listing.merchant.delivery);
  if (!d) return { min: null, max: null };
  return { min: val(d.etaMinutes.min) ?? null, max: val(d.etaMinutes.max) ?? null };
}

/** Mesmo máximo observado usado pela validação de prazo DOM-01, sem inventar extremos. */
function estimatedMinutes(c: RankCandidate): number | null {
  const { min, max } = etaRange(c);
  const delivery = val(c.listing.merchant.delivery);
  if (!delivery || [delivery.etaMinutes.min, delivery.etaMinutes.max].some((f) => f.state === 'INVALID')) return null;
  if (max === null || !Number.isFinite(max) || max < 0 || (min !== null && (!Number.isFinite(min) || min < 0 || min > max))) return null;
  return max;
}

const deliveryFeeOf = (c: RankCandidate): number | null => val(c.listing.merchant.delivery)?.effectiveFee ?? null;

// ---------------- critérios ----------------

interface PreferenceSignal extends Signal {
  /** Configuração alternativa revalidada proposta para atender a uma preferência (ou null). */
  alternative: AlternativeConfiguration | null;
  satisfied: number | null;
}

/**
 * Propõe UMA configuração alternativa que atenderia a `term`: adiciona uma única opção disponível,
 * fora da seleção avaliada, cujo texto afirma o termo. A proposta é revalidada do zero — seleção com
 * IDs reais, `validateSelection` (bloqueios de alergia/obrigatórias), `computePrice` e teto de
 * orçamento (`checkCap`) — e nunca substitui a configuração avaliada: é apresentada como sugestão
 * explícita. Retorna null quando nenhuma opção segura existe (ex.: alergia bloqueia, grupo sem vaga,
 * configuração inválida ou preço acima do teto).
 */
function proposeAlternative(
  c: RankCandidate,
  term: string,
  ev: ConfigEvidence,
  constraints: UserConstraints | null | undefined,
): AlternativeConfiguration | null {
  const d = c.detail;
  if (!d || d.optionGroups.state !== 'PRESENT') return null;
  const quantity = (c.evaluation.pricing.selected ?? c.evaluation.pricing.minimumConfigurable)?.quantity;
  if (quantity === undefined) return null;
  const chosen = c.evaluation.selection?.options ?? [];
  const chosenIds = new Set(chosen.map((o) => o.optionId));
  const blocked = blockedOptions(c.evaluation.restrictions);
  const avoided = preferenceAvoidedOptions(c.evaluation.restrictions);
  // Termo só presente em opção não selecionada (ou ausente) é o candidato natural à alternativa.
  const inEvaluated = findTermMention(ev.evaluated, term);
  if (inEvaluated.asserted || inEvaluated.mentioned) return null;

  for (const g of d.optionGroups.value) {
    const max = val(g.maxSelections);
    const selectedInGroup = chosen.filter((s) => g.options.some((o) => o.optionId === s.optionId)).length;
    // Grupo com max conhecido e ainda com vaga: única configuração verificável para propor.
    if (max === undefined || selectedInGroup + 1 > max) continue;
    for (const o of g.options) {
      if (chosenIds.has(o.optionId) || blocked.has(o.optionId)) continue;
      const text = `${val(o.name) ?? ''} ${val(o.description) ?? ''}`.trim();
      if (!findTermMention(text, term).asserted) continue;
      const selection: OptionSelection[] = [...chosen, { optionId: o.optionId, quantity: 1 }];
      const configuration = validateSelection(d, selection, blocked, avoided);
      if (configuration.status !== 'VALID') continue;
      let pricing: PriceBreakdown;
      try { pricing = computePrice({ detail: d, listing: c.listing, selection, quantity, kind: 'SELECTED' }); }
      catch (error) {
        if (!(error instanceof RangeError)) throw error;
        continue; // Proposta sem preço seguro não interrompe a recomendação original.
      }
      // A proposta expõe faixas, nunca um escalar derivado de preço incerto.
      if (pricing.status !== 'ESTIMATED') {
        pricing.unitTotal = null;
        pricing.itemsSubtotal = null;
        pricing.estimatedTotal = null;
      }
      const budget = { itemPrice: null as TriState | null, orderTotal: null as TriState | null };
      const cap = constraints?.budget;
      if (cap?.maxItemPrice !== undefined) budget.itemPrice = checkCap(pricing.unitTotalRange, cap.maxItemPrice);
      if (cap?.maxOrderTotal !== undefined) budget.orderTotal = checkCap(pricing.estimatedTotalRange, cap.maxOrderTotal);
      if (cap?.maxItemPrice !== undefined && budget.itemPrice !== 'PASS') continue;
      if (cap?.maxOrderTotal !== undefined && budget.orderTotal !== 'PASS') continue;
      const range = pricing.unitTotalRange;
      const total = range.min !== null && range.min === range.max ? brl(range.min)
        : `${range.min === null ? '?' : brl(range.min)}–${range.max === null ? '?' : brl(range.max)} (preço incerto)`;
      const reason =
        `configuração alternativa revalidada (não aplicada — sugestão): adicionar "${val(o.name) ?? o.optionId}" atenderia a "${term}"; ` +
        `preço recalculado por unidade ${total}; a configuração avaliada e o preço permanecem os mesmos`;
      return {
        forPreference: term,
        selection,
        addedOption: { optionId: o.optionId, optionGroupId: g.optionGroupId, name: val(o.name) ?? null, additionalPrice: val(o.additionalPrice) ?? null },
        configuration,
        pricing,
        budget,
        reasons: [reason],
      };
    }
  }
  return null;
}

function preferencesSignal(c: RankCandidate, prefs: UserPreferences | null | undefined, constraints: UserConstraints | null | undefined): PreferenceSignal {
  const scores: number[] = [];
  const reasons: string[] = [];
  const dataLimitations: string[] = [];
  let totalSignals = 0;

  // Preferências declaradas como PREFERENCE nas restrições (nunca bloqueiam — só pontuam).
  for (const r of c.evaluation.restrictions) {
    if (r.requirement !== 'PREFERENCE') continue;
    totalSignals++;
    const name = r.restriction.code;
    if (r.status === 'PASS') {
      scores.push(1);
      reasons.push(`preferência ${name} atendida (${r.source})`);
    } else if (r.status === 'FAIL') {
      scores.push(0);
    } else {
      dataLimitations.push(`preferência ${name} não verificável: ${r.reasons.join('; ') || 'informação indisponível'}`);
    }
  }

  const terms = (xs?: string[]) => (xs ?? []).filter((x) => Boolean(normalizeText(x)));
  const foodTypes = terms(prefs?.foodTypes);
  const liked = terms(prefs?.likedIngredients);
  const avoided = terms(prefs?.avoidedIngredients);
  const occasion = prefs?.occasion && normalizeText(prefs.occasion) ? prefs.occasion : null;

  const hasTextSignals = Boolean(foodTypes.length || liked.length || avoided.length || occasion);
  let alternative: AlternativeConfiguration | null = null;

  if (hasTextSignals) {
    const ev = configEvidence(c);
    const noDescription = !c.detail || c.detail.itemDescription.state !== 'PRESENT';

    const applyPositive = (term: string, what: string) => {
      totalSignals++;
      const e = evidenceFor(ev, term);
      if (e === 'PRESENT') {
        scores.push(1);
        reasons.push(`configuração avaliada menciona "${term}" (${what}) — heurística`);
        return;
      }
      if (e === 'NEGATED') {
        scores.push(0);
        reasons.push(`menção negativa de "${term}" na configuração avaliada (ex.: "sem ${term}") — indício de ausência; sem bônus (heurística)`);
        return;
      }
      scores.push(0);
      dataLimitations.push(
        e === 'ONLY_UNSELECTED'
          ? `"${term}" aparece só em adicional disponível fora da configuração avaliada (não selecionado) — sem bônus; texto não prova ausência`
          : `sem evidência textual de "${term}" na configuração avaliada${noDescription ? ' (item sem descrição no iFood)' : ''} — heurística não comprova presença`,
      );
    };

    const applyAvoided = (term: string) => {
      totalSignals++;
      const e = evidenceFor(ev, term);
      if (e === 'PRESENT') {
        scores.push(0);
        reasons.push(`configuração avaliada menciona "${term}" — ingrediente evitado presente (heurística)`);
        return;
      }
      if (e === 'NEGATED') {
        scores.push(1);
        reasons.push(`menção negativa de "${term}" na configuração avaliada (ex.: "sem ${term}") — indício de ausência do ingrediente evitado (heurística; não é prova)`);
        dataLimitations.push(`indício de ausência de "${term}" baseado em texto do produto — não é confirmação (confirme com a loja)`);
        return;
      }
      // NO_DATA: ausência de termo não prova ausência — nunca nota máxima (issue #9).
      dataLimitations.push(
        e === 'ONLY_UNSELECTED'
          ? `ingrediente evitado "${term}": presente só em adicional não selecionado — fora da configuração avaliada; sem evidência sobre o item-base (NO_DATA)`
          : `ingrediente evitado "${term}": sem evidência textual na configuração avaliada${noDescription ? ' (item sem descrição no iFood)' : ''} — NO_DATA (não é nota máxima): ausência do termo não prova ausência`,
      );
    };

    for (const t of foodTypes) applyPositive(t, 'tipo de comida pedido');
    for (const t of liked) applyPositive(t, 'ingrediente de que você gosta');
    for (const t of avoided) applyAvoided(t);
    if (occasion) applyPositive(occasion, 'ocasião da refeição');

    // Caso F: se algum ingrediente de que a pessoa gosta não está evidente na configuração avaliada,
    // propõe (nunca aplica) uma configuração alternativa revalidada que o incluiria.
    const target = liked.find((t) => {
      const e = evidenceFor(ev, t);
      return e === 'ONLY_UNSELECTED' || e === 'NONE';
    });
    if (target) alternative = proposeAlternative(c, target, ev, constraints);

    dataLimitations.push(
      'Preferências por texto usam só a configuração EFETIVAMENTE avaliada (nome/descrição do item-base + opções selecionadas): ' +
        'nome do estabelecimento e adicionais não selecionados não contam como ingrediente presente; ' +
        'negações ("sem X") não são presença; ausência do termo não prova ausência — heurística, nunca usada para segurança',
    );
  }

  if (alternative) reasons.push(...alternative.reasons);

  if (!scores.length) {
    const informed = totalSignals > 0;
    dataLimitations.push(informed ? 'preferências informadas, mas nenhuma pôde ser avaliada com os dados disponíveis' : 'nenhuma preferência informada');
    return { ...noData('Nenhum sinal de preferência disponível.', dataLimitations), alternative, satisfied: null };
  }
  return {
    score: round4(avg(scores)),
    basis: `Média de ${scores.length} de ${totalSignals} sinal(is) de preferência avaliável(eis) (restrições PREFERENCE + texto da configuração avaliada; sinais sem evidência viram NO_DATA).`,
    reasons,
    dataLimitations,
    alternative,
    satisfied: scores.filter((s) => s === 1).length,
  };
}

function contextSignal(c: RankCandidate, limits?: ContextLimits | null): Signal {
  const scores: number[] = [];
  const reasons: string[] = [];
  const dataLimitations: string[] = [];
  const stated: string[] = [];

  if (limits?.maxDistanceKm !== undefined) {
    stated.push('distância');
    const v = distanceOf(c);
    if (v === null) dataLimitations.push('distância até a loja não informada pelo iFood');
    else {
      scores.push(headroom(v, limits.maxDistanceKm));
      reasons.push(`${km(v)} dos ${km(limits.maxDistanceKm)} permitidos`);
    }
  }
  if (limits?.maxDeliveryTimeMinutes !== undefined) {
    stated.push('tempo de entrega');
    const eta = estimatedMinutes(c);
    if (eta === null) dataLimitations.push('tempo de entrega não informado pelo iFood');
    else {
      scores.push(headroom(eta, limits.maxDeliveryTimeMinutes));
      reasons.push(`entrega em até ~${eta} min dos ${limits.maxDeliveryTimeMinutes} min permitidos`);
    }
  }
  if (limits?.maxDeliveryFee !== undefined) {
    stated.push('taxa de entrega');
    const fee = deliveryFeeOf(c);
    if (fee === null) dataLimitations.push('taxa de entrega não informada pelo iFood');
    else {
      scores.push(headroom(fee, limits.maxDeliveryFee));
      reasons.push(`taxa ${brl(fee)} dos ${brl(limits.maxDeliveryFee)} permitidos`);
    }
  }
  if (limits?.minRating !== undefined) {
    stated.push('avaliação mínima');
    const r = ratingOf(c);
    if (r === null) dataLimitations.push('avaliação do estabelecimento não informada pelo iFood');
    else {
      const lo = limits.minRating;
      scores.push(lo >= 5 ? (r >= 5 ? 1 : 0) : clamp01((r - lo) / (5 - lo)));
      reasons.push(`${r} ★ (mínimo pedido ${lo})`);
    }
  }

  if (!stated.length) return noData('Nenhum limite de contexto (distância/tempo/taxa/avaliação) informado na requisição.');
  if (!scores.length) {
    return noData(`Limites informados (${stated.join(', ')}), mas o iFood não informou esses dados para este item.`, dataLimitations);
  }
  return {
    score: round4(avg(scores)),
    basis: `Folga relativa (0–1) em ${scores.length} de ${stated.length} limite(s) informado(s): ${stated.join(', ')}.`,
    reasons,
    dataLimitations,
  };
}

function priceSignal(c: RankCandidate, score: number | null, eligibleCount: number): Signal {
  const { value, limitation, discountPercent, source } = pricePoint(c);
  const dataLimitations = limitation ? [limitation] : [];
  // O preço é o da MESMA configuração que sustenta os sinais de preferência (seleção do usuário
  // ou configuração mínima) — nunca se mistura a pontuação de uma configuração com o preço de outra.
  const config = source === 'SELECTED' ? 'configuração selecionada' : 'configuração mínima (sem adicionais opcionais não escolhidos)';
  const p = c.evaluation.pricing.selected ?? c.evaluation.pricing.minimumConfigurable;
  const reasons = p ? [`${config}: ${p.quantity} unidade(s); preço por unidade em faixa ` +
    `${p.unitTotalRange.min === null ? '?' : brl(p.unitTotalRange.min)}–${p.unitTotalRange.max === null ? '?' : brl(p.unitTotalRange.max)}; ` +
    `entrega ${p.delivery.fee === null ? 'desconhecida' : brl(p.delivery.fee)}${discountPercent > 0 ? `; promoção de ${discountPercent}% já aplicada` : ''}`] : [];
  if (value === null) return { ...noData('Custo total completo indisponível para comparar economia.', dataLimitations), reasons };
  reasons.push(`custo total estimado ${brl(value)} da ${config} (itens × quantidade + entrega + serviço); não é cotação confirmada`);
  if (score === 1 && eligibleCount > 1) reasons.push('menor custo total estimado entre as opções elegíveis com total conhecido');
  return {
    score,
    basis: `Custo total estimado completo da ${config}, em centavos, normalizado (min–max) entre elegíveis com total conhecido; ${eligibleCount} elegíveis na consulta.`,
    reasons,
    dataLimitations,
  };
}

function deliverySignal(c: RankCandidate, etaScore: number | null, eligibleCount: number): Signal {
  const dataLimitations: string[] = [];
  const reasons: string[] = [];
  const { min, max } = etaRange(c);
  if (min !== null && max !== null) reasons.push(`entrega estimada ${min}–${max} min`);
  else if (max !== null || min !== null) reasons.push(`entrega estimada ~${max ?? min} min`);
  else dataLimitations.push('tempo de entrega não informado pelo iFood');
  const minutes = estimatedMinutes(c);
  if (minutes === null) return noData('Prazo indisponível para comparar rapidez.', ['prazo máximo estimado ausente ou inválido; nenhum prazo foi inventado']);
  if (min === null) dataLimitations.push('limite inferior do prazo não informado; usado somente o máximo observado');
  reasons.push(`rapidez compara o máximo observado: ${minutes} min; frete não compõe esta dimensão`);
  return {
    score: etaScore,
    basis: `Máximo observado do prazo normalizado (min–max) entre ${eligibleCount} elegível(eis); frete só entra no custo.`,
    reasons,
    dataLimitations,
  };
}

function ratingSignal(c: RankCandidate, score: number | null): Signal {
  const v = ratingOf(c);
  if (v === null) return noData('Avaliação do estabelecimento não informada pelo iFood.', ['avaliação do estabelecimento não informada pelo iFood']);
  const count = ratingCountOf(c);
  const dataLimitations = count === null ? ['quantidade de avaliações não informada pelo iFood'] : [];
  return {
    score,
    basis: 'Avaliação do estabelecimento normalizada (min–max) entre os candidatos elegíveis.',
    reasons: [`avaliação ${v} ★${count === null ? '' : ` (${count} avaliações)`}`],
    dataLimitations,
  };
}

// ---------------- montagem ----------------

function criterionOf(criterion: Criterion, weight: number, s: Signal): CriterionScore {
  const scored = s.score !== null;
  return {
    criterion,
    weight,
    effectiveWeight: 0,
    status: scored ? 'SCORED' : 'NO_DATA',
    score: s.score,
    contribution: null,
    basis: s.basis,
    reasons: s.reasons,
    dataLimitations: s.dataLimitations,
  };
}

/**
 * Pontua e ordena os candidatos já ELIGIBLE (defesa em profundidade: candidatos com blockers são
 * descartados aqui, mesmo que o chamador os passe). DEC-01 D9 ordena por chaves observadas e IDs.
 * Sem ECONOMY/SPEED pede esclarecimento. Score é diagnóstico, sem alterar elegibilidade/ordem.
 */
export function rankCandidates(
  candidates: readonly RankCandidate[],
  preferences?: UserPreferences | null,
  context?: ContextLimits | null,
  constraints?: UserConstraints | null,
): RankingResult {
  const priority = preferences?.priority ?? null;
  const weights = weightsFor(priority);
  const eligible = candidates.filter((c) => c.evaluation.eligible && classifyBlockers(c.evaluation.blockers) === 'ELIGIBLE');
  const n = eligible.length;
  const supportedPriority = priority === 'ECONOMY' || priority === 'SPEED';
  const metadata = {
    contractVersion: RANKING_CONTRACT_VERSION,
    status: supportedPriority ? 'RANKED' as const : 'PRIORITY_REQUIRED' as const,
    orderingPolicy: 'DEC_01_D9' as const,
    scoreInterpretation: 'RELATIVE_DIAGNOSTIC_NOT_PROBABILITY' as const,
    missingDataPolicy: 'UNKNOWN_LAST_SCORE_DIAGNOSTIC_ONLY' as const,
    clarification: supportedPriority ? null : 'Você prefere economia (ECONOMY) ou rapidez (SPEED)?',
  };

  const notes = [
    `Pesos do ranking: preferências ${Math.round(DEFAULT_WEIGHTS.PREFERENCES * 100)}%, contexto ${Math.round(DEFAULT_WEIGHTS.CONTEXT * 100)}%, ` +
      `preço ${Math.round(DEFAULT_WEIGHTS.PRICE * 100)}%, entrega ${Math.round(DEFAULT_WEIGHTS.DELIVERY * 100)}%, avaliação ${Math.round(DEFAULT_WEIGHTS.RATING * 100)}%` +
      (priority ? `; prioridade ${priority} dobra o peso de ${PRIORITY_CRITERION[priority]}` : '') +
      '.',
    'O ranking só recebe candidatos já ELIGIBLE: restrições obrigatórias nunca são compensadas por preço, promoção, avaliação ou preferência.',
    'Critérios sem dado recebem status NO_DATA (score null); redistribuição de pesos é somente diagnóstica e a cobertura é explícita. Score não ordena nem representa probabilidade de satisfação, segurança ou qualidade.',
    'DEC-01 D9: ECONOMY ordena total completo estimado → prazo → preferências atendidas; SPEED ordena prazo → total → preferências atendidas. Desconhecidos depois de conhecidos; empate por merchantId e itemId.',
    'Preferências pontuam somente a configuração avaliada (nome/descrição do item-base + opções selecionadas): nome da loja e adicionais não selecionados não contam como ingrediente; ausência do termo não prova ausência.',
  ];
  if (candidates.length !== n) notes.push(`${candidates.length - n} candidato(s) recebido(s) com bloqueio foram descartados do ranking (defesa em profundidade).`);
  if (!n) notes.push('Nenhuma opção pôde ser confirmada como compatível com as restrições obrigatórias: nenhuma recomendação emitida (as restrições nunca são relaxadas para preencher a lista).');

  if (!supportedPriority) notes.push(metadata.clarification!);
  if (!n || !supportedPriority) {
    return { ...metadata, weights, priority, maxRecommendations: MAX_RECOMMENDATIONS, eligibleConsidered: n, eligibleScored: 0, recommendations: [], notes };
  }

  // Critérios que dependem do conjunto (min–max entre os ELEGIBLE desta consulta).
  const prices = eligible.map(pricePoint);
  const priceScores = minMax(
    prices.map((p) => p.value),
    false,
  );
  const etaScores = minMax(
    eligible.map(estimatedMinutes),
    false,
  );
  const ratingScores = minMax(
    eligible.map(ratingOf),
    true,
  );

  const assembled = eligible.map((c, i) => {
    const prefSignal = preferencesSignal(c, preferences, constraints);
    const criteria: CriterionScore[] = [
      criterionOf('PREFERENCES', weights.PREFERENCES, prefSignal),
      criterionOf('CONTEXT', weights.CONTEXT, contextSignal(c, context)),
      criterionOf('PRICE', weights.PRICE, priceSignal(c, priceScores.get(i) ?? null, n)),
      criterionOf('DELIVERY', weights.DELIVERY, deliverySignal(c, etaScores.get(i) ?? null, n)),
      criterionOf('RATING', weights.RATING, ratingSignal(c, ratingScores.get(i) ?? null)),
    ];

    const scoredWeight = CRITERIA.reduce((s, k) => s + (criteria.find((x) => x.criterion === k)!.score !== null ? weights[k] : 0), 0);
    const configuredWeight = Object.values(weights).reduce((a, b) => a + b, 0);
    const coverage: DataCoverage = {
      scoredCriteria: criteria.filter((cr) => cr.status === 'SCORED').map((cr) => cr.criterion),
      noDataCriteria: criteria.filter((cr) => cr.status === 'NO_DATA').map((cr) => cr.criterion),
      scoredCount: criteria.filter((cr) => cr.status === 'SCORED').length,
      totalCount: criteria.length,
      configuredWeight: round4(configuredWeight),
      scoredWeight: round4(scoredWeight),
      weightedFraction: round4(scoredWeight / configuredWeight),
    };
    const dataLimitations: string[] = [];
    let total: number | null = null;
    if (scoredWeight > 0) {
      let acc = 0;
      for (const cr of criteria) {
        if (cr.score === null) {
          cr.effectiveWeight = 0;
          dataLimitations.push(`critério ${cr.criterion} sem dado (NO_DATA): peso redistribuído apenas no diagnóstico — score não ordena`);
        } else {
          cr.effectiveWeight = round4(weights[cr.criterion] / scoredWeight);
          cr.contribution = round4(cr.effectiveWeight * cr.score);
          acc += cr.contribution;
        }
      }
      total = round4(acc);
    }

    const reasons = criteria.flatMap((cr) => cr.reasons);
    if (!reasons.length && total !== null) reasons.push(`score diagnóstico relativo à consulta: ${total}; não é probabilidade`);
    for (const cr of criteria) dataLimitations.push(...cr.dataLimitations);
    dataLimitations.push(`Cobertura de critérios: ${coverage.scoredCount}/${coverage.totalCount}; fração ponderada ${coverage.weightedFraction}. Não mede certeza nem segurança; critérios parcialmente observados podem conter limitações adicionais.`);
    const preferredLimits = c.evaluation.limits.filter((limit) => limit.requirement === 'PREFERENCE');
    const knownPreferredLimits = preferredLimits.filter((limit) => limit.status !== 'UNKNOWN');
    const orderingKeys: OrderingKeys = {
      estimatedTotalCents: prices[i]!.value,
      estimatedMinutes: estimatedMinutes(c),
      preferencesSatisfied: prefSignal.satisfied === null && !knownPreferredLimits.length ? null
        : (prefSignal.satisfied ?? 0) + preferredLimits.filter((limit) => limit.status === 'PASS').length,
    };
    reasons.push(`Chaves DEC-01 D9 (${priority}): total ${orderingKeys.estimatedTotalCents === null ? 'desconhecido' : brl(orderingKeys.estimatedTotalCents)}, ` +
      `prazo ${orderingKeys.estimatedMinutes === null ? 'desconhecido' : `${orderingKeys.estimatedMinutes} min`}, preferências atendidas ${orderingKeys.preferencesSatisfied ?? 'desconhecidas'}; score apenas diagnóstico`);

    return {
      candidate: c,
      score: total,
      criteria,
      coverage,
      orderingKeys,
      reasons,
      dataLimitations: [...new Set(dataLimitations)],
      alternative: prefSignal.alternative,
    };
  });

  // DEC-01 D9: desconhecido nunca é zero; score não participa dos desempates.
  const compareKnown = (a: number | null, b: number | null, descending = false) =>
    a === null ? (b === null ? 0 : 1) : b === null ? -1 : descending ? b - a : a - b;
  const compareId = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  const ordered = assembled
    .sort((a, b) => {
      const keys = priority === 'ECONOMY' ? ['estimatedTotalCents', 'estimatedMinutes'] as const : ['estimatedMinutes', 'estimatedTotalCents'] as const;
      for (const key of keys) {
        const comparison = compareKnown(a.orderingKeys[key], b.orderingKeys[key]);
        if (comparison) return comparison;
      }
      return compareKnown(a.orderingKeys.preferencesSatisfied, b.orderingKeys.preferencesSatisfied, true)
        || compareId(a.candidate.evaluation.merchantId, b.candidate.evaluation.merchantId)
        || compareId(a.candidate.evaluation.itemId, b.candidate.evaluation.itemId);
    });

  const recommendations: RankedRecommendation[] = ordered.slice(0, MAX_RECOMMENDATIONS).map((x, i) => ({
    itemId: x.candidate.evaluation.itemId,
    merchantId: x.candidate.evaluation.merchantId,
    rank: i + 1,
    score: x.score,
    criteria: x.criteria,
    coverage: x.coverage,
    orderingKeys: x.orderingKeys,
    reasons: x.reasons,
    dataLimitations: x.dataLimitations,
    alternativeConfiguration: x.alternative,
  }));

  const withAlt = recommendations.filter((r) => r.alternativeConfiguration !== null).length;
  if (withAlt) notes.push(`${withAlt} recomendação(ões) inclui(ram) configuração alternativa revalidada (sugestão explícita — a configuração avaliada não foi substituída).`);

  return {
    ...metadata,
    weights,
    priority,
    maxRecommendations: MAX_RECOMMENDATIONS,
    eligibleConsidered: n,
    eligibleScored: assembled.filter((x) => x.score !== null).length,
    recommendations,
    notes,
  };
}
