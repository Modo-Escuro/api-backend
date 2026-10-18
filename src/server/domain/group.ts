// GRP-01: compõe propostas coletivas com cobertura por pessoa e custo agregado. Função pura (sem I/O).
//
// Regras (issue #17, DEC-01 D2–D6/D9, StRS RN07):
//  - Matriz participante × item com as restrições DAQUELA pessoa (nunca a união de todos). Restrição não informada,
//    ambígua ou dado insuficiente ⇒ NEEDS_VERIFICATION, nunca compatível (UNKNOWN não vira PASS).
//  - Cobertura gravada com a assinatura das restrições usadas: restrição mudou depois ⇒ a pessoa deixa de ser atendida
//    e o plano deixa de ser válido até nova composição.
//  - Planos de uma loja só (D2); uma linha por pessoa atendida, quantidade 1 — porções não são inventadas.
//  - Custos pela DOM-01 (`allocateCosts`). A taxa de serviço nunca aparece no catálogo: o total é desconhecido. Usamos a
//    SOMA OBSERVADA (itens pelo mínimo da faixa, entrega observada ou 0 se ausente, serviço 0). Ela só mostra estouro de
//    teto sob a hipótese, explícita, de não haver desconto/cupom não observado (a sacola simulada não aplica nenhum);
//    nunca diz que cabe e nunca ordena planos como se entrega desconhecida fosse zero.
//  - Teto individual rígido estourado: a pessoa sai do plano (BLOCKED/LIMIT_EXCEEDED) e o resto continua. Teto
//    coletivo estourado: a pessoa mais cara sai, com cobertura parcial explícita (GROUP_LIMIT).
//  - Ranqueia só planos válidos; corta em 4 DEPOIS de compor, resgatando quem só é atendido mais abaixo; quem ainda
//    assim perder a cobertura aparece na explicação. Sem plano válido ⇒ explica conflito e limites da busca.
import { createHash } from 'node:crypto';
import type { ItemRestriction } from '../mcp/types.js';
import { evaluateCandidate, type EligibilityResult } from './eligibility.js';
import { val } from './fields.js';
import { compareIds, formatCents } from './money.js';
import type { NormalizedItemDetail, NormalizedListingItem } from './normalize.js';
import { allocateCosts, type CostInput } from './purchase-costs.js';
import { MAX_PROPOSALS, knownRestrictions, restrictionsSig, type Bag, type Participant, type PlanLine, type Proposal, type PurchaseState } from './purchase.js';
import { classifyBlockers, rankCandidates } from './ranking.js';

export interface CatalogCandidate {
  listing: NormalizedListingItem;
  /** Só candidatos detalhados por getItem entram (regra 2). */
  detail: NormalizedItemDetail;
  serverFilters: ItemRestriction[];
}

export type CellStatus = 'COMPATIBLE' | 'INCOMPATIBLE' | 'NEEDS_VERIFICATION';
export interface MatrixCell {
  participantId: string;
  itemId: string;
  merchantId: string;
  status: CellStatus;
  /** Códigos dos bloqueios (evidência da avaliação), sem dados pessoais. */
  reasons: string[];
}

export type CoverageStatus = 'COVERED' | 'BLOCKED' | 'NEEDS_VERIFICATION';
export interface Coverage { participantId: string; status: CoverageStatus; reason: string | null; restrictionsSig?: string }

/** OVER_OBSERVED: passa do teto pelos preços observados — provisório (descontos não visíveis), nunca reprovação definitiva. */
export type CapStatus = 'OVER_OBSERVED' | 'UNVERIFIABLE';
export interface CapCheck { target: string | 'GROUP'; kind: 'MANDATORY' | 'PREFERENCE' | 'UNCLEAR'; status: CapStatus | 'WITHIN_PREFERENCE' }

export type ApprovalBlocker =
  | 'TOTAL_UNKNOWN' | 'DELIVERY_FEE_UNKNOWN' | 'PRICE_RANGE' | 'LIMIT_UNVERIFIABLE' | 'MINIMUM_ORDER_UNVERIFIED'
  | 'PARTIAL_COVERAGE' | 'RESTRICTIONS_UNVERIFIED' | 'BAG_NEEDS_REVALIDATION';

export interface PlanEvaluation {
  proposal: Proposal;
  coverage: Coverage[];
  /** Soma observada (itens pelo mínimo, entrega observada ou 0, serviço 0). Nunca é o total do pedido. */
  lowerBoundCents: number | null;
  /** Subtotal de itens: mínimo e máximo observados (max null = sem teto conhecido). */
  itemsRange: { minCents: number; maxCents: number | null };
  perParticipant: { participantId: string; lowerBoundCents: number | null }[];
  caps: CapCheck[];
  /** Sem violação (teto rígido, coletivo, pedido mínimo, consumidor não verificado, sacola obsoleta) e alguém atendido. */
  valid: boolean;
  violations: string[];
  approvalBlockers: ApprovalBlocker[];
  warnings: string[];
  etaMaxMinutes: number | null;
  /** Valores comparáveis (entrega observada sem divergência, preços exatos). Incompletos vêm depois no ranking. */
  comparable: boolean;
}

