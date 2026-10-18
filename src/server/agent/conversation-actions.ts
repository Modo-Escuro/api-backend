// Navegação de leitura/composição local. Nunca emite autorização de carrinho ou pedido.
import { createHash } from 'node:crypto';
import type { ConversationEvent, Snapshot } from '../contracts/conversation.js';
import { ContractError } from '../contracts/guards.js';
import type { PurchaseState } from '../domain/purchase.js';
import { restrictionQuestionTarget } from './short-reply.js';

export function conversationActions(snapshot: Snapshot, state: PurchaseState | null, now: number): Snapshot['allowedActions'] {
  if (!state || state.status !== 'ACTIVE' || ['RESULT_UNKNOWN', 'SUBMITTING'].includes(snapshot.phase)) return [];
  const make = (code: string, kind: Snapshot['allowedActions'][number]['kind']) => ({
    kind, expectedVersion: snapshot.version, expiresAt: new Date(now + 300_000).toISOString(),
    actionRef: code + '_' + createHash('sha256').update(JSON.stringify([state.purchaseId, state.linkId, snapshot.conversationId, snapshot.version, code])).digest('hex').slice(0, 32),
  });
  const actions: Snapshot['allowedActions'] = [];
  if (restrictionQuestionTarget(state, snapshot)) actions.push(make('none', 'EDIT_CONTEXT'));
  snapshot.blocks.filter(b => b.kind === 'PROPOSAL').forEach(b => {
    const index = state.proposals?.findIndex(p => p.proposalId === b.proposalRef) ?? -1;
    if (index >= 0) actions.push(make(`choose${index + 1}`, 'SELECT_PROPOSAL'));
  });
  if (actions.some(a => a.kind === 'SELECT_PROPOSAL') || state.bag || state.searchQuery) {
    actions.push(make('search', 'EDIT_CONTEXT'));
    if (state.searchQuery && state.participants.length) actions.push(make('more', 'EDIT_CONTEXT'));
  }
  if (state.bag?.status === 'CURRENT') actions.push(make('review', 'REQUEST_REVIEW'));
  if (state.bag) actions.push(make('clear', 'EDIT_CONTEXT'));
  return actions;
}

export function resolveConversationAction(event: ConversationEvent, snapshot: Snapshot, state: PurchaseState | null, linkId: string | null, now: number): string {
  if (event.input.kind !== 'ACTION' || event.source.kind !== 'CALLBACK') throw new ContractError('ACTION_UNAVAILABLE');
  const input = event.input;
  const found = snapshot.allowedActions.find(a => a.actionRef === input.actionRef && a.kind === input.action);
  if (!found) throw new ContractError('ACTION_UNAVAILABLE');
  if (found.expectedVersion !== snapshot.version || event.expectedVersion !== snapshot.version) throw new ContractError('STALE_VERSION');
  if (Date.parse(found.expiresAt) <= now) throw new ContractError('REFERENCE_EXPIRED');
  if (state?.linkId !== linkId) throw new ContractError('LINK_CHANGED');
  if (!conversationActions(snapshot, state, now).some(a => a.actionRef === found.actionRef && a.kind === found.kind)) throw new ContractError('ACTION_UNAVAILABLE');
  return found.actionRef.split('_')[0]!;
}
