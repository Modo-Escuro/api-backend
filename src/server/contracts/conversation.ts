// API-01: contrato executável; não registra rotas, não processa turnos e não autoriza compras.
// JSON Schema é gerado a partir destes schemas, para consumo também pelo adaptador Python.
import { z } from 'zod';

export const CONTRACT_VERSION = '1.0' as const;
const version = z.literal(CONTRACT_VERSION);
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const telegramId = z.string().regex(/^[1-9][0-9]{0,19}$/);
const ref = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/);
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const cents = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const instant = z.iso.datetime();
// Quantificar em code points preserva a mesma fronteira em Python, JS e JSON Schema (inclui emoji).
const boundedText = (max: number) => z.string().regex(new RegExp(`^[\\s\\S]{1,${max}}$`, 'u'));
const text = boundedText(2000);
const scope = { channel: z.literal('TELEGRAM'), botId: telegramId, conversationId: telegramId };

export const SourceSchema = z.discriminatedUnion('kind', [
  z.object({ ...scope, kind: z.literal('MESSAGE'), messageId: telegramId }).strict(),
  z.object({ ...scope, kind: z.literal('CALLBACK'), messageId: telegramId, callbackQueryId: id }).strict(),
]);

const envelope = {
  contractVersion: version,
  eventId: id,
  conversationId: telegramId,
  expectedVersion: revision,
  source: SourceSchema,
};

export const ActionKindSchema = z.enum(['SELECT_PROPOSAL', 'REQUEST_REVIEW', 'EDIT_CONTEXT']);
export const EventSchema = z.object({
  ...envelope,
  input: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('TEXT'), text }).strict(),
    z.object({ kind: z.literal('ACTION'), action: ActionKindSchema, actionRef: ref }).strict(),
  ]),
}).strict();

// Canal humano dedicado: este corpo e suas referências nunca são parâmetros de ferramenta do LLM.
export const ApprovalSchema = z.object({ ...envelope, reviewRef: ref, approvalRef: ref }).strict();
export const CancelSchema = z.object({ ...envelope, operationId: ref }).strict();

export const ErrorCodeSchema = z.enum([
  'INVALID_REQUEST', 'UNSUPPORTED_VERSION', 'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND',
  'EVENT_CONFLICT', 'STALE_VERSION', 'INVALID_SOURCE', 'ACTION_UNAVAILABLE', 'REFERENCE_EXPIRED',
  'LINK_CHANGED', 'DEADLINE_EXCEEDED', 'LIMIT_EXCEEDED', 'UNAVAILABLE', 'RESULT_UNKNOWN', 'INTERNAL',
]);
export const SafeErrorSchema = z.object({
  code: ErrorCodeSchema,
  message: text,
  recovery: z.enum(['FIX_REQUEST', 'READ_SNAPSHOT', 'POLL_OPERATION', 'RECONNECT', 'CONTACT_SUPPORT', 'NONE']),
}).strict();
export const ErrorResponseSchema = z.object({ contractVersion: version, error: SafeErrorSchema }).strict();

export const PriceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('UNKNOWN'), currency: z.literal('BRL') }).strict(),
  z.object({ kind: z.literal('ESTIMATE'), currency: z.literal('BRL'), totalCents: cents }).strict(),
  z.object({ kind: z.literal('RANGE'), currency: z.literal('BRL'), minCents: cents, maxCents: cents }).strict(),
  z.object({
    kind: z.literal('CONFIRMED'), currency: z.literal('BRL'), totalCents: cents,
    components: z.array(z.object({ kind: z.enum(['ITEMS', 'DELIVERY', 'FEES', 'DISCOUNT']), amountCents: cents }).strict()).min(1).max(20),
    expiresAt: instant,
  }).strict(),
]);