/** Contrato com a RANK-03 (#11): ordena planos já válidos. Implementação provisória abaixo até a integração. */
export interface PlanRanker {
  readonly id: string;
  rank(plans: readonly PlanEvaluation[], ctx: { priority: 'ECONOMY' | 'SPEED' | null }): PlanEvaluation[];
}

const covered = (p: PlanEvaluation) => p.coverage.filter((c) => c.status === 'COVERED').length;
const nullLast = (a: number | null, b: number | null) => (a === b ? 0 : a === null ? 1 : b === null ? -1 : a - b);

/**
 * Provisório (DEC-01 D9): mais pessoas atendidas; valores comparáveis antes de incompletos (entrega desconhecida
 * nunca vale zero); depois economia ou rapidez; menos avisos; desempate estável.
 */
export const interimPlanRanker: PlanRanker = {
  id: 'interim-lexicographic-v2',
  rank(plans, { priority }) {
    return [...plans].sort((a, b) =>
      covered(b) - covered(a) ||
      Number(b.comparable) - Number(a.comparable) ||
      (priority === 'SPEED'
        ? nullLast(a.etaMaxMinutes, b.etaMaxMinutes) || nullLast(a.lowerBoundCents, b.lowerBoundCents)
        : nullLast(a.lowerBoundCents, b.lowerBoundCents) || nullLast(a.etaMaxMinutes, b.etaMaxMinutes)) ||
      a.warnings.length - b.warnings.length ||
      compareIds(a.proposal.proposalId, b.proposal.proposalId));
  },
};

export interface GroupLimits {
  /** Opções compatíveis consideradas por pessoa (depois do ranking individual). */
  maxOptionsPerParticipant: number;
  /** Combinações avaliadas por loja. */
  maxPlansPerMerchant: number;
  /** Combinações avaliadas no total. */
  maxPlans: number;
}
export const DEFAULT_GROUP_LIMITS: GroupLimits = { maxOptionsPerParticipant: 8, maxPlansPerMerchant: 60, maxPlans: 240 };

export interface GroupResult {
  proposals: PlanEvaluation[];
  matrix: MatrixCell[];
  explanation: string[];
  search: {
    candidates: number; merchants: number; plansEvaluated: number; validPlans: number; truncated: string[];
    discarded: { duplicates: number; inconsistent: number; outsideMerchant: number };
  };
  /** Pessoas com plano válido que ficaram fora das propostas exibidas pelo corte. */
  lostByCut: string[];
  rankerId: string;
}

const hash = (...parts: string[]) => createHash('sha256').update(JSON.stringify(['GRP-01', ...parts])).digest('base64url').slice(0, 24);

export { knownRestrictions, restrictionsSig };

interface Option { candidate: CatalogCandidate; evaluation: EligibilityResult; unitMin: number; unitMax: number | null; optionIds: string[] }

const MAX_OPTION_IDS = 50; // limite do schema PlanLine
/** Avaliações extras por combinação no reparo em cascata (custo limitado e determinístico). */
const REPAIR_BUDGET = 64;

/** Combinações de `k` índices em [0, n), em ordem lexicográfica (geradas sob demanda). */
function* combinations(n: number, k: number): Generator<number[]> {
  const idx = Array.from({ length: k }, (_, i) => i);
  while (idx.length && idx[k - 1]! < n) {
    yield [...idx];
    let i = k - 1;
    while (i >= 0 && idx[i] === n - k + i) i--;
    if (i < 0) return;
    idx[i]! += 1;
    for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1]! + 1;
  }
}

function optionOf(c: CatalogCandidate, e: EligibilityResult): Option | null {
  const pb = e.pricing.selected ?? e.pricing.minimumConfigurable;
  const range = pb?.unitTotalRange;
  if (!pb || pb.status === 'UNAVAILABLE' || !range || range.min === null) return null; // preço desconhecido nunca vira zero
  const optionIds = (e.selection?.options ?? []).flatMap((o) => Array<string>(o.quantity ?? 1).fill(o.optionId)).sort();
  if (optionIds.length > MAX_OPTION_IDS) return null; // configuração fora do suportado não vira proposta
  return { candidate: c, evaluation: e, unitMin: range.min, unitMax: range.max, optionIds };
}

export const cleanName = (s: string) => {
  const v = [...s.replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, '').trim()].slice(0, 200).join('');
  return v || 'Item sem nome';
};

