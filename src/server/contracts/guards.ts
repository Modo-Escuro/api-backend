// Regras semânticas do contrato para os futuros handlers. Sem I/O e sem efeitos de compra.
import { createHash } from 'node:crypto';
import type { Approval, ConversationEvent, ErrorCode, Operation, Snapshot, Source } from './conversation.js';

export class ContractError extends Error {
  constructor(public readonly code: ErrorCode) { super(code); }
}

// Estes dados vêm do middleware/cadastro do adaptador, nunca de body, query ou modelo.
export interface AdapterPrincipal {
  organizerId: string;
  botId: string;
  conversationId: string;
}
export interface OwnedConversation extends AdapterPrincipal { version: number }

export function assertScope(principal: AdapterPrincipal, owner: OwnedConversation, request: { conversationId: string; source: Source }) {
  if (principal.organizerId !== owner.organizerId || principal.botId !== owner.botId ||
      principal.conversationId !== owner.conversationId || request.conversationId !== owner.conversationId) {
    throw new ContractError('NOT_FOUND');
  }
  if (request.source.channel !== 'TELEGRAM' || request.source.botId !== principal.botId ||
      request.source.conversationId !== request.conversationId) throw new ContractError('INVALID_SOURCE');
}

export function assertVersion(expectedVersion: number, currentVersion: number) {
  if (expectedVersion !== currentVersion) throw new ContractError('STALE_VERSION');
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, canonical(v)]));
  }
  return value;
}

// Chave escopada ao organizador/canal/bot/conversa + eventId. Texto/valor não identifica intenção.
export function eventKey(principal: AdapterPrincipal, eventId: string) {
  return JSON.stringify(['TELEGRAM', principal.botId, principal.organizerId, principal.conversationId, eventId]);
}
export function contentHash(request: unknown) {
  return createHash('sha256').update(JSON.stringify(canonical(request))).digest('hex');
}
export function assertReplay(hash: string, savedHash: string) {
  if (hash !== savedHash) throw new ContractError('EVENT_CONFLICT');
}

export interface ActionBinding extends AdapterPrincipal {
  linkId: string;
  expectedVersion: number;
  expiresAt: string;
  consumed: boolean;
}
function assertBinding(binding: ActionBinding, principal: AdapterPrincipal, current: OwnedConversation, linkId: string, now: number) {
  if (binding.organizerId !== principal.organizerId || binding.botId !== principal.botId ||
      binding.conversationId !== current.conversationId) throw new ContractError('NOT_FOUND');
  if (binding.linkId !== linkId) throw new ContractError('LINK_CHANGED');
  const expires = Date.parse(binding.expiresAt);
  if (!Number.isFinite(expires) || !Number.isFinite(now) || expires <= now) throw new ContractError('REFERENCE_EXPIRED');
  assertVersion(binding.expectedVersion, current.version);
  if (binding.consumed) throw new ContractError('ACTION_UNAVAILABLE');
}

export function assertAction(
  request: ConversationEvent, principal: AdapterPrincipal, current: OwnedConversation,
  binding: ActionBinding & { kind: string; actionRef: string }, linkId: string, now: number,
) {
  assertScope(principal, current, request);
  assertVersion(request.expectedVersion, current.version);
  if (request.input.kind !== 'ACTION' || request.source.kind !== 'CALLBACK' ||
      request.input.action !== binding.kind || request.input.actionRef !== binding.actionRef) throw new ContractError('ACTION_UNAVAILABLE');
  assertBinding(binding, principal, current, linkId, now);
}

export interface ApprovalBinding extends ActionBinding {
  reviewRef: string;
  approvalRef: string;
  fingerprint: string;
  totalCents: number;
}
export function assertApproval(
  request: Approval, principal: AdapterPrincipal, current: OwnedConversation,
  binding: ApprovalBinding, review: { linkId: string; fingerprint: string; totalCents: number }, now: number,
) {
  assertScope(principal, current, request);
  assertVersion(request.expectedVersion, current.version);
  if (request.source.kind !== 'CALLBACK' || request.approvalRef !== binding.approvalRef || request.reviewRef !== binding.reviewRef) {
    throw new ContractError('ACTION_UNAVAILABLE');
  }
  assertBinding(binding, principal, current, review.linkId, now);
  if (binding.fingerprint !== review.fingerprint || binding.totalCents !== review.totalCents) throw new ContractError('STALE_VERSION');
  // Isto só valida pré-condições. BUY-01 deve reler o carrinho e consumir autorização + intenção atomicamente.
}