const phase = z.enum([
  'COLLECTING', 'AWAITING_LINK', 'SEARCHING', 'PROPOSALS_READY', 'EDITING_CART',
  'AWAITING_APPROVAL', 'SUBMITTING', 'CONFIRMED', 'FAILED', 'RESULT_UNKNOWN',
]);
const coverage = z.array(z.object({
  participantRef: ref, status: z.enum(['COVERED', 'BLOCKED', 'NEEDS_VERIFICATION']),
}).strict()).max(100);
export const BlockSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('TEXT'), text, source: z.enum(['SERVER', 'MODEL']) }).strict(),
  z.object({
    kind: z.literal('GROUP'), participants: z.array(z.object({
      participantRef: ref, displayName: boundedText(80), conditions: z.array(text).max(30),
    }).strict()).max(100), budgetCents: cents.nullable(),
  }).strict(),
  z.object({ kind: z.literal('PROPOSAL'), proposalRef: ref, coverage, price: PriceSchema }).strict(),
  z.object({ kind: z.literal('REVIEW'), reviewRef: ref, coverage, price: PriceSchema, blockers: z.array(text).max(30) }).strict(),
  z.object({
    kind: z.literal('OUTCOME'), stage: z.enum(['CART', 'ORDER', 'PAYMENT']),
    status: z.enum(['CONFIRMED', 'FAILED', 'UNKNOWN']), evidenceRef: ref.nullable(),
  }).strict(),
]);
export const SnapshotSchema = z.object({
  contractVersion: version, conversationId: telegramId, version: revision, phase,
  blocks: z.array(BlockSchema).max(30), pending: z.array(text).max(30),
  allowedActions: z.array(z.object({
    kind: ActionKindSchema, actionRef: ref, expectedVersion: revision, expiresAt: instant,
  }).strict()).max(20),
  humanApproval: z.object({
    reviewRef: ref, approvalRef: ref, expectedVersion: revision, expiresAt: instant,
  }).strict().nullable(),
}).strict();

// Registro mínimo de origem. O patch de domínio é persistido por DATA-01 e aponta para changeId.
// Paths são campos de domínio permitidos, nunca JSON Patch arbitrário recebido do modelo.
export const ChangeSchema = z.object({
  changeId: ref, eventId: id, source: SourceSchema, baseVersion: revision, resultVersion: revision,
  paths: z.array(z.enum(['PARTICIPANTS', 'CONDITIONS', 'BUDGET', 'PROPOSALS', 'CART', 'PHASE'])).min(1).max(6),
  cause: z.enum(['USER', 'DERIVED']),
}).strict();

export const OperationSchema = z.object({
  contractVersion: version, operationId: ref, eventId: id, conversationId: telegramId,
  status: z.enum(['ACCEPTED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCEL_REQUESTED', 'CANCELLED', 'RESULT_UNKNOWN']),
  baseVersion: revision, resultVersion: revision.nullable(), createdAt: instant, deadlineAt: instant,
  pollAfterMs: z.number().int().min(100).max(10000).nullable(),
  completeness: z.enum(['NONE', 'PARTIAL', 'COMPLETE']),
  snapshot: SnapshotSchema.nullable(), changes: z.array(ChangeSchema).max(100), error: SafeErrorSchema.nullable(),
}).strict();

// Cancelamento identifica seu próprio evento e aponta para a operação original, sem trocar a origem dela.
export const CancelResultSchema = z.object({
  contractVersion: version, eventId: id, conversationId: telegramId, targetOperationId: ref,
  status: z.enum(['REQUESTED', 'CANCELLED', 'ALREADY_TERMINAL']), remoteCancellation: z.literal('NOT_REQUESTED'),
}).strict();

// DTO de contexto permitido ao modelo. Nunca projetar Snapshot/Operation por spread ou blacklist.
export const ModelContextSchema = z.object({
  contractVersion: version, conversationId: telegramId, version: revision, phase,
  participantRefs: z.array(ref).max(100), pending: z.array(text).max(30),
}).strict();

export const contractSchemas = {
  event: EventSchema, approval: ApprovalSchema, cancel: CancelSchema, snapshot: SnapshotSchema,
  operation: OperationSchema, cancelResult: CancelResultSchema, error: ErrorResponseSchema, change: ChangeSchema, modelContext: ModelContextSchema,
};
export type ConversationEvent = z.infer<typeof EventSchema>;
export type Approval = z.infer<typeof ApprovalSchema>;
export type Snapshot = z.infer<typeof SnapshotSchema>;
export type Operation = z.infer<typeof OperationSchema>;
export type Source = z.infer<typeof SourceSchema>;
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export function toModelContext(snapshot: Snapshot) {
  return ModelContextSchema.parse({
    contractVersion: snapshot.contractVersion, conversationId: snapshot.conversationId,
    version: snapshot.version, phase: snapshot.phase,
    participantRefs: snapshot.blocks.flatMap((b) => b.kind === 'GROUP' ? b.participants.map((p) => p.participantRef) : []),
    pending: snapshot.pending,
  });
}