/** Avalia um plano (proposta gerada ou sacola persistida): custos pela DOM-01, tetos e bloqueios de aprovação. */
export function evaluatePlan(state: PurchaseState, proposal: Proposal | Bag, coverage: Coverage[], etaMaxMinutes: number | null = null): PlanEvaluation {
  const people = state.participants;
  const capOf = (d: Participant['limit']) => (d.state === 'DECLARED' ? d.value : null);
  const items = (pick: (l: PlanLine) => number) =>
    proposal.lines.map((l) => ({ itemId: l.lineId, unitPriceCents: pick(l), quantity: l.quantity, consumerIds: l.consumerIds }));
  const base = (caps: (p: Participant) => number | undefined, collective: number | undefined, pick: (l: PlanLine) => number): CostInput => ({
    participants: people.map((p) => ({ participantId: p.participantId, ...(caps(p) !== undefined ? { capCents: caps(p) } : {}) })),
    items: items(pick), deliveryFeeCents: proposal.deliveryFeeCents ?? 0, serviceFeeCents: 0, discounts: [],
    ...(collective !== undefined ? { collectiveCapCents: collective } : {}),
    ...(proposal.minimumOrderCents !== null ? { minimumOrderCents: proposal.minimumOrderCents } : {}),
  });
  const mandatory = (p: Participant) => (capOf(p.limit)?.kind === 'MANDATORY' ? capOf(p.limit)!.amountCents : undefined);
  const preference = (p: Participant) => (capOf(p.limit)?.kind === 'PREFERENCE' ? capOf(p.limit)!.amountCents : undefined);
  const g = state.groupLimit.state === 'DECLARED' ? state.groupLimit.value : null;
  const lower = allocateCosts(base(mandatory, g?.kind === 'MANDATORY' ? g.amountCents : undefined, (l) => l.unitMinCents));
  const pref = allocateCosts(base(preference, g?.kind === 'PREFERENCE' ? g.amountCents : undefined, (l) => l.unitMinCents));
  const allMaxKnown = proposal.lines.every((l) => l.unitMaxCents !== null);
  const upper = allMaxKnown ? allocateCosts(base(() => undefined, undefined, (l) => l.unitMaxCents!)) : null;
  const uncertain = new Set(proposal.uncertainties ?? []);

  const caps: CapCheck[] = [];
  const violations: string[] = [];
  const warnings: string[] = [];
  const blockers = new Set<ApprovalBlocker>(['TOTAL_UNKNOWN']); // taxa de serviço nunca observada
  for (const p of people) {
    const row = lower.participants.find((r) => r.participantId === p.participantId)!;
    if (p.limit.state === 'UNCLEAR') { caps.push({ target: p.participantId, kind: 'UNCLEAR', status: 'UNVERIFIABLE' }); blockers.add('LIMIT_UNVERIFIABLE'); }
    if (mandatory(p) !== undefined) {
      const fail = row.budget === 'FAIL';
      caps.push({ target: p.participantId, kind: 'MANDATORY', status: fail ? 'OVER_OBSERVED' : 'UNVERIFIABLE' });
      if (fail) violations.push(`LIMIT_EXCEEDED:${p.participantId}`);
    }
    if (preference(p) !== undefined) {
      const over = pref.participants.find((r) => r.participantId === p.participantId)!.budget === 'FAIL';
      caps.push({ target: p.participantId, kind: 'PREFERENCE', status: over ? 'OVER_OBSERVED' : 'WITHIN_PREFERENCE' });
      if (over) warnings.push(`PREFERENCE_LIMIT_EXCEEDED:${p.participantId}`);
    }
  }
  if (state.groupLimit.state === 'UNCLEAR') { caps.push({ target: 'GROUP', kind: 'UNCLEAR', status: 'UNVERIFIABLE' }); blockers.add('LIMIT_UNVERIFIABLE'); }
  if (g?.kind === 'MANDATORY') {
    caps.push({ target: 'GROUP', kind: 'MANDATORY', status: lower.collectiveBudget === 'FAIL' ? 'OVER_OBSERVED' : 'UNVERIFIABLE' });
    if (lower.collectiveBudget === 'FAIL') violations.push('GROUP_LIMIT_EXCEEDED');
  }
  if (g?.kind === 'PREFERENCE') {
    const over = pref.collectiveBudget === 'FAIL';
    caps.push({ target: 'GROUP', kind: 'PREFERENCE', status: over ? 'OVER_OBSERVED' : 'WITHIN_PREFERENCE' });
    if (over) warnings.push('PREFERENCE_GROUP_LIMIT_EXCEEDED');
  }
  if (proposal.minimumOrderCents !== null) {
    if (upper?.minimumOrder === 'FAIL') violations.push('BELOW_MINIMUM_ORDER'); // nem o preço máximo alcança o mínimo
    else if (lower.minimumOrder !== 'PASS' || uncertain.has('MINIMUM_ORDER_DIVERGENT')) blockers.add('MINIMUM_ORDER_UNVERIFIED');
  }
  if (proposal.deliveryFeeCents === null || uncertain.has('DELIVERY_FEE_DIVERGENT')) blockers.add('DELIVERY_FEE_UNKNOWN');
  if (proposal.lines.some((l) => l.unitMaxCents !== l.unitMinCents)) blockers.add('PRICE_RANGE');
  // Toda linha precisa de consumidores atendidos AGORA (restrição nova ou desconhecida invalida a alocação).
  for (const id of [...new Set(proposal.lines.flatMap((l) => l.consumerIds))].sort(compareIds)) {
    if (coverage.find((c) => c.participantId === id)?.status !== 'COVERED') violations.push(`CONSUMER_NOT_VERIFIED:${id}`);
  }
  if (coverage.some((c) => c.status === 'NEEDS_VERIFICATION')) blockers.add('RESTRICTIONS_UNVERIFIED');
  if (coverage.some((c) => c.status !== 'COVERED')) blockers.add('PARTIAL_COVERAGE');
  if ('status' in proposal && proposal.status === 'NEEDS_REVALIDATION') { blockers.add('BAG_NEEDS_REVALIDATION'); violations.push('BAG_NEEDS_REVALIDATION'); }
  return {
    proposal: {
      proposalId: proposal.proposalId, merchantId: proposal.merchantId, lines: proposal.lines, deliveryFeeCents: proposal.deliveryFeeCents,
      minimumOrderCents: proposal.minimumOrderCents,
      coverage: coverage.map((c) => ({ participantId: c.participantId, status: c.status, reason: c.reason, ...(c.restrictionsSig ? { restrictionsSig: c.restrictionsSig } : {}) })),
      ...(proposal.addressId !== undefined ? { addressId: proposal.addressId } : {}),
      ...(proposal.uncertainties?.length ? { uncertainties: proposal.uncertainties } : {}),
    },
    coverage,
    lowerBoundCents: lower.totalCents,
    itemsRange: { minCents: lower.subtotalCents, maxCents: upper ? upper.subtotalCents : null },
    perParticipant: lower.participants.map((r) => ({ participantId: r.participantId, lowerBoundCents: r.totalCents })),
    caps,
    valid: violations.length === 0 && coverage.some((c) => c.status === 'COVERED'),
    violations,
    approvalBlockers: [...blockers],
    warnings,
    etaMaxMinutes,
    comparable: proposal.deliveryFeeCents !== null && uncertain.size === 0 && proposal.lines.every((l) => l.unitMaxCents === l.unitMinCents),
  };
}

