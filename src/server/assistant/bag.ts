// Fecho da sacola simulada do assistente: cartões detalhados (getItem) viram propostas DATA-01 gravadas pelo
// armazenamento na mesma transação do turno. Composição, cobertura e ranking vêm de GRP-01 (domain/group.ts);
// este módulo só sincroniza participantes/pessoas da memória e monta o op SET_PROPOSALS. Função pura: sem I/O.
//
// Restrições desconhecidas continuam bloqueando a pessoa como consumidora (dado insuficiente ≠ incompatível):
// a pessoa entra na cobertura como NEEDS_VERIFICATION e não consome a linha. Nada aqui aprova compra.
import { composeProposals, cleanName, type CatalogCandidate } from '../domain/group.js';
import { val } from '../domain/fields.js';
import { formatCents } from '../domain/money.js';
import type { DomainOp, PlanLine, Proposal, PurchaseState } from '../domain/purchase.js';
import type { RestrictionKey } from '../domain/constraints.js';
import type { PersonProfile } from './memory.js';

export interface SyncPlan {
  /** Add_participant para pessoas ainda sem participante no escopo. */
  adds: DomainOp[];
  /** SET_RESTRICTIONS por participante EXISTENTE (nunca enfraquece rígido sem confirmação humana). */
  existing: DomainOp[];
  /** Restrições de participantes que este turno ADICIONA: o id só existe depois da primeira aplicação. */
  Fresh: { label: string; keys: RestrictionKey[] }[];
}

const slowsMandatory = (bound: { kind: RestrictionKey['kind']; code: RestrictionKey['code']; requirement?: 'MANDATORY' | 'PREFERENCE' | undefined },
  next: RestrictionKey | undefined) => {
  if (!next) return true;
  if (bound.kind === 'ALLERGY') return false; // alergia é sempre rígida: SET_RESTRICTIONS nunca enfraquece
  return (bound.requirement ?? 'MANDATORY') === 'MANDATORY' && next.requirement !== 'MANDATORY';
};

export function planSync(state: PurchaseState | null, people: readonly PersonProfile[]): SyncPlan {
  const plan: SyncPlan = { adds: [], existing: [], Fresh: [] };
  const byLabel = new Map(state?.participants.map(p => [p.displayName, p]) ?? []);
  for (const person of people) {
    const bound = byLabel.get(person.label);
    if (!bound) {
      plan.adds.push({ op: 'ADD_PARTICIPANT', displayName: person.label });
      if (person.restrictionsKnown) plan.Fresh.push({ label: person.label, keys: person.restrictions });
      continue;
    }
    if (!person.restrictionsKnown) continue;
    const weakening = bound.restrictions.state === 'DECLARED' &&
      bound.restrictions.value.some(b => slowsMandatory(b.key, person.restrictions.find(k => k.kind === b.key.kind && k.code === b.key.code)));
    if (weakening) continue;
    if (bound.restrictions.state === 'DECLARED' &&
      JSON.stringify(bound.restrictions.value.map(r => r.key).sort()) === JSON.stringify(person.restrictions.slice().sort())) {
      continue;
    }
    plan.existing.push({ op: 'SET_RESTRICTIONS', participantId: bound.participantId, value: person.restrictions });
  }
  return plan;
}

export interface RefreshedIntent { participants: Map<string, string>; state: PurchaseState }

export interface FullComposition { op: DomainOp; cards: string[] }

/** Preço exibido = faixa composição (preço "a partir de"/faixa nunca vira valor único). */
const priceLine = (proposal: Proposal): string => {
  const minCents = proposal.lines.reduce((acc, l: PlanLine) => acc + l.unitMinCents * l.quantity, 0);
  const maxKnown = proposal.lines.every(l => l.unitMaxCents !== null);
  const maxCents = maxKnown ? proposal.lines.reduce((acc, l) => acc + (l.unitMaxCents ?? 0) * l.quantity, 0) : null;
  const delivery = proposal.deliveryFeeCents;
  return maxKnown && maxCents === minCents
    ? `Estimativa: ${formatCents(minCents)}${delivery !== null ? ` · Entrega: ${formatCents(delivery)}` : ' · Entrega: taxa indisponível'}`
    : maxKnown
      ? `Faixa: ${formatCents(minCents)} a ${formatCents(maxCents!)}${delivery !== null ? ` · Entrega: ${formatCents(delivery)}` : ' · Entrega: taxa indisponível'}`
      : `A partir de ${formatCents(minCents)}${delivery !== null ? ` · Entrega: ${formatCents(delivery)}` : ' · Entrega: taxa indisponível'}`;
};

/** Cartões numerados: o índice N corresponde à proposta N formada pelo mesmo patch gravado no escopo. */
export function planCards(plans: { proposal: Proposal; coverage: { participantId: string; status: string; reason: string | null }[] }[],
  participants: Map<string, string>, merchantNames: Map<string, string>): string[] {
  return plans.map((plan, i) => {
    const p = plan.proposal;
    const names = [...new Set(p.lines.map(l => cleanName(l.name)))].join(' + ');
    const merchant = merchantNames.get(p.merchantId) ?? 'Loja sem nome';
    const covered = plan.coverage.filter(c => c.status === 'COVERED').map(c => participants.get(c.participantId) ?? 'pessoa');
    const blocked = plan.coverage.filter(c => c.status !== 'COVERED').map(c => participants.get(c.participantId) ?? 'pessoa');
    return [
      `${i + 1}. ${names} — ${merchant}`, priceLine(p),
      ...(covered.length ? [`Atende: ${covered.join(', ')}`] : []),
      ...(blocked.length ? ['Sem atendimento registrada para os demais: dados insuficientes ou condição não atendida.'] : []),
    ].join('\n');
  });
}

/**
 * Compose SET_PROPOSALS a partir de candidatos detalhados sobre o estado intermediário. Retorna um op com todas os
 * planos válidos numerados (máx 4), com endereço observado como proveniência. Sem plano válido ⇒ null (nenhum op).
 */
export function proposeSet(state: PurchaseState, candidates: readonly CatalogCandidate[],
  opts: { seed: string; addressId?: string | null; merchantNames?: Map<string, string> }): FullComposition | null {
  if (!candidates.length) return null;
  const addressId = opts.addressId ?? (state.address.state === 'DECLARED' ? state.address.value.addressId : null);
  const group = composeProposals(state, candidates, { seed: opts.seed, ...(addressId !== null ? { addressId } : {}) });
  if (!group.proposals.length) return null;
  const participants = new Map(state.participants.map(p => [p.participantId, p.displayName]));
  const names = opts.merchantNames ?? new Map<string, string>(candidates.map(c => [c.listing.merchant.merchantId, cleanName(val(c.listing.merchant.name) ?? 'Loja sem nome')]));
  return {
    op: { op: 'SET_PROPOSALS', proposals: group.proposals.map(plan => plan.proposal) },
    cards: planCards(group.proposals, participants, names),
  };
}

/** Confirmo: escolher N — resolve o N do último SET_PROPOSALS gravado no escopo. */
export const choosePattern = /^Confirmo: escolher (?:o |a )?op[çc][ãa]o (\d+)[.!]$/iu;

export function selectProposal(state: PurchaseState | null, choice: number): DomainOp | null {
  const proposals = state?.proposals ?? [];
  const found = proposals[choice - 1];
  return found ? { op: 'SELECT_PROPOSAL', proposalId: found.proposalId } : null;
}
