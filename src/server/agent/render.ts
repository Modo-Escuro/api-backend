// AI-02: snapshot de resposta montado SÓ pelo servidor a partir de fatos validados (issue #16).
// Texto livre do modelo não é exibido: condições, tetos, resumo e perguntas vêm da estrutura gravada e de modelos fixos.
// O bloco GROUP é gerado do estado pré-visualizado e por isso passa na conferência do `finish` (DATA-01).
import type { Snapshot } from '../contracts/conversation.js';
import { formatCents } from '../domain/money.js';
import type { ApprovalBlocker, PlanEvaluation } from '../domain/group.js';
import type { Participant, PurchaseState } from '../domain/purchase.js';

export const LABELS: Record<string, string> = {
  PEANUT: 'amendoim', MILK: 'leite', EGG: 'ovo', GLUTEN: 'glúten', TREE_NUTS: 'castanhas', SOY: 'soja', FISH: 'peixe', SEAFOOD: 'frutos do mar',
  VEGAN: 'vegano', VEGETARIAN: 'vegetariano', LACTOSE_FREE: 'sem lactose', GLUTEN_FREE: 'sem glúten', NO_PORK: 'sem carne de porco',
  SUGAR_FREE: 'sem açúcar', ORGANIC: 'orgânico',
};
export const label = (code: string) => LABELS[code] ?? code;

const clip = (s: string, max: number) => [...s].slice(0, max).join('');

function conditions(p: Participant): string[] {
  const out: string[] = [];
  const r = p.restrictions;
  if (r.state === 'NOT_ASKED') out.push('Restrições: não informadas');
  else if (r.state === 'UNCLEAR') out.push('Restrições: a confirmar');
  else if (r.state === 'NONE') out.push('Sem restrições alimentares');
  else {
    for (const x of r.value) {
      out.push(x.key.kind === 'ALLERGY'
        ? `Alergia: ${label(x.key.code)} (obrigatória)`
        : `Dieta: ${label(x.key.code)} (${(x.key.requirement ?? 'MANDATORY') === 'MANDATORY' ? 'obrigatória' : 'preferência'})`);
    }
    if (!r.value.length) out.push('Restrições: nenhuma registrada');
  }
  const l = p.limit;
  if (l.state === 'DECLARED') out.push(`Teto: ${formatCents(l.value.amountCents)} (${l.value.kind === 'MANDATORY' ? 'máximo' : 'referência'})`);
  else if (l.state === 'UNCLEAR') out.push('Teto: a confirmar');
  return out.slice(0, 30);
}

const BLOCKER_TEXT: Record<ApprovalBlocker, string> = {
  TOTAL_UNKNOWN: 'Total do pedido desconhecido: a taxa de serviço só aparece no carrinho.',
  DELIVERY_FEE_UNKNOWN: 'Taxa de entrega não informada pela loja.',
  PRICE_RANGE: 'Algum item tem preço em faixa (depende das opções escolhidas).',
  LIMIT_UNVERIFIABLE: 'Há teto a confirmar; o orçamento não pode ser verificado.',
  MINIMUM_ORDER_UNVERIFIED: 'Pedido mínimo da loja não confirmado.',
  PARTIAL_COVERAGE: 'Nem todos os participantes são atendidos.',
  RESTRICTIONS_UNVERIFIED: 'Há restrições alimentares sem confirmação.',
  BAG_NEEDS_REVALIDATION: 'A compra mudou depois da escolha; peça novas sugestões.',
};
const SIMULATED = 'Carrinho simulado: aprovação e pedido ainda não estão disponíveis nesta etapa.';

function planText(title: string, plan: PlanEvaluation, state: PurchaseState, compact = false): string {
  const who = (id: string) => state.participants.find((p) => p.participantId === id)?.displayName ?? '?';
  if (compact) {
    // Grupo grande: sem nomes por linha (a cobertura por pessoa continua no bloco estruturado).
    const delivery = plan.proposal.deliveryFeeCents === null ? 'entrega não informada' : `entrega ${formatCents(plan.proposal.deliveryFeeCents)}`;
    const floor = plan.lowerBoundCents === null ? '' : ` Soma dos preços observados: ${formatCents(plan.lowerBoundCents)} — não é o total (sem taxa de serviço; descontos não visíveis podem mudar o valor).`;
    const n = plan.coverage.filter((c) => c.status === 'COVERED').length;
    return clip(`${title}: ${plan.proposal.lines.length} item(ns); ${delivery}.${floor} Atendidos: ${n} de ${plan.coverage.length}.`, 300);
  }
  // Uma linha por informação, com emoji, para separar bem as propostas no Telegram (o bot põe preços em negrito).
  const single = state.participants.length === 1;
  const lines = plan.proposal.lines.map((l) => `• ${l.name}${single ? '' : ` (${l.consumerIds.map(who).join(', ')})`}: ${formatCents(l.unitMinCents)}${l.unitMaxCents === l.unitMinCents ? '' : l.unitMaxCents === null ? '+' : `–${formatCents(l.unitMaxCents)}`}`);
  const delivery = plan.proposal.deliveryFeeCents === null ? '🛵 Entrega: não informada' : `🛵 Entrega: ${formatCents(plan.proposal.deliveryFeeCents)}`;
  const floor = plan.lowerBoundCents === null ? [] : [`💰 Soma dos preços observados: ${formatCents(plan.lowerBoundCents)} (não é o total: sem taxa de serviço; descontos não visíveis podem mudar o valor)`];
  const out = plan.coverage.filter((c) => c.status !== 'COVERED').map((c) => who(c.participantId));
  const icon = title.startsWith('Proposta') ? '🍽️' : '🛒';
  return clip([`${icon} ${title}`, ...lines, delivery, ...floor, ...(out.length ? [`⚠️ Sem atendimento: ${out.join(', ')}`] : [])].join('\n'), 1500);
}