/**
 * Cobertura de um plano persistido (proposta ou sacola), revalidada contra as restrições ATUAIS: quem consome só
 * continua atendido se as restrições forem conhecidas e iguais às usadas na composição. Para os demais vale o motivo
 * gravado (dado insuficiente ≠ incompatível); quem entrou depois fica fora do plano.
 */
export function planCoverage(state: PurchaseState, plan: Proposal | Bag): Coverage[] {
  const consumers = new Set(plan.lines.flatMap((l) => l.consumerIds));
  return state.participants.map((p): Coverage => {
    const sig = restrictionsSig(state, p);
    const stored = plan.coverage?.find((c) => c.participantId === p.participantId);
    if (knownRestrictions(state, p) === null) return { participantId: p.participantId, status: 'NEEDS_VERIFICATION', reason: 'RESTRICTIONS_UNKNOWN', restrictionsSig: sig };
    if (consumers.has(p.participantId)) {
      if (stored?.restrictionsSig !== sig) return { participantId: p.participantId, status: 'NEEDS_VERIFICATION', reason: 'RESTRICTIONS_CHANGED', restrictionsSig: sig };
      return { participantId: p.participantId, status: 'COVERED', reason: null, restrictionsSig: sig };
    }
    if (stored && stored.status !== 'COVERED') return { participantId: p.participantId, status: stored.status, reason: stored.reason, restrictionsSig: sig };
    return { participantId: p.participantId, status: 'BLOCKED', reason: 'NOT_IN_PLAN', restrictionsSig: sig };
  });
}

/** Mantém, se possível, a cobertura de quem é atendido por algum plano válido depois do corte em `max`. */
function cutPreservingCoverage(ranked: PlanEvaluation[], max: number): { pick: PlanEvaluation[]; lost: string[] } {
  const pick = ranked.slice(0, max);
  const coveredBy = (plans: PlanEvaluation[], id: string) => plans.some((p) => p.coverage.some((c) => c.participantId === id && c.status === 'COVERED'));
  const everyone = [...new Set(ranked.flatMap((p) => p.coverage.filter((c) => c.status === 'COVERED').map((c) => c.participantId)))].sort(compareIds);
  for (const id of everyone) {
    if (coveredBy(pick, id)) continue;
    const rescue = ranked.find((p) => !pick.includes(p) && coveredBy([p], id));
    if (!rescue) continue;
    for (let k = pick.length - 1; k >= 0; k--) {
      const without = pick.filter((_, j) => j !== k);
      const lost = pick[k]!.coverage.some((c) => c.status === 'COVERED' && !coveredBy([...without, rescue], c.participantId));
      if (!lost) { pick.splice(k, 1, rescue); break; }
    }
  }
  return { pick: ranked.filter((p) => pick.includes(p)), lost: everyone.filter((id) => !coveredBy(pick, id)) };
}

type Uncertainty = 'DELIVERY_FEE_DIVERGENT' | 'MINIMUM_ORDER_DIVERGENT';

