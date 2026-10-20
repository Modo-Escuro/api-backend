// Fronteira HTTP v1: usa a identidade do middleware autenticado, nunca do modelo.
import type { Context, Hono } from 'hono';
import { organizerOf } from '../botAuth.js';
import { CancelSchema, EventSchema } from '../contracts/conversation.js';
import { contractErrorResponse } from '../contracts/errors.js';
import { ContractError, type AdapterPrincipal } from '../contracts/guards.js';
import type { TurnRuntime } from '../turns/runtime.js';
import type { DeliveryAddresses } from '../services/delivery-addresses.js';
import { addressFailure } from '../services/delivery-addresses.js';
import type { IfoodLinkService } from '../links/service.js';
import { z } from 'zod';

const prefix = '/api/bot/v1/conversations/:conversationId';
const numericId = (s: string) => /^[1-9][0-9]{0,19}$/.test(s) && s.trim() === s;
const opaqueId = (s: string) => /^[A-Za-z0-9_-]{16,64}$/.test(s) && s.trim() === s;

async function body(c: Context): Promise<unknown> {
  if (c.req.header('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    throw new ContractError('INVALID_REQUEST');
  }
  const reader = c.req.raw.body?.getReader();
  if (!reader) throw new ContractError('INVALID_REQUEST');
  const chunks: Uint8Array[] = [];
  let length = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const read = async () => {
      while (true) {
        const r = await reader.read();
        if (r.done) break;
        length += r.value.byteLength;
        if (length > 16_384) throw new ContractError('INVALID_REQUEST');
        chunks.push(r.value);
      }
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    };
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ContractError('INVALID_REQUEST')), 10_000);
      timer.unref();
    });
    const json = await Promise.race([read(), timeout]);
    if (json && typeof json === 'object' && 'contractVersion' in json && json.contractVersion !== '1.0') {
      throw new ContractError('UNSUPPORTED_VERSION');
    }
    return json;
  } catch (error) {
    throw error instanceof ContractError ? error : new ContractError('INVALID_REQUEST');
  } finally {
    if (timer) clearTimeout(timer);
    void reader.cancel().catch(() => undefined);
  }
}

export function registerConversationRoutes(
  app: Hono, runtime: TurnRuntime | undefined, botId: string | undefined, rollout: readonly string[] = [],
  addresses?: DeliveryAddresses, links?: Pick<IfoodLinkService, 'status'>,
) {
  const principal = (c: Context): AdapterPrincipal => {
    if (!runtime || !botId || !numericId(botId)) throw new ContractError('UNAVAILABLE');
    const organizerId = organizerOf(c);
    // OPS-02: fora da liberação gradual ⇒ mesma resposta de recurso desligado (não revela a lista).
    if (rollout.length && !rollout.includes(organizerId)) throw new ContractError('UNAVAILABLE');
    const conversationId = c.req.header('x-telegram-chat-id') ?? '';
    if (!numericId(conversationId) || conversationId !== organizerId) throw new ContractError('INVALID_SOURCE');
    if (c.req.param('conversationId') !== conversationId) throw new ContractError('NOT_FOUND');
    return { organizerId, botId, conversationId };
  };
  const safe = (handler: (c: Context) => Response | Promise<Response>) => async (c: Context) => {
    try { return await handler(c); }
    catch (error) {
      const result = contractErrorResponse(error instanceof ContractError ? error.code : 'INTERNAL');
      return c.json(result.body, result.status);
    }
  };
  app.get(`${prefix}/account-context`, safe(async c => c.json(await runtime!.accountContext(principal(c)))));
  // Diretório de personas salvas no vínculo atual (sem fatos): fonte dos botões de admin do perfil.
  app.get(`${prefix}/memory`, safe(async c => {
    const p = principal(c);
    if (!runtime || !links) throw new ContractError('UNAVAILABLE');
    const { linkId } = await links.status(p.organizerId);
    if (!linkId) return c.json({ contractVersion: '1.0', revision: 0, recipients: [], enabled: false });
    const directory = runtime.store.memory(p).directory(linkId);
    return c.json({ contractVersion: '1.0', revision: directory.revision, recipients: directory.recipients, enabled: true });
  }));
  app.post(`${prefix}/events`, safe(async c => {
    const p = principal(c), parsed = EventSchema.safeParse(await body(c));
    if (!parsed.success) throw new ContractError('INVALID_REQUEST');
    if (parsed.data.conversationId !== p.conversationId) throw new ContractError('NOT_FOUND');
    const session = await runtime!.authorizeSession(p, c.req.header('x-conversation-session'));
    const r = runtime!.accept(p, parsed.data, session);
    return c.json(r.operation, r.status);
  }));
  app.get(`${prefix}/operations/:operationId`, safe(async c => {
    const p = principal(c), id = c.req.param('operationId')!;
    if (!opaqueId(id)) throw new ContractError('NOT_FOUND');
    const session = await runtime!.authorizeSession(p, c.req.header('x-conversation-session'));
    return c.json(runtime!.store.operation(p, id, session?.ref));
  }));
  app.get(`${prefix}/operations/:operationId/progress`, safe(async c => {
    const p = principal(c), id = c.req.param('operationId')!;
    if (!opaqueId(id)) throw new ContractError('NOT_FOUND');
    c.header('Cache-Control', 'no-store');
    const session = await runtime!.authorizeSession(p, c.req.header('x-conversation-session'));
    runtime!.store.operation(p, id, session?.ref);
    return c.json(runtime!.progress(p, id));
  }));
  app.get(prefix, safe(async c => {
    const p = principal(c), session = await runtime!.authorizeSession(p, c.req.header('x-conversation-session'));
    return c.json(runtime!.store.snapshot(p, session?.ref));
  }));
  app.post(`${prefix}/operations/:operationId/cancel`, safe(async c => {
    const p = principal(c), parsed = CancelSchema.safeParse(await body(c));
    if (!parsed.success) throw new ContractError('INVALID_REQUEST');
    if (parsed.data.conversationId !== p.conversationId || parsed.data.operationId !== c.req.param('operationId')) {
      throw new ContractError('NOT_FOUND');
    }
    const session = await runtime!.authorizeSession(p, c.req.header('x-conversation-session'));
    runtime!.store.operation(p, parsed.data.operationId, session?.ref);
    const r = runtime!.cancel(p, parsed.data);
    return c.json(r.result, r.status);
  }));
  app.post(`${prefix}/purchase-approvals`, safe(c => {
    principal(c);
    // BUY-01/02 não implementadas: schema disponível jamais habilita escrita.
    throw new ContractError('ACTION_UNAVAILABLE');
  }));
  app.get(`${prefix}/addresses`, safe(async c => {
    const p = principal(c);
    if (!addresses) throw new ContractError('UNAVAILABLE');
    try { return c.json(await addresses.review(p)); } catch (e) { addressFailure(e); }
  }));
  app.post(`${prefix}/addresses/select`, safe(async c => {
    const p = principal(c);
    if (!addresses) throw new ContractError('UNAVAILABLE');
    const parsed = z.object({ source: z.literal('TELEGRAM_CALLBACK'), choiceRef: z.string().regex(/^[A-Za-z0-9_-]{32}$/) }).strict().safeParse(await body(c));
    if (!parsed.success) throw new ContractError('INVALID_REQUEST');
    try { return c.json(await addresses.select(p, parsed.data.choiceRef)); } catch (e) { addressFailure(e); }
  }));
}
