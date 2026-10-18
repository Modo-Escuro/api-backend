// F3 — Elegibilidade de um candidato: disponibilidade, restrições, configuração, orçamento e preço.
// Restrições obrigatórias são avaliadas ANTES de qualquer ranking (F4, não implementado aqui).
//
// Regra geral: tudo que é OBRIGATÓRIO e não pôde ser verificado (UNKNOWN) bloqueia.
//  - Restrição obrigatória / alergia: só PASS é elegível.
//  - Alergia: nunca PASS (só FAIL/UNKNOWN) ⇒ sempre bloqueia; não há dado do iFood que comprove segurança.
//  - Orçamento informado é teto obrigatório: só PASS (faixa inteira abaixo do teto) é elegível.
//  - Preferência: nunca bloqueia; vira aviso (insumo para o ranking).
// Função pura.

import type { NormalizedItemDetail, NormalizedListingItem } from './normalize.js';
import {
  blockedOptions,
  evaluateRestrictions,
  preferenceAvoidedOptions,
  type RestrictionCheck,
  type RestrictionKey,
  type TriState,
} from './constraints.js';
import { preferredRequiredSelection, validateSelection, type ConfigValidation, type OptionSelection } from './configuration.js';
import { computeMinimumConfigurablePrice, computePrice, type PriceBreakdown, type PriceRange } from './pricing.js';
import type { ItemRestriction } from '../mcp/types.js';
import { cents, formatCents } from './money.js';
import { evaluateLimits, type CandidateLimits, type LimitCheck } from './limits.js';

export interface Budget {
  /** Todos os valores monetários do domínio estão em centavos inteiros. */
  /** Teto por unidade (preço-base + opções). */
  maxItemPrice?: number;
  /** Teto do pedido completo; componente relevante desconhecido impede PASS. */
  maxOrderTotal?: number;
}

export interface UserConstraints {
  restrictions: RestrictionKey[];
  budget?: Budget;
  mandatoryLimits?: CandidateLimits;
  preferredLimits?: CandidateLimits;
}

export interface Issue {
  code: string;
  message: string;
}

export interface CandidateInput {
  listing: NormalizedListingItem;
  /** null = getItem não executado/falhou ⇒ não recomendável (FR-4). */
  detail: NormalizedItemDetail | null;
  serverFilters: ItemRestriction[];
  /** Seleção do usuário; se omitida, avalia-se a configuração mínima. */
  selection?: OptionSelection[];
  quantity?: number;
}

export interface EligibilityResult {
  itemId: string;
  merchantId: string;
  eligible: boolean;
  blockers: Issue[];
  warnings: Issue[];
  availability: TriState;
  restrictions: RestrictionCheck[];
  /** Configuração avaliada: a do usuário, a preferida viável ou a mínima obrigatória. */
  selection: { source: 'USER' | 'MINIMUM_CONFIGURABLE' | 'PREFERENCE'; options: OptionSelection[] } | null;
  configuration: ConfigValidation | null;
  pricing: {
    /** "A partir de" honesto: obrigatórias mais baratas compatíveis com as restrições. */
    minimumConfigurable: PriceBreakdown | null;
    /** Estimativa da configuração do usuário ou da configuração preferida adotada. */
    selected: PriceBreakdown | null;
    /** Sempre null: só o carrinho confirma. */
    confirmedTotal: null;
  };
  budget: { itemPrice: TriState | null; orderTotal: TriState | null };
  limits: LimitCheck[];
  dataLimitations: string[];
}

const label = (r: RestrictionKey) => (r.kind === 'ALLERGY' ? `alergia a ${r.code}` : r.code);
const brl = formatCents;

/** PASS se a faixa inteira cabe no teto; FAIL se nem o mínimo cabe; senão UNKNOWN. */
export function checkCap(range: PriceRange, cap: number): TriState {
  cents(cap);
  if ([range.min, range.max].some((n) => n !== null && (!Number.isSafeInteger(n) || n < 0))) return 'UNKNOWN';
  if (range.min !== null && range.max !== null && range.min > range.max) return 'UNKNOWN';
  if (range.max !== null && range.max <= cap) return 'PASS';
  if (range.min !== null && range.min > cap) return 'FAIL';
  return 'UNKNOWN';
}