/** Fatos da loja reconciliados entre todas as listagens, sem depender da ordem da resposta do MCP. */
function merchantFacts(pool: CatalogCandidate[], m: string) {
  const mine = pool.filter((c) => c.listing.merchant.merchantId === m);
  const fees = mine.map((c) => val(c.listing.merchant.delivery)?.effectiveFee ?? null);
  const knownFees = [...new Set(fees.filter((f): f is number => f !== null))];
  const minimums = [...new Set(mine.flatMap((c) => [val(c.detail.merchantMinimumOrderAmount), val(c.listing.merchant.minimumOrderAmount)])
    .filter((x): x is number => x !== undefined))];
  const etas = mine.map((c) => { const d = val(c.listing.merchant.delivery); return d ? val(d.etaMinutes.max) ?? null : null; });
  const uncertainties: Uncertainty[] = [];
  // Taxa: só vale um valor visto em TODAS as listagens. Divergência ⇒ desconhecida (nunca escolhida por ordem). Para a
  // soma observada usa-se a menor vista (não gera falha falsa); a aprovação fica bloqueada (DELIVERY_FEE_UNKNOWN).
  const consistentFee = knownFees.length === 1 && fees.every((f) => f === knownFees[0]);
  if (knownFees.length > 1 || (knownFees.length === 1 && !consistentFee)) uncertainties.push('DELIVERY_FEE_DIVERGENT');
  // Mínimo: o menor observado (não gera falha falsa), com a divergência marcada (não permite dizer que foi atingido).
  if (minimums.length > 1) uncertainties.push('MINIMUM_ORDER_DIVERGENT');
  return {
    deliveryFeeCents: consistentFee ? knownFees[0]! : knownFees.length > 1 ? Math.min(...knownFees) : null,
    minimumOrderCents: minimums.length ? Math.min(...minimums) : null,
    etaMax: etas.some((e) => e === null) ? null : Math.max(...(etas as number[])),
    uncertainties,
  };
}

