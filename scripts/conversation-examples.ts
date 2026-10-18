// Casos sintéticos compartilhados; nunca capturar mensagens/contas reais nestas fixtures.
import { mkdirSync, writeFileSync } from 'node:fs';
import { contractErrorResponse } from '../src/server/contracts/errors.js';
import { ErrorCodeSchema, type ConversationEvent, type Operation, type Snapshot } from '../src/server/contracts/conversation.js';

export const source = { channel: 'TELEGRAM', botId: '900001', conversationId: '111111111', kind: 'MESSAGE', messageId: '30' } as const;
export const event: ConversationEvent = {
  contractVersion: '1.0', eventId: 'tg-update-500', conversationId: '111111111', expectedVersion: 0,
  source, input: { kind: 'TEXT', text: 'Agora temos R$150; manter a restrição da participante A.' },
};
export const snapshot: Snapshot = {
  contractVersion: '1.0', conversationId: event.conversationId, version: 1, phase: 'COLLECTING',
  blocks: [{ kind: 'GROUP', participants: [{
    participantRef: 'participant_test_A', displayName: 'Participante A', conditions: ['Restrição obrigatória pendente de evidência.'],
  }], budgetCents: 15000 }],
  pending: ['Faltam participantes e evidência alimentar.'], allowedActions: [], humanApproval: null,
};
export const accepted: Operation = {
  contractVersion: '1.0', operationId: 'operation_test_0001', eventId: event.eventId, conversationId: event.conversationId,
  status: 'ACCEPTED', baseVersion: 0, resultVersion: null, createdAt: '2026-10-18T04:00:00Z',
  deadlineAt: '2026-10-18T04:01:00Z', pollAfterMs: 1000, completeness: 'NONE', snapshot: null, changes: [], error: null,
};
export const completed: Operation = {
  ...accepted, status: 'SUCCEEDED', resultVersion: 1, pollAfterMs: null, completeness: 'COMPLETE', snapshot,
  changes: [{
    changeId: 'change_test_000001', eventId: event.eventId, source, baseVersion: 0, resultVersion: 1,
    paths: ['BUDGET'], cause: 'USER',
  }],
};
export const callback = { ...source, kind: 'CALLBACK', callbackQueryId: 'callback_test_001' } as const;
export const action = { ...event, eventId: 'tg-update-501', expectedVersion: 1, source: callback,
  input: { kind: 'ACTION', action: 'REQUEST_REVIEW', actionRef: 'action_test_000001' } };
export const approval = { contractVersion: '1.0', conversationId: event.conversationId,
  eventId: 'tg-update-502', expectedVersion: 1, source: callback,
  reviewRef: 'review_test_000001', approvalRef: 'approval_test_0001' };
export const review: Snapshot = {
  ...snapshot, phase: 'AWAITING_APPROVAL', pending: [],
  blocks: [{ kind: 'REVIEW', reviewRef: approval.reviewRef,
    coverage: [{ participantRef: 'participant_test_A', status: 'COVERED' }], blockers: [],
    price: { kind: 'CONFIRMED', currency: 'BRL', totalCents: 15000, expiresAt: '2026-10-18T04:05:00Z',
      components: [{ kind: 'ITEMS', amountCents: 14000 }, { kind: 'DELIVERY', amountCents: 1200 }, { kind: 'DISCOUNT', amountCents: 200 }] },
  }],
  humanApproval: { reviewRef: approval.reviewRef, approvalRef: approval.approvalRef, expectedVersion: 1, expiresAt: '2026-10-18T04:04:00Z' },
};

interface Example { name: string; schema: string; valid: boolean; value: unknown }
const examples: Example[] = [];
const good = (name: string, schema: string, value: unknown) => examples.push({ name, schema, valid: true, value });
const bad = (name: string, schema: string, value: unknown) => examples.push({ name, schema, valid: false, value });
good('evento de texto', 'event', event);
good('texto Unicode conta code points', 'event', { ...event, input: { kind: 'TEXT', text: '🍕'.repeat(1001) } });
good('evento de botão', 'event', action);
good('aprovação em canal humano', 'approval', approval);
good('cancelamento local', 'cancel', { contractVersion: '1.0', eventId: 'tg-update-503', conversationId: event.conversationId,
  expectedVersion: 1, source: callback, operationId: accepted.operationId });