export function assertSnapshot(snapshot: Snapshot, now: number) {
  for (const action of snapshot.allowedActions) {
    assertVersion(action.expectedVersion, snapshot.version);
    if (Date.parse(action.expiresAt) <= now) throw new ContractError('REFERENCE_EXPIRED');
  }
  for (const block of snapshot.blocks) {
    if (block.kind === 'OUTCOME' && block.status === 'CONFIRMED' && block.evidenceRef === null) throw new ContractError('INVALID_REQUEST');
    if (block.kind !== 'PROPOSAL' && block.kind !== 'REVIEW') continue;
    const price = block.price;
    if (price.kind === 'RANGE' && price.minCents > price.maxCents) throw new ContractError('INVALID_REQUEST');
    if (price.kind === 'CONFIRMED') {
      const total = price.components.reduce((s, c) => s + BigInt(c.amountCents) * (c.kind === 'DISCOUNT' ? -1n : 1n), 0n);
      if (total !== BigInt(price.totalCents)) throw new ContractError('INVALID_REQUEST');
    }
  }
  if (snapshot.humanApproval) {
    assertVersion(snapshot.humanApproval.expectedVersion, snapshot.version);
    const review = snapshot.blocks.find((b) => b.kind === 'REVIEW' && b.reviewRef === snapshot.humanApproval!.reviewRef);
    if (snapshot.phase !== 'AWAITING_APPROVAL' || !review || review.kind !== 'REVIEW' || review.price.kind !== 'CONFIRMED' ||
        review.blockers.length || !review.coverage.length || review.coverage.some((c) => c.status !== 'COVERED')) throw new ContractError('ACTION_UNAVAILABLE');
    if (Date.parse(snapshot.humanApproval.expiresAt) <= now || Date.parse(review.price.expiresAt) <= now ||
        Date.parse(snapshot.humanApproval.expiresAt) > Date.parse(review.price.expiresAt)) throw new ContractError('REFERENCE_EXPIRED');
  }
  if ((snapshot.phase === 'RESULT_UNKNOWN' || snapshot.phase === 'SUBMITTING') && (snapshot.humanApproval || snapshot.allowedActions.length)) {
    throw new ContractError('ACTION_UNAVAILABLE');
  }
}

export function assertOperation(operation: Operation, now: number) {
  const pending = ['ACCEPTED', 'RUNNING', 'CANCEL_REQUESTED'].includes(operation.status);
  if ((operation.pollAfterMs !== null) !== pending) throw new ContractError('INVALID_REQUEST');
  if (Date.parse(operation.deadlineAt) < Date.parse(operation.createdAt)) throw new ContractError('INVALID_REQUEST');
  if (operation.status === 'SUCCEEDED' && (operation.error || operation.completeness === 'NONE' || !operation.snapshot || operation.resultVersion === null)) {
    throw new ContractError('INVALID_REQUEST');
  }
  if (operation.status === 'RESULT_UNKNOWN' && operation.error?.code !== 'RESULT_UNKNOWN') throw new ContractError('INVALID_REQUEST');
  if (operation.status === 'FAILED' && !operation.error) throw new ContractError('INVALID_REQUEST');
  if (operation.resultVersion !== null && operation.resultVersion < operation.baseVersion) throw new ContractError('INVALID_REQUEST');
  if (operation.snapshot) {
    if (operation.snapshot.conversationId !== operation.conversationId || operation.snapshot.version !== operation.resultVersion) throw new ContractError('INVALID_SOURCE');
    assertSnapshot(operation.snapshot, now);
  }
  for (const change of operation.changes) {
    if (change.eventId !== operation.eventId || change.source.conversationId !== operation.conversationId ||
        change.baseVersion !== operation.baseVersion || change.resultVersion !== operation.resultVersion ||
        change.resultVersion <= change.baseVersion) throw new ContractError('INVALID_SOURCE');
  }
}
