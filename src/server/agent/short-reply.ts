// Respostas fechadas a perguntas do servidor; nunca inferir ausência de restrições sem contexto.
import type { Snapshot } from '../contracts/conversation.js';
import type { DomainOp, PurchaseState } from '../domain/purchase.js';
import type { AgentProposal } from './model.js';
import { missingQuestions } from './policy.js';

const fold = (v: string) => v.normalize('NFD').replace(/\p{M}/gu, '').trim().toLowerCase();

/**
 * Confirmações humanas explícitas (botões do bot após pergunta de confirmação). Texto literal do usuário, nunca do
 * modelo: o modelo não tem ação equivalente. Apagar usa END (D7 exclui a compra na mesma transação).
 */
export function humanCommand(state: PurchaseState | null, message: string): { ops: DomainOp[]; note: string } | null {
  const text = fold(message);
  if (/^confirmo: apagar todos os dados deste pedido[.!]?$/.test(text)) {
    if (!state || state.status !== 'ACTIVE') return { ops: [], note: 'Não há dados de pedido salvos para apagar.' };
    return { ops: [{ op: 'END', reason: 'CANCELLED' }], note: 'Pedido apagado: pessoas, restrições, orçamento e propostas foram excluídos.' };
  }
  const m = /^confirmo: remover (.+) do pedido[.!]?$/.exec(text);
  if (m) {
    const found = state && state.status === 'ACTIVE' ? state.participants.filter(p => fold(p.displayName) === m[1]!.trim()) : [];
    if (found.length !== 1) return { ops: [], note: 'Não encontrei essa pessoa neste pedido; nada foi alterado.' };
    const p = found[0]!;
    return { ops: [{ op: 'REMOVE_PARTICIPANT', participantId: p.participantId, humanConfirmed: true }],
      note: `${p.displayName} foi removida do pedido, junto com as restrições e o teto dela.` };
  }
  return null;
}

export function shortReply(state: PurchaseState | null, snapshot: Snapshot, message: string):
  { proposal: AgentProposal; policyMessage: string; human?: { ops: DomainOp[]; note: string } } | null {
  const human = humanCommand(state, message);
  if (human) return { proposal: { actions: [] }, policyMessage: message, human };
  const text = fold(message);
  // Comando humano exato: limpa só a composição local, nunca o carrinho remoto.
  if (/^(?:esvaziar|esvazia|limpar|limpa) (?:a )?sacola(?: simulada)?[.!]?$/.test(text)) {
    return { proposal: { actions: [{ action: 'CLEAR_BAG' }] }, policyMessage: message };
  }
  // Escolha do início da conversa (botões do bot). Individual cria uma única pessoa "Você", sem modelo.
  if (/^e um pedido individual, so para mim[.!]?$/.test(text)) {
    if (state && state.status === 'ACTIVE' && state.participants.length) return null; // já há pessoas: o modelo decide
    return { proposal: { actions: [{ action: 'ADD_PARTICIPANT', name: 'Você' }] }, policyMessage: message };
  }
  // Grupo: nenhuma ação; o servidor pergunta quem participa.
  if (/^e um pedido em grupo[.!]?$/.test(text) && !(state && state.status === 'ACTIVE' && state.participants.length))
    return { proposal: { actions: [] }, policyMessage: message };
  if (!/^(?:nao|nenhuma)[.!]?$/.test(text) || !state || state.status !== 'ACTIVE'
    || snapshot.phase !== 'COLLECTING' || state.clarifications.length) return null;
  const questions = missingQuestions(state);
  // Notas de recusa, endereço, outras pendências ou revisão tornam o "não" ambíguo.
  if (JSON.stringify(snapshot.pending) !== JSON.stringify(questions)) return null;
  const person = state.participants.find((p) => p.restrictions.state === 'NOT_ASKED');
  if (!person || questions[0] !== `${person.displayName} tem alguma alergia ou restrição alimentar?`
    || state.participants.filter((p) => p.displayName === person.displayName).length !== 1) return null;
  const group = snapshot.blocks.find((b) => b.kind === 'GROUP');
  if (!group?.participants.some((p) => p.participantRef === person.participantId
    && p.displayName === person.displayName && p.conditions.length === 1
    && p.conditions[0] === 'Restrições: não informadas')) return null;
  // Só NOT_ASKED: nunca remove alergia/dieta já declarada nem resolve UNCLEAR por inferência.
  return { proposal: { actions: [{ action: 'SET_NO_RESTRICTIONS', participant: { ref: person.participantId } }] },
    policyMessage: `${person.displayName} sem restrições` };
}