export function composeProposals(
  state: PurchaseState, candidates: readonly CatalogCandidate[],
  opts: { seed: string; ranker?: PlanRanker; limits?: Partial<GroupLimits>; addressId?: string | null },
): GroupResult {
  const limits = { ...DEFAULT_GROUP_LIMITS, ...opts.limits };
  const ranker = opts.ranker ?? interimPlanRanker;
  const priority = state.priority.state === 'DECLARED' ? state.priority.value : null;
  const people = state.participants;
  const truncated: string[] = [];
  const merchantFilter = state.merchant.state === 'DECLARED' ? state.merchant.value.merchantId : null;
  const discarded = { duplicates: 0, inconsistent: 0, outsideMerchant: 0 };

  // Ordem determinística e sem duplicatas (independe da ordem da resposta do MCP).
  const sorted = [...candidates].sort((a, b) =>
    compareIds(a.listing.merchant.merchantId, b.listing.merchant.merchantId) || compareIds(a.listing.itemId, b.listing.itemId));
  const seen = new Set<string>();
  const pool: CatalogCandidate[] = [];
  for (const c of sorted) {
    if (c.detail.itemId !== c.listing.itemId || c.detail.merchantId !== c.listing.merchant.merchantId) { discarded.inconsistent++; continue; }
    if (merchantFilter !== null && c.listing.merchant.merchantId !== merchantFilter) { discarded.outsideMerchant++; continue; }
    const key = `${c.listing.merchant.merchantId}|${c.listing.itemId}`;
    if (seen.has(key)) { discarded.duplicates++; continue; }
    seen.add(key);
    pool.push(c);
  }

  // Matriz participante × item, com as restrições de cada pessoa.
  const matrix: MatrixCell[] = [];
  const options = new Map<string, Option[]>();
  const overCap = new Set<string>(); // tem opção compatível, mas nenhuma cabe no próprio teto rígido
  for (const p of people) {
    const keys = knownRestrictions(state, p);
    const compatible: Option[] = [];
    for (const c of pool) {
      if (keys === null) {
        matrix.push({ participantId: p.participantId, itemId: c.listing.itemId, merchantId: c.listing.merchant.merchantId, status: 'NEEDS_VERIFICATION', reasons: ['RESTRICTIONS_UNKNOWN'] });
        continue;
      }
      const e = evaluateCandidate({ listing: c.listing, detail: c.detail, serverFilters: c.serverFilters }, { restrictions: keys });
      const cat = classifyBlockers(e.blockers);
      const opt = cat === 'ELIGIBLE' ? optionOf(c, e) : null;
      const status: CellStatus = cat === 'ELIGIBLE' ? (opt ? 'COMPATIBLE' : 'NEEDS_VERIFICATION') : cat === 'BLOCKED' ? 'INCOMPATIBLE' : 'NEEDS_VERIFICATION';
      matrix.push({ participantId: p.participantId, itemId: c.listing.itemId, merchantId: c.listing.merchant.merchantId, status,
        reasons: opt || cat !== 'ELIGIBLE' ? e.blockers.map((b) => b.code) : ['PRICE_OR_OPTIONS_UNAVAILABLE'] });
      if (opt) compatible.push(opt);
    }
    // Teto individual rígido: opção cujo preço mínimo sozinho já passa do teto nunca cabe (taxas só somam).
    const cap = p.limit.state === 'DECLARED' && p.limit.value.kind === 'MANDATORY' ? p.limit.value.amountCents : null;
    const fitting = cap === null ? compatible : compatible.filter((o) => o.unitMin <= cap);
    if (compatible.length && !fitting.length) overCap.add(p.participantId);
    options.set(p.participantId, fitting);
  }

  // Lojas em ordem de potencial (mais pessoas atendíveis, menor preço observado), não por ID.
  const potential = new Map<string, number>();
  const cheapest = new Map<string, number>();
  for (const m of new Set(pool.map((c) => c.listing.merchant.merchantId))) {
    potential.set(m, people.filter((p) => (options.get(p.participantId) ?? []).some((o) => o.candidate.listing.merchant.merchantId === m)).length);
    cheapest.set(m, Math.min(...pool.filter((c) => c.listing.merchant.merchantId === m).map((c) => c.listing.price.basePrice ?? Number.MAX_SAFE_INTEGER)));
  }
  const merchants = [...potential.keys()].sort((a, b) => potential.get(b)! - potential.get(a)! || cheapest.get(a)! - cheapest.get(b)! || compareIds(a, b));

  const evaluated: PlanEvaluation[] = [];
  const dropped = new Map<string, string>(); // quem o reparo de tetos retirou (mesmo que o plano tenha ficado vazio)
  const evaluatedIds = new Set<string>();
  for (const m of merchants) {
    if (evaluated.length >= limits.maxPlans) { truncated.push('MAX_PLANS'); break; }
    const facts = merchantFacts(pool, m);
    const perPerson = people.map((p) => {
      const mine = (options.get(p.participantId) ?? []).filter((o) => o.candidate.listing.merchant.merchantId === m);
      // Ordem: ranking individual (RANK-01/02/03) e, depois, as demais compatíveis por preço — nada é eliminado aqui.
      const ranked = rankCandidates(mine.map((o) => ({ evaluation: o.evaluation, listing: o.candidate.listing, detail: o.candidate.detail })),
        priority ? { priority } : null).recommendations.map((r) => r.itemId);
      const ordered = [...mine].sort((a, b) => {
        const ra = ranked.indexOf(a.candidate.listing.itemId), rb = ranked.indexOf(b.candidate.listing.itemId);
        return (ra < 0 ? 1e9 : ra) - (rb < 0 ? 1e9 : rb) || a.unitMin - b.unitMin || compareIds(a.candidate.listing.itemId, b.candidate.listing.itemId);
      });
      if (ordered.length > limits.maxOptionsPerParticipant) truncated.push('MAX_OPTIONS');
      return { p, opts: ordered.slice(0, limits.maxOptionsPerParticipant) };
    });
    const coverable = perPerson.filter((x) => x.opts.length > 0);
    if (!coverable.length) continue;
    const baseCoverage = (p: Participant): Coverage => {
      const id = p.participantId;
      const sig = restrictionsSig(state, p);
      if (coverable.some((x) => x.p.participantId === id)) return { participantId: id, status: 'COVERED', reason: null, restrictionsSig: sig };
      if (knownRestrictions(state, p) === null) return { participantId: id, status: 'NEEDS_VERIFICATION', reason: 'RESTRICTIONS_UNKNOWN', restrictionsSig: sig };
      if (overCap.has(id)) return { participantId: id, status: 'BLOCKED', reason: 'LIMIT_EXCEEDED', restrictionsSig: sig };
      if (matrix.some((c) => c.participantId === id && c.merchantId === m && c.status === 'NEEDS_VERIFICATION')) return { participantId: id, status: 'NEEDS_VERIFICATION', reason: 'DATA_INSUFFICIENT', restrictionsSig: sig };
      return { participantId: id, status: 'BLOCKED', reason: 'NO_COMPATIBLE_ITEM', restrictionsSig: sig };
    };

    const start = coverable.map(() => 0);
    const queue: number[][] = [start];
    const visited = new Set([start.join(',')]);
    let count = 0;
    while (queue.length && count < limits.maxPlansPerMerchant && evaluated.length < limits.maxPlans) {
      const idx = queue.shift()!;
      count++;
      const full = coverable.map((x, k) => ({ p: x.p, o: x.opts[idx[k]!]! }));
      type Pick = (typeof full)[number];
      const evalOf = (sel: Pick[], removed: Map<string, string>): PlanEvaluation => {
        const coverage = people.map(baseCoverage).map((c) => (removed.has(c.participantId) ? { ...c, status: 'BLOCKED' as const, reason: removed.get(c.participantId)! } : c));
        const signature = sel.map((x) => `${x.p.participantId}:${x.o.candidate.listing.itemId}:${x.o.optionIds.join('+')}`).join('|');
        const proposalId = hash(opts.seed, m, signature);
        const lines: PlanLine[] = sel.map((x, k) => ({
          lineId: hash(proposalId, String(k)), itemId: x.o.candidate.listing.itemId,
          name: cleanName(val(x.o.candidate.detail.itemName) ?? val(x.o.candidate.listing.itemName) ?? ''),
          optionIds: x.o.optionIds, quantity: 1, consumerIds: [x.p.participantId], unitMinCents: x.o.unitMin, unitMaxCents: x.o.unitMax,
        }));
        return evaluatePlan(state, {
          proposalId, merchantId: m, lines, deliveryFeeCents: facts.deliveryFeeCents, minimumOrderCents: facts.minimumOrderCents,
          ...(opts.addressId !== undefined ? { addressId: opts.addressId } : {}),
          ...(facts.uncertainties.length ? { uncertainties: facts.uncertainties } : {}),
        }, coverage, facts.etaMax);
      };
      const capViolation = (v: string) => v.startsWith('LIMIT_EXCEEDED:') || v === 'GROUP_LIMIT_EXCEEDED';

      // 1) Reparo guloso: quem estoura o próprio teto (pela parte da entrega) sai; teto coletivo retira a pessoa mais cara.
      let chosen = full;
      const greedyRemoved = new Map<string, string>();
      let ev: PlanEvaluation | null = null;
      while (chosen.length) {
        ev = evalOf(chosen, greedyRemoved);
        const inPlan = (id: string | undefined) => id !== undefined && chosen.some((x) => x.p.participantId === id);
        let drop: string | null = ev.violations.filter((v) => v.startsWith('LIMIT_EXCEEDED:')).map((v) => v.split(':')[1]).find(inPlan) ?? null;
        let reason = 'OWN_CAP_WITH_SHARES';
        if (!drop && ev.violations.includes('GROUP_LIMIT_EXCEEDED')) {
          const rows = ev.perParticipant.filter((r) => inPlan(r.participantId));
          rows.sort((a, b) => (b.lowerBoundCents ?? 0) - (a.lowerBoundCents ?? 0) || compareIds(b.participantId, a.participantId));
          drop = rows[0]?.participantId ?? null;
          reason = 'GROUP_LIMIT';
        }
        if (!drop) break;
        greedyRemoved.set(drop, reason);
        ev = null; // reavaliado na próxima volta (sem ninguém ⇒ nenhum plano)
        chosen = chosen.filter((x) => x.p.participantId !== drop);
      }
      // 2) Retirar alguém pode aumentar a parte da entrega dos demais (cascata). Se o guloso retirou 2+ pessoas ou
      //    esvaziou o plano, procura por nível (retirando 1, depois 2...) a combinação válida com menos retiradas,
      //    dentro de um orçamento fixo de avaliações. Não é busca exaustiva: a explicação não alega otimalidade.
      let removed = greedyRemoved;
      if (greedyRemoved.size >= 2 || (greedyRemoved.size >= 1 && !ev)) {
        const maxLevel = Math.min(ev ? greedyRemoved.size - 1 : full.length - 1, full.length - 1);
        let budget = REPAIR_BUDGET;
        let best: { ev: PlanEvaluation; removed: Map<string, string> } | null = null;
        for (let level = 1; level <= maxLevel && !best && budget > 0; level++) {
          for (const drop of combinations(full.length, level)) {
            if (budget-- <= 0) break;
            const out = new Map(drop.map((i) => [full[i]!.p.participantId, 'CAP_COMBINATION']));
            const cand = evalOf(full.filter((_, i) => !drop.includes(i)), out);
            if (cand.violations.some(capViolation) || !cand.valid) continue;
            if (!best || nullLast(cand.lowerBoundCents, best.ev.lowerBoundCents) < 0) best = { ev: cand, removed: out };
          }
        }
        if (best) { ev = best.ev; removed = best.removed; }
      }
      for (const [id, reason] of removed) if (!dropped.has(id)) dropped.set(id, reason);
      if (ev && !evaluatedIds.has(ev.proposal.proposalId)) { evaluatedIds.add(ev.proposal.proposalId); evaluated.push(ev); }
      for (let k = 0; k < idx.length; k++) {
        if (idx[k]! + 1 >= coverable[k]!.opts.length) continue;
        const next = [...idx];
        next[k]! += 1;
        const key = next.join(',');
        if (!visited.has(key)) { visited.add(key); queue.push(next); }
      }
    }
    if (queue.length) truncated.push('MAX_PLANS_PER_MERCHANT');
  }

  const valid = evaluated.filter((p) => p.valid);
  const { pick: proposals, lost } = cutPreservingCoverage(ranker.rank(valid, { priority }), MAX_PROPOSALS);
  const search = {
    candidates: pool.length, merchants: merchants.length, plansEvaluated: evaluated.length, validPlans: valid.length,
    truncated: [...new Set(truncated)], discarded,
  };
  return {
    proposals, matrix, lostByCut: lost,
    explanation: explain(state, search, evaluated, valid, proposals, matrix, lost, merchantFilter, dropped, overCap),
    search, rankerId: ranker.id,
  };
}

