// AI-02: snapshot de resposta montado SÓ pelo servidor a partir de fatos validados (issue #16).
// Texto livre do modelo não é exibido: condições, tetos, resumo e perguntas vêm da estrutura gravada e de modelos fixos.
// O bloco GROUP é gerado do estado pré-visualizado e por isso passa na conferência do `finish` (DATA-01).
import type { Snapshot } from '../contracts/conversation.js';
import { formatCents } from '../domain/money.js';
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

export function renderSnapshot(base: Snapshot, state: PurchaseState | null, applied: string[], pending: string[]): Snapshot {
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
    blocks.push({ kind: 'TEXT', source: 'SERVER', text: `Orçamento do grupo: ${formatCents(g.amountCents)} (${g.kind === 'MANDATORY' ? 'máximo' : 'referência'}).` });
  }
  return {
    contractVersion: '1.0', conversationId: base.conversationId, version: base.version + 1, phase: 'COLLECTING',
    blocks, pending: [...new Set(pending)].slice(0, 30).map((p) => clip(p, 300)), allowedActions: [], humanApproval: null,
  };
}
