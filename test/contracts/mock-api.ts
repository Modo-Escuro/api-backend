// Mock de conformidade em memória. NUNCA registrado no app ou usado como persistência de produção.
import { Hono } from 'hono';
import { botAuth, organizerOf } from '../../src/server/botAuth';
import { EventSchema, type ConversationEvent, type Operation } from '../../src/server/contracts/conversation';
import { ContractError, assertReplay, assertScope, assertVersion, contentHash, eventKey, type AdapterPrincipal } from '../../src/server/contracts/guards';
import { contractErrorResponse } from '../../src/server/contracts/errors';

interface SavedEvent { hash: string; event: ConversationEvent; operation: Operation }
export const principal: AdapterPrincipal = { organizerId: '111111111', botId: '900001', conversationId: '111111111' };
export const token = 'synthetic-adapter-token-for-contract-tests';
export function store() { return { version: 0, events: new Map<string, SavedEvent>() }; }
export type Store = ReturnType<typeof store>;

export function mockApi(state: Store) {
  const app = new Hono();
  app.use('*', botAuth({ token, allowedOrganizerIds: [principal.organizerId, '222222222'] }));
  app.onError((err, c) => {
    const r = contractErrorResponse(err instanceof ContractError ? err.code : 'INTERNAL');
    return c.json(r.body, r.status);
  });
  app.post('/api/bot/v1/conversations/:conversationId/events', async (c) => {
    const json = await c.req.json().catch(() => { throw new ContractError('INVALID_REQUEST'); });
    if (json?.contractVersion !== '1.0') throw new ContractError('UNSUPPORTED_VERSION');
    const parsed = EventSchema.safeParse(json);
    if (!parsed.success) throw new ContractError('INVALID_REQUEST');
    const event = parsed.data;
    // O bot autenticado deriva chatId do update privado. Não aceitar conversa escolhida pelo corpo/modelo.
    const authenticated = { organizerId: organizerOf(c), botId: principal.botId, conversationId: c.req.header('x-telegram-chat-id') ?? '' };
    if (authenticated.conversationId !== authenticated.organizerId || c.req.param('conversationId') !== event.conversationId) {
      throw new ContractError('NOT_FOUND');
    }
    assertScope(authenticated, { ...principal, version: state.version }, event);
    const key = eventKey(authenticated, event.eventId);
    const hash = contentHash(event);
    const previous = state.events.get(key);
    // Replay antes da checagem de versão: uma operação concluída pode ter avançado o estado.
    if (previous) {
      assertReplay(hash, previous.hash);
      return c.json(previous.operation, 200);
    }
    assertVersion(event.expectedVersion, state.version);
    // Este mock só aceita texto. Ações dependem de referências emitidas pelo futuro backend.
    if (event.input.kind === 'ACTION') throw new ContractError('ACTION_UNAVAILABLE');
    const operation: Operation = {
      contractVersion: '1.0', eventId: event.eventId, operationId: `operation_mock_${String(state.events.size).padStart(4, '0')}`,
      conversationId: event.conversationId, baseVersion: state.version, resultVersion: null,
      status: 'ACCEPTED', createdAt: '2026-10-18T04:00:00Z', deadlineAt: '2026-10-18T04:01:00Z',
      pollAfterMs: 1000, completeness: 'NONE', snapshot: null, changes: [], error: null,
    };
    state.events.set(key, { hash, event: structuredClone(event), operation });
    return c.json(operation, 202);
  });
  return app;
}