const REASON_TEXT: Record<string, string> = {
  RESTRICTIONS_UNKNOWN: 'restrições alimentares não informadas ou a confirmar',
  LIMIT_EXCEEDED: 'pelos preços observados, o item compatível mais barato já passa do próprio teto',
  OWN_CAP_WITH_SHARES: 'pelos preços observados, com a parte da entrega passam do próprio teto',
  GROUP_LIMIT: 'ficaram de fora para caber no teto do grupo, pelos preços observados',
  CAP_COMBINATION: 'ficaram de fora para a combinação caber nos tetos pelos preços observados; outra combinação pode existir',
  CUT: 'há opção válida fora das 4 propostas exibidas; peça sugestões mais específicas',
  DATA_INSUFFICIENT: 'os itens avaliados não trazem informação suficiente para confirmar a segurança alimentar',
  NO_COMPATIBLE_ITEM: 'nenhum dos itens avaliados é compatível com as restrições declaradas',
  NO_ITEMS: 'nenhum item foi avaliado nesta busca',
  COMBINATION_LIMIT: 'há itens compatíveis, mas nenhuma combinação válida com os tetos e o pedido mínimo',
};

function explain(state: PurchaseState, search: GroupResult['search'], all: PlanEvaluation[], valid: PlanEvaluation[],
  chosen: PlanEvaluation[], matrix: MatrixCell[], lost: string[], merchantFilter: string | null, dropped: Map<string, string>, overCap: Set<string>): string[] {
  const out: string[] = [];
  // Aviso de limite da busca SEMPRE primeiro (não pode ser cortado pelo limite de pendências).
  const anyCap = [...dropped.keys()].length > 0 || overCap.size > 0;
  const cuts = search.truncated.length ? ' A busca foi cortada pelos limites de opções e combinações.' : '';
  out.push(`Busca limitada: ${search.candidates} itens detalhados em ${search.merchants} loja(s).${cuts} Pode haver opções fora dela; isso não prova que não existe combinação válida.`);
  if (merchantFilter !== null) out.push(`A compra está fixada numa loja escolhida antes; só itens dela foram considerados (${search.discarded.outsideMerchant} de outras lojas ignorados).`);
  if (search.discarded.inconsistent) out.push(`${search.discarded.inconsistent} item(ns) ignorado(s) por dados inconsistentes do iFood.`);

  // Motivo de quem ficou sem atendimento nas propostas exibidas, agrupado por motivo.
  const byReason = new Map<string, string[]>();
  for (const p of state.participants) {
    if (chosen.some((pl) => pl.coverage.some((c) => c.participantId === p.participantId && c.status === 'COVERED'))) continue;
    let reason: string;
    if (lost.includes(p.participantId)) reason = 'CUT';
    else if (knownRestrictions(state, p) === null) reason = 'RESTRICTIONS_UNKNOWN';
    else {
      const planReasons = new Set([...chosen, ...all].flatMap((pl) => pl.coverage).filter((c) => c.participantId === p.participantId && c.status !== 'COVERED').map((c) => c.reason));
      if (dropped.has(p.participantId)) planReasons.add(dropped.get(p.participantId)!);
      const cells = matrix.filter((c) => c.participantId === p.participantId);
      const capReason = overCap.has(p.participantId) ? 'LIMIT_EXCEEDED'
        : ['LIMIT_EXCEEDED', 'OWN_CAP_WITH_SHARES', 'GROUP_LIMIT', 'CAP_COMBINATION'].find((r) => planReasons.has(r));
      if (capReason) reason = capReason;
      else if (!cells.length) reason = 'NO_ITEMS';
      else if (cells.some((c) => c.status === 'COMPATIBLE')) reason = 'COMBINATION_LIMIT';
      else if (cells.some((c) => c.status === 'NEEDS_VERIFICATION')) reason = 'DATA_INSUFFICIENT';
      else reason = 'NO_COMPATIBLE_ITEM';
    }
    byReason.set(reason, [...(byReason.get(reason) ?? []), p.displayName]);
  }
  for (const [reason, names] of byReason) {
    const shown = names.slice(0, 10).join(', ') + (names.length > 10 ? ` e mais ${names.length - 10}` : '');
    out.push(`Sem atendimento (${REASON_TEXT[reason]}): ${shown}.`);
  }
  if (!valid.length && all.length) {
    const fails = new Set(all.flatMap((p) => p.violations));
    if (fails.has('BELOW_MINIMUM_ORDER')) out.push('Algumas combinações não alcançam o pedido mínimo da loja.');
  }
  if ([...dropped.values()].includes('GROUP_LIMIT') && all.length) {
    const min = Math.min(...all.map((p) => p.lowerBoundCents ?? Number.MAX_SAFE_INTEGER));
    out.push(`Teto do grupo: a menor soma de preços observados encontrada é ${formatCents(min)} (sem taxa de serviço).`);
  }
  if (anyCap) out.push('Os tetos foram comparados com preços observados no catálogo; cupons, descontos ou frete de assinatura não visíveis podem mudar o valor no carrinho. Quem ficou de fora por teto pode caber — confirme se quiser incluir.');
  return out;
}
