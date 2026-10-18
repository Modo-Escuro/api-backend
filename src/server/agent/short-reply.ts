// Respostas fechadas a perguntas do servidor; nunca inferir ausência de restrições sem contexto.
import type { Snapshot } from '../contracts/conversation.js';
import type { PurchaseState } from '../domain/purchase.js';
import type { AgentProposal } from './model.js';
import { missingQuestions } from './policy.js';

export function shortReply(state: PurchaseState | null, snapshot: Snapshot, message: string):
  { proposal: AgentProposal; policyMessage: string } | null {
  const text = message.normalize('NFD').replace(/\p{M}/gu, '').trim().toLowerCase();
  // Comando humano exato: limpa só a composição local, nunca o carrinho remoto.
  if (/^(?:esvaziar|esvazia|limpar|limpa) (?:a )?sacola(?: simulada)?[.!]?$/.test(text)) {
    return { proposal: { actions: [{ action: 'CLEAR_BAG' }] }, policyMessage: message };
  }
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
