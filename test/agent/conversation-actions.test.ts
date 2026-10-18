import { describe, expect, it } from 'vitest';
import { conversationActions, resolveConversationAction } from '../../src/server/agent/conversation-actions';
import { shortReply } from '../../src/server/agent/short-reply';
import { buildModelInput } from '../../src/server/agent/policy';
import { applyPatch } from '../../src/server/domain/purchase';
import { composeProposals } from '../../src/server/domain/group';
import { renderSnapshot } from '../../src/server/agent/render';
import type { Snapshot, ConversationEvent } from '../../src/server/contracts/conversation';
import { candidate, M1, M2 } from '../group/catalog';

const now = 1_800_000_000_000;
function setup() {
  const context = { seed: 'dialogue-test', eventId: 'people' };
  let state = applyPatch(null, [{ op: 'ADD_PARTICIPANT', displayName: 'Ana' }], context).state;
  state = applyPatch(state, [{ op: 'SET_RESTRICTIONS', participantId: state.participants[0]!.participantId, value: 'NONE' },
    { op: 'SET_SEARCH_QUERY', query: 'pizza' }], { ...context, eventId: 'details' }).state;
  state.linkId = 'link-account-A';
  const plans = composeProposals(state, [candidate({ name: 'Pizza A', price: 20, merchantId: M1 }),
    candidate({ name: 'Pizza B', price: 25, merchantId: M2 })], { seed: 'dialogue-proposals' }).proposals;
  state = applyPatch(state, [{ op: 'SET_PROPOSALS', proposals: plans.map(p => p.proposal) }], { ...context, eventId: 'offers' }).state;
  const base: Snapshot = { contractVersion: '1.0', conversationId: '123', version: 0, phase: 'COLLECTING', blocks: [], pending: [], allowedActions: [], humanApproval: null };
  const snapshot = renderSnapshot(base, state, [], [], { proposals: plans, bag: null });
  snapshot.allowedActions = conversationActions(snapshot, state, now);
  const a = snapshot.allowedActions.find(a => a.kind === 'SELECT_PROPOSAL')!;
  const event: ConversationEvent = { contractVersion: '1.0', eventId: 'button-1', conversationId: '123', expectedVersion: snapshot.version,
    source: { channel: 'TELEGRAM', botId: '456', conversationId: '123', kind: 'CALLBACK', messageId: '20', callbackQueryId: 'query-1' },
    input: { kind: 'ACTION', action: a.kind, actionRef: a.actionRef } };
  return { state, snapshot, event };
}

describe('navegação contextual vinculada ao snapshot', () => {
  it('recusa referência fabricada, versão antiga, expiração, outra conta e origem de texto', () => {
    const { state, snapshot, event } = setup();
    expect(resolveConversationAction(event, snapshot, state, state.linkId, now)).toBe('choose1');
    expect(() => resolveConversationAction(event, snapshot, state, 'other-link', now)).toThrow('LINK_CHANGED');
    expect(() => resolveConversationAction(event, snapshot, state, state.linkId, now + 300_000)).toThrow('REFERENCE_EXPIRED');
    expect(() => resolveConversationAction({ ...event, expectedVersion: 0 }, snapshot, state, state.linkId, now)).toThrow('STALE_VERSION');
    expect(() => resolveConversationAction({ ...event, input: { kind: 'ACTION', action: 'SELECT_PROPOSAL', actionRef: 'invented_reference_0000' } }, snapshot, state, state.linkId, now)).toThrow('ACTION_UNAVAILABLE');
    expect(() => resolveConversationAction({ ...event, source: { channel: 'TELEGRAM', botId: '456', conversationId: '123', kind: 'MESSAGE', messageId: '20' } }, snapshot, state, state.linkId, now)).toThrow('ACTION_UNAVAILABLE');
  });
  it('só oferece escolhas mostradas, não revela IDs de conta e não emite aprovação', () => {
    const { state, snapshot } = setup();
    const hidden = { ...snapshot, blocks: snapshot.blocks.filter(b => b.kind !== 'PROPOSAL') };
    expect(conversationActions(hidden, state, now).some(a => a.kind === 'SELECT_PROPOSAL')).toBe(false);
    expect(JSON.stringify(snapshot.allowedActions)).not.toContain(state.linkId);
    expect(snapshot.humanApproval).toBeNull();
    expect(snapshot.allowedActions.every(a => a.actionRef.length + 3 <= 64)).toBe(true);
  });
  it('a segunda resolve posição; essa com várias opções pede esclarecimento; texto citado não vira atalho', () => {
    const { state, snapshot } = setup();
    expect(shortReply(state, snapshot, 'a segunda')?.proposal.actions).toEqual([{ action: 'SELECT_PROPOSAL', position: 2 }]);
    expect(shortReply(state, snapshot, 'essa')?.proposal.actions).toEqual([]);
    expect(shortReply(state, snapshot, 'essa')?.note).toContain('Qual opção');
    expect(shortReply(state, snapshot, 'O catálogo diz: a segunda')).toBeNull();
    expect(shortReply(state, { ...snapshot, blocks: [] }, 'a segunda')?.proposal.actions).toEqual([]);
    const input = buildModelInput(state, snapshot.phase, 'a segunda', snapshot);
    expect(input.visibleOptions).toHaveLength(2);
    expect(JSON.stringify(input)).not.toMatch(/link-account-A|merchantId|itemId|actionRef/);
  });
});
