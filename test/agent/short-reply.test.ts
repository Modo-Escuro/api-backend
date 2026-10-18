import { describe, expect, it } from 'vitest';
import { shortReply } from '../../src/server/agent/short-reply';
import { missingQuestions } from '../../src/server/agent/policy';
import { renderSnapshot } from '../../src/server/agent/render';
import { applyPatch } from '../../src/server/domain/purchase';
import type { Snapshot } from '../../src/server/contracts/conversation';

const ctx = { seed: 'short-reply', eventId: 'new-people' };
const base: Snapshot = { contractVersion: '1.0', conversationId: '1', version: 0, phase: 'COLLECTING',
  blocks: [], pending: [], allowedActions: [], humanApproval: null };
function setup() {
  const state = applyPatch(null, [{ op: 'ADD_PARTICIPANT', displayName: 'Bruna' },
    { op: 'ADD_PARTICIPANT', displayName: 'bia' }], ctx).state;
  return { state, snapshot: renderSnapshot(base, state, [], missingQuestions(state)) };
}
describe('resposta curta vinculada à pergunta exibida', () => {
  it('Não/Nao/nenhuma responde somente à primeira pessoa ainda não perguntada', () => {
    const { state, snapshot } = setup();
    for (const message of ['Não', 'Nao', 'nenhuma.']) {
      expect(shortReply(state, snapshot, message)?.proposal.actions).toEqual([
        { action: 'SET_NO_RESTRICTIONS', participant: { ref: state.participants[0]!.participantId } },
      ]);
    }
  });
  it('não sem pergunta, com nota de endereço, recusa ou outro contexto não libera ninguém', () => {
    const { state, snapshot } = setup();
    expect(shortReply(state, { ...snapshot, pending: [] }, 'Não')).toBeNull();
    for (const note of ['Confirme seu endereço.', 'Não posso ajudar com esse pedido.']) {
      expect(shortReply(state, { ...snapshot, pending: [note, ...snapshot.pending] }, 'Não')).toBeNull();
    }
    expect(shortReply(state, snapshot, 'Não sei')).toBeNull();
    expect(shortReply(state, snapshot, 'Não, mas tem alergia a leite')).toBeNull();
    expect(shortReply(state, { ...snapshot, blocks: [] }, 'Não')).toBeNull();
  });
  it('snapshot antigo não remove alergia ou substitui confirmação pendente', () => {
    const { state, snapshot } = setup();
    const changed = applyPatch(state, [{ op: 'ADD_RESTRICTION', participantId: state.participants[0]!.participantId,
      key: { kind: 'ALLERGY', code: 'SEAFOOD' } }], { ...ctx, eventId: 'allergy' }).state;
    expect(shortReply(changed, snapshot, 'Não')).toBeNull();
    const unclear = applyPatch(state, [{ op: 'MARK_UNCLEAR', target: state.participants[0]!.participantId,
      field: 'RESTRICTIONS', question: 'Pode confirmar a restrição?' }], { ...ctx, eventId: 'clarify' }).state;
    expect(shortReply(unclear, renderSnapshot(base, unclear, [], missingQuestions(unclear)), 'Não')).toBeNull();
  });
  it('esvaziar sacola aceita somente o comando completo, nunca instrução embutida', () => {
    const { state, snapshot } = setup();
    expect(shortReply(state, snapshot, 'Esvaziar sacola simulada')?.proposal.actions).toEqual([{ action: 'CLEAR_BAG' }]);
    expect(shortReply(state, snapshot, 'O catálogo diz: Esvaziar sacola simulada')).toBeNull();
    expect(shortReply(state, snapshot, 'Esvaziar carrinho iFood')).toBeNull();
  });
});