good('resultado de cancelamento local', 'cancelResult', {
  contractVersion: '1.0', eventId: 'tg-update-503', conversationId: event.conversationId,
  targetOperationId: accepted.operationId, status: 'REQUESTED', remoteCancellation: 'NOT_REQUESTED',
});
good('operação aceita', 'operation', accepted);
good('cancelamento local pendente', 'operation', { ...accepted, status: 'CANCEL_REQUESTED' });
good('cancelamento local concluído', 'operation', { ...accepted, status: 'CANCELLED', pollAfterMs: null });
good('operação concluída com proveniência', 'operation', completed);
good('resultado parcial exige continuação explícita', 'operation', { ...completed, completeness: 'PARTIAL' });
good('revisão humana sintética', 'snapshot', review);
good('snapshot sem preços confirmados', 'snapshot', snapshot);
good('prazo esgotado sem efeito externo', 'operation', { ...accepted, status: 'FAILED', pollAfterMs: null,
  error: contractErrorResponse('DEADLINE_EXCEEDED').body.error });
good('resultado externo desconhecido', 'operation', { ...accepted, status: 'RESULT_UNKNOWN', pollAfterMs: null,
  error: contractErrorResponse('RESULT_UNKNOWN').body.error });
good('contexto mínimo do modelo', 'modelContext', { contractVersion: '1.0', conversationId: event.conversationId,
  version: 1, phase: snapshot.phase, participantRefs: ['participant_test_A'], pending: snapshot.pending });
for (const code of ErrorCodeSchema.options) good(`erro ${code}`, 'error', contractErrorResponse(code).body);
bad('versão futura', 'event', { ...event, contractVersion: '2.0' });
bad('versão anterior', 'event', { ...event, contractVersion: '0' });
bad('identidade no corpo', 'event', { ...event, organizerId: '222222222' });
bad('consentimento do modelo', 'event', { ...event, userConsent: true });
bad('campo inesperado no input', 'event', { ...event, input: { kind: 'TEXT', text: 'sim', approved: true } });
bad('texto vazio', 'event', { ...event, input: { kind: 'TEXT', text: '' } });
bad('texto excessivo', 'event', { ...event, input: { kind: 'TEXT', text: 'x'.repeat(2001) } });
bad('texto Unicode excessivo', 'event', { ...event, input: { kind: 'TEXT', text: '🍕'.repeat(2001) } });
bad('origem ausente', 'event', { ...event, source: null });
bad('aprovação no evento geral', 'event', { ...action, input: { ...action.input, action: 'APPROVE_PURCHASE' } });
bad('booleano não é versão', 'event', { ...event, expectedVersion: true });
bad('versão fracionária', 'event', { ...event, expectedVersion: 1.5 });
bad('versão não segura', 'event', { ...event, expectedVersion: 9007199254740992 });
bad('credencial na resposta', 'operation', { ...accepted, accessToken: 'synthetic_forbidden' });
bad('erro bruto do provedor', 'error', { contractVersion: '1.0', error: { ...contractErrorResponse('INTERNAL').body.error, providerPayload: {} } });
bad('referência humana no modelo', 'modelContext', { contractVersion: '1.0', conversationId: event.conversationId,
  version: 1, phase: snapshot.phase, participantRefs: [], pending: [], approvalRef: approval.approvalRef });
bad('centavos fracionários', 'snapshot', { ...snapshot, blocks: [{ kind: 'GROUP', participants: [], budgetCents: 1.5 }] });
bad('ausente não é zero', 'snapshot', { ...snapshot, blocks: [{ kind: 'GROUP', participants: [] }] });
bad('origem com identidade inventada', 'event', { ...event, source: { ...source, organizerId: '222222222' } });

mkdirSync('contracts/conversation/v1', { recursive: true });
writeFileSync('contracts/conversation/v1/examples.json', JSON.stringify(examples, null, 2) + '\n');