export interface PlanViews { proposals: PlanEvaluation[]; bag: PlanEvaluation | null }

/** Orçamento do snapshot: deixa folga para o envelope da Operation dentro de maxResultBytes (64 KiB, RUN-01). */
export const SNAPSHOT_BUDGET_BYTES = 56_000;

/**
 * Monta o snapshot respeitando o orçamento de bytes. Para grupos grandes, degrada em ordem: textos de plano compactos,
 * depois menos propostas exibidas (do fim para o começo). Nunca corta: GROUP, bloqueios da revisão, cobertura por
 * pessoa dos planos exibidos e pendências (o aviso de omissão vai para o topo).
 */
export function renderSnapshot(base: Snapshot, state: PurchaseState | null, applied: string[], pending: string[], plans: PlanViews = { proposals: [], bag: null }): Snapshot {
  const fits = (x: Snapshot) => Buffer.byteLength(JSON.stringify(x)) <= SNAPSHOT_BUDGET_BYTES;
  let out = build(base, state, applied, pending, plans, false, plans.proposals.length);
  for (let shown = plans.proposals.length; shown >= 0 && !fits(out); shown--) out = build(base, state, applied, pending, plans, true, shown);
  return out;
}

function build(base: Snapshot, state: PurchaseState | null, applied: string[], pending: string[], plans: PlanViews, compact: boolean, shown: number): Snapshot {
  const blocks: Snapshot['blocks'] = [];
  if (state && state.status === 'ACTIVE') {
    blocks.push({
      kind: 'GROUP',
      participants: state.participants.map((p) => ({ participantRef: p.participantId, displayName: p.displayName, conditions: conditions(p) })),
      budgetCents: state.groupLimit.state === 'DECLARED' ? state.groupLimit.value.amountCents : null,
    });
  }
  const summary = applied.length ? applied.join(' ') : 'Nada foi alterado.';
  blocks.push({ kind: 'TEXT', source: 'SERVER', text: clip(summary, 1000) }); // folga para maxResultBytes
  if (state && state.status === 'ACTIVE' && state.groupLimit.state === 'DECLARED') {
    const g = state.groupLimit.value;
    blocks.push({ kind: 'TEXT', source: 'SERVER', text: `${state.participants.length === 1 ? 'Orçamento' : 'Orçamento do grupo'}: ${formatCents(g.amountCents)} (${g.kind === 'MANDATORY' ? 'máximo' : 'referência'}).` });
  }
  if (state && state.status === 'ACTIVE') {
    const coverage = (p: PlanEvaluation) => p.coverage.map((c) => ({ participantRef: c.participantId, status: c.status }));
    plans.proposals.slice(0, shown).forEach((p, i) => {
      // Preço UNKNOWN: o total exato depende da taxa de serviço, só conhecida no carrinho (nunca vira zero).
      blocks.push({ kind: 'PROPOSAL', proposalRef: p.proposal.proposalId, coverage: coverage(p), price: { kind: 'UNKNOWN', currency: 'BRL' } });
      blocks.push({ kind: 'TEXT', source: 'SERVER', text: planText(`Proposta ${i + 1}`, p, state, compact) });
    });
    if (plans.bag) {
      const b = plans.bag;
      blocks.push({ kind: 'REVIEW', reviewRef: b.proposal.proposalId, coverage: coverage(b), price: { kind: 'UNKNOWN', currency: 'BRL' },
        blockers: [...b.approvalBlockers.map((x) => BLOCKER_TEXT[x]), SIMULATED].slice(0, 30) });
      blocks.push({ kind: 'TEXT', source: 'SERVER', text: planText('Carrinho simulado', b, state, compact) });
    }
  }
  const omitted = shown < plans.proposals.length
    ? [`Grupo grande: só ${shown} de ${plans.proposals.length} propostas aparecem aqui; a escolha pela posição (1 a ${plans.proposals.length}) continua valendo.`] : [];
  const phase: Snapshot['phase'] = plans.bag ? 'EDITING_CART' : plans.proposals.length ? 'PROPOSALS_READY' : 'COLLECTING';
  return {
    contractVersion: '1.0', conversationId: base.conversationId, version: base.version + 1, phase,
    blocks, pending: [...new Set([...omitted, ...pending])].slice(0, 30).map((p) => clip(p, 300)), allowedActions: [], humanApproval: null,
  };
}