const fmtRange = (r: PriceRange) =>
  r.min === null ? 'indisponível' : r.max === r.min ? brl(r.min) : `${brl(r.min)}–${r.max === null ? '?' : brl(r.max)}`;

export function evaluateCandidate(input: CandidateInput, constraints: UserConstraints): EligibilityResult {
  const { listing, detail } = input;
  const blockers: Issue[] = [];
  const warnings: Issue[] = [];
  const dataLimitations: string[] = [];
  const limits = [...evaluateLimits(listing, constraints.mandatoryLimits, 'MANDATORY', detail?.price),
    ...evaluateLimits(listing, constraints.preferredLimits, 'PREFERENCE', detail?.price)];
  for (const check of limits) {
    if (check.status === 'PASS') continue;
    const issue = { code: `${check.requirement === 'MANDATORY' ? 'LIMIT' : 'PREFERRED_LIMIT'}_${check.metric.toUpperCase()}_${check.status === 'FAIL' ? 'EXCEEDED' : 'UNVERIFIED'}`,
      message: `${check.metric}: ${check.status === 'FAIL' ? 'condição não atendida' : 'informação insuficiente para verificar a condição'}` };
    (check.requirement === 'MANDATORY' ? blockers : warnings).push(issue);
  }
  const result = (extra: Partial<EligibilityResult>): EligibilityResult => ({
    itemId: listing.itemId,
    merchantId: listing.merchant.merchantId,
    eligible: blockers.length === 0,
    blockers,
    warnings,
    availability,
    restrictions: [],
    selection: null,
    configuration: null,
    pricing: { minimumConfigurable: null, selected: null, confirmedTotal: null },
    budget: { itemPrice: null, orderTotal: null },
    limits,
    dataLimitations,
    ...extra,
  });

  // ---- disponibilidade (isOpen da listagem)
  const isOpen = listing.merchant.isOpen;
  const availability: TriState = isOpen.state === 'PRESENT' ? (isOpen.value ? 'PASS' : 'FAIL') : 'UNKNOWN';
  if (availability === 'FAIL') blockers.push({ code: 'MERCHANT_CLOSED', message: 'Loja fechada agora' });
  if (availability === 'UNKNOWN') blockers.push({ code: 'AVAILABILITY_UNKNOWN', message: 'Disponibilidade da loja não informada' });

  if (!detail) {
    blockers.push({ code: 'NOT_DETAILED', message: 'Item sem getItem — não recomendável (preço/opções não verificados)' });
    return result({});
  }
  if (detail.itemId !== listing.itemId || detail.merchantId !== listing.merchant.merchantId) {
    throw new Error('getItem não corresponde ao item da listagem (IDs diferentes)');
  }

  // ---- restrições (precedem tudo que for preferência/ranking)
  const restrictions = evaluateRestrictions(constraints.restrictions, { detail, serverFilters: input.serverFilters });
  for (const c of restrictions) {
    const msg = `${label(c.restriction)}: ${c.reasons.join('; ')}`;
    if (c.requirement === 'MANDATORY') {
      if (c.status === 'FAIL') blockers.push({ code: 'RESTRICTION_FAIL', message: msg });
      else if (c.status === 'UNKNOWN') {
        // Decisão de produto (18/10/2026): dado ausente do iFood (ingredientes/alérgenos) vira AVISO, não bloqueio.
        // Conflito informado (FAIL) continua excluindo o item. O aviso precisa chegar ao usuário ("confirme com o restaurante").
        warnings.push({ code: c.restriction.kind === 'ALLERGY' ? 'ALLERGY_UNVERIFIED' : 'RESTRICTION_UNVERIFIED', message: msg });
      } else if (c.restriction.kind === 'ALLERGY' || c.heuristic) warnings.push({ code: 'RESTRICTION_NOTE', message: msg });
    } else if (c.status !== 'PASS') {
      warnings.push({ code: c.status === 'FAIL' ? 'PREFERENCE_FAIL' : 'PREFERENCE_UNKNOWN', message: msg });
    } else if (c.heuristic) warnings.push({ code: 'RESTRICTION_NOTE', message: msg });
  }
  if (constraints.restrictions.length) {
    dataLimitations.push('O iFood não fornece ingredientes nem alérgenos estruturados; verificações textuais são heurísticas e nunca comprovam segurança');
  }
  // Proibição vem só de restrições OBRIGATÓRIAS; preferências não excluem opções (issue #8).
  const blocked = blockedOptions(restrictions);
  const avoided = preferenceAvoidedOptions(restrictions);

  // ---- preço mínimo configurável (sempre calculado)
  const quantity = input.quantity ?? 1;
  let minimum: ReturnType<typeof computeMinimumConfigurablePrice>;
  try { minimum = computeMinimumConfigurablePrice(detail, listing, blocked, quantity, avoided); }
  catch (error) {
    if (!(error instanceof RangeError)) throw error;
    blockers.push({ code: 'PRICE_UNVERIFIED', message: 'Preço ou quantidade fora dos limites de cálculo seguro' });
    return result({ restrictions });
  }
  for (const p of minimum.problems) blockers.push({ code: 'NO_VALID_CONFIGURATION', message: p });

  // ---- configuração avaliada
  let selection: EligibilityResult['selection'] = null;
  if (input.selection) selection = { source: 'USER', options: input.selection };
  else if (minimum.selection) selection = { source: 'MINIMUM_CONFIGURABLE', options: minimum.selection };

  let configuration: ConfigValidation | null = null;
  let selected: PriceBreakdown | null = null;
  if (!input.selection && avoided.size && minimum.selection) {
    const preferred = preferredRequiredSelection(detail, blocked, avoided);
    if (preferred.selection && validateSelection(detail, preferred.selection, blocked).status === 'VALID') {
      try {
        const price = computePrice({ detail, listing, selection: preferred.selection, quantity, kind: 'SELECTED' });
        const cap = constraints.budget;
        const fits = (cap?.maxItemPrice === undefined || checkCap(price.unitTotalRange, cap.maxItemPrice) === 'PASS') &&
          (cap?.maxOrderTotal === undefined || checkCap(price.estimatedTotalRange, cap.maxOrderTotal) === 'PASS');
        if (fits) {
          selection = { source: 'PREFERENCE', options: preferred.selection };
          selected = price;
        }
      } catch (error) {
        if (!(error instanceof RangeError)) throw error;
        // Uma preferência fora do intervalo seguro não invalida o mínimo obrigatório.
      }
    }
  }
  if (selection?.options.some((o) => avoided.has(o.optionId))) {
    warnings.push({ code: 'PREFERENCE_NOT_MET', message: 'Preferência opcional não atendida: mantida a configuração viável sob as condições obrigatórias e os tetos informados' });
  }
  if (selection) {
    configuration = validateSelection(detail, selection.options, blocked, avoided);
    if (configuration.status === 'UNKNOWN') blockers.push({ code: 'CONFIG_UNVERIFIED', message: 'Configuração obrigatória não verificável' });
    const hardCodes = ['UNKNOWN_OPTION', 'INVALID_QUANTITY', 'BELOW_MIN', 'ABOVE_MAX', 'BLOCKED_OPTION'];
    for (const i of configuration.issues) {
      (hardCodes.includes(i.code) ? blockers : warnings).push({ code: `CONFIG_${i.code}`, message: i.message });
    }
    if (input.selection && configuration.status !== 'INVALID') {
      try { selected = computePrice({ detail, listing, selection: input.selection, quantity, kind: 'SELECTED' }); }
      catch (error) {
        if (!(error instanceof RangeError)) throw error;
        blockers.push({ code: 'PRICE_UNVERIFIED', message: 'Preço ou quantidade fora dos limites de cálculo seguro' });
      }
    }
    // Defesa em profundidade: alergia hoje nunca resulta PASS (constraints.ts, issue #3); se um dia resultar,
    // a classificação cobriria só o item-base e nenhuma opção seria verificada.
    if (selection.options.length) {
      for (const c of restrictions) {
        if (c.restriction.kind === 'ALLERGY' && c.status === 'PASS') {
          blockers.push({
            code: 'ALLERGY_OPTIONS_UNVERIFIED',
            message: `${label(c.restriction)}: a classificação do iFood cobre o item-base; ${selection.options.length} opção(ões) da configuração não são verificáveis`,
          });
        }
      }
    }
  }

  // ---- preço avaliado (seleção do usuário, senão o mínimo)
  const price = selected ?? (input.selection ? null : minimum.price);
  if (price) {
    if (price.status === 'UNAVAILABLE') blockers.push({ code: 'PRICE_UNAVAILABLE', message: 'Preço indisponível no getItem' });
    if (price.flags.includes('PRICE_ANOMALY')) blockers.push({ code: 'PRICE_UNVERIFIED', message: 'Valores de preço inconsistentes no catálogo' });
    if (price.flags.includes('AMBIGUOUS_OPTION_PRICING')) {
      warnings.push({ code: 'PRICE_AMBIGUOUS', message: `Preço ambíguo no catálogo: ${fmtRange(price.unitTotalRange)} por unidade (só o carrinho confirma)` });
    }
    if (price.flags.includes('OPTION_PRICE_MISSING')) warnings.push({ code: 'PRICE_PARTIAL', message: 'Alguma opção sem preço informado' });
    if (price.flags.includes('OPTION_REPEAT_UNVERIFIED')) warnings.push({ code: 'PRICE_REPEAT_UNVERIFIED', message: 'Cobrança de opção repetida não informada' });
    if (price.minimumOrder.met === false) {
      warnings.push({ code: 'BELOW_MINIMUM_ORDER', message: `Faltam ${fmtRange(price.minimumOrder.missingAmount)} para o pedido mínimo da loja` });
    } else if (price.minimumOrder.met === null && price.minimumOrder.amount !== null) {
      warnings.push({ code: 'MINIMUM_ORDER_UNVERIFIED', message: `Não é possível afirmar se o pedido mínimo (${brl(price.minimumOrder.amount)}) é atingido` });
    }
    if (price.listingComparison.differs) {
      warnings.push({ code: 'LISTING_PRICE_DIFFERS', message: 'Preço da busca difere do detalhe; exibido o do getItem' });
    }
  }

  // ---- orçamento (teto obrigatório; UNKNOWN bloqueia). Não avaliado se já bloqueado sem preço.
  const budget: EligibilityResult['budget'] = { itemPrice: null, orderTotal: null };
  const b = price || blockers.length === 0 ? constraints.budget : undefined;
  if (b?.maxItemPrice !== undefined) {
    budget.itemPrice = price ? checkCap(price.unitTotalRange, b.maxItemPrice) : 'UNKNOWN';
    const r = price ? fmtRange(price.unitTotalRange) : 'indisponível';
    if (budget.itemPrice === 'FAIL') blockers.push({ code: 'OVER_ITEM_BUDGET', message: `Preço do item ${r} acima do teto ${brl(b.maxItemPrice)}` });
    if (budget.itemPrice === 'UNKNOWN') blockers.push({ code: 'ITEM_BUDGET_UNVERIFIED', message: `Preço do item ${r} — não é possível garantir o teto ${brl(b.maxItemPrice)}` });
  }
  if (b?.maxOrderTotal !== undefined) {
    budget.orderTotal = price ? checkCap(price.estimatedTotalRange, b.maxOrderTotal) : 'UNKNOWN';
    const r = price ? fmtRange(price.estimatedTotalRange) : 'indisponível';
    if (budget.orderTotal === 'FAIL') blockers.push({ code: 'OVER_ORDER_BUDGET', message: `Total estimado ${r} acima do teto ${brl(b.maxOrderTotal)}` });
    if (budget.orderTotal === 'UNKNOWN') blockers.push({ code: 'ORDER_BUDGET_UNVERIFIED', message: `Total estimado ${r} — não é possível garantir o teto ${brl(b.maxOrderTotal)}` });
  }

  if (detail.itemDescription.state !== 'PRESENT') dataLimitations.push('Item sem descrição no iFood');
  dataLimitations.push('Preços são estimativas; o total confirmado só existe no carrinho do iFood');

  return result({
    restrictions,
    selection,
    configuration,
    pricing: { minimumConfigurable: minimum.price, selected, confirmedTotal: null },
    budget,
  });
}
