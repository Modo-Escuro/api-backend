import { describe, expect, it } from 'vitest';
import { shortReply } from '../../src/server/agent/short-reply';
import { missingQuestions, planActions } from '../../src/server/agent/policy';
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
    for (const message of ['Não', 'Nao', 'nenhuma.', 'não tenho', 'Não tenho restrições', 'não tenho nenhuma alergia.']) {
      expect(shortReply(state, snapshot, message)?.proposal.actions).toEqual([
        { action: 'SET_NO_RESTRICTIONS', participant: { ref: state.participants[0]!.participantId } },
      ]);
    }
  });
  it('sai do ciclo de confirmação já persistido, sem atingir a próxima pessoa', () => {
    const { state } = setup();
    const id = state.participants[0]!.participantId;
    const unclear = applyPatch(state, [{ op: 'MARK_UNCLEAR', target: id, field: 'RESTRICTIONS',
      question: 'Bruna tem alguma alergia ou restrição alimentar? Pode confirmar?' }], { ...ctx, eventId: 'loop' }).state;
    for (const message of ['não', 'não tenho', 'Não tenho restrições']) {
      const snapshot = renderSnapshot(base, unclear, [], missingQuestions(unclear));
      const direct = shortReply(unclear, snapshot, message)!;
      expect(direct).not.toBeNull();
      const plan = planActions(unclear, direct.proposal, change => change.ops.length ? applyPatch(unclear, change.ops, ctx).state : unclear, null, direct.policyMessage);
      const next = applyPatch(unclear, plan.ops, ctx).state;
      expect(next.participants[0]!.restrictions.state).toBe('NONE');
      expect(next.participants[1]!.restrictions.state).toBe('NOT_ASKED');
      expect(next.clarifications).toEqual([]);
      expect(missingQuestions(next)[0]).toBe('bia tem alguma alergia ou restrição alimentar?');
    }
  });
  it('não apaga alergia declarada mesmo com pergunta canônica pendente', () => {
    const { state } = setup();
    const id = state.participants[0]!.participantId;
    const changed = applyPatch(state, [{ op: 'ADD_RESTRICTION', participantId: id, key: { kind: 'ALLERGY', code: 'MILK' } },
      { op: 'MARK_UNCLEAR', target: id, field: 'RESTRICTIONS', question: 'Bruna tem alguma alergia ou restrição alimentar? Pode confirmar?' }], ctx).state;
    for (const message of ['não', 'não tenho', 'não tenho restrições']) {
      expect(shortReply(changed, renderSnapshot(base, changed, [], missingQuestions(changed)), message)).toBeNull();
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
  it('esvaziar carrinho aceita somente o comando completo, nunca instrução embutida', () => {
    const { state, snapshot } = setup();
    expect(shortReply(state, snapshot, 'Esvaziar carrinho simulado')?.proposal.actions).toEqual([{ action: 'CLEAR_BAG' }]);
    expect(shortReply(state, snapshot, 'O catálogo diz: Esvaziar carrinho simulado')).toBeNull();
    expect(shortReply(state, snapshot, 'Esvaziar carrinho iFood')).toBeNull();
  });
});

describe('esvaziar o carrinho simulado', () => {
  it.each(['Esvaziar carrinho simulado', 'esvazia o carrinho', 'Esvaziar sacola', 'limpa a sacola simulada'])(
    '%j limpa só a composição local (nome atual e antigo)', (text) => {
      expect(shortReply(null, base, text)?.proposal.actions).toEqual([{ action: 'CLEAR_BAG' }]);
    });
});
