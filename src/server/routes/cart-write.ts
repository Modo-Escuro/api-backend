import { z } from 'zod';
import type { Context, Hono } from 'hono';
import { organizerOf } from '../botAuth.js';
import type { AdapterPrincipal } from '../contracts/guards.js';
import { CartError } from '../cart/contracts.js';
import { LinkError } from '../links/service.js';
import type { ConfirmedCartService } from '../cart/write-service.js';

const prefix = '/api/bot/v1/conversations/:conversationId/cart-writes';
const command = z.object({ purpose: z.literal('PREPARE_CART'), source: z.literal('TELEGRAM_CALLBACK'),
  confirmationRef: z.string().regex(/^[A-Za-z0-9_-]{32}$/), requestId: z.uuid(), callbackId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) }).strict();

/** Canal do adaptador humano. Estas referências nunca entram em ModelContext ou nas ações da IA. */
export function registerCartWriteRoutes(app: Hono, service: ConfirmedCartService | undefined, botId: string | undefined,
  organizerIds: readonly string[] = []) {
  // Falhas de catálogo/MCP podem conter dados privados. Só mensagens fixas atravessam o canal do carrinho.
  const safe = (handler: (c: Context) => Response | Promise<Response>) => async (c: Context) => {
    try { return await handler(c); } catch (error) {
      const failure = error instanceof CartError ? error : error instanceof LinkError
        ? new CartError(error.code, 'Verifique a conexão iFood antes de continuar.', error.httpStatus === 403 ? 403 : error.httpStatus === 503 ? 503 : 409)
        : new CartError('CART_PROVIDER_UNAVAILABLE', 'Não foi possível consultar o carrinho com segurança. Consulte a operação antes de tentar novamente.', 503);
      return c.json({ error: { kind: failure.code, message: failure.message, retryable: false }, purchaseAuthorized: false }, failure.status);
    }
  };
  const principal = (c: Context): AdapterPrincipal => {
    if (!service || !botId) throw new CartError('CART_FEATURE_DISABLED', 'CART-01 indisponível neste ambiente.', 503);
    const organizerId = organizerOf(c), conversationId = c.req.header('x-telegram-chat-id');
    if (organizerIds.length && !organizerIds.includes(organizerId))
      throw new CartError('CART_FEATURE_DISABLED', 'CART-01 indisponível para este organizador.', 503);
    if (conversationId !== organizerId || c.req.param('conversationId') !== conversationId)
      throw new CartError('INVALID_SOURCE', 'Exige callback do organizador em conversa privada.', 403);
    return { organizerId, conversationId, botId };
  };
  const json = async (c: Context) => {
    if (!c.req.header('content-type')?.startsWith('application/json')) throw new CartError('VALIDATION', 'Exige JSON.', 400);
    const text = await c.req.text();
    if (Buffer.byteLength(text) > 4096) throw new CartError('VALIDATION', 'Corpo excede limite.', 400);
    try { return JSON.parse(text); } catch { throw new CartError('VALIDATION', 'JSON inválido.', 400); }
  };
  app.post(`${prefix}/reviews`, safe(async c => {
    const p = principal(c);
    if (!z.object({}).strict().safeParse(await json(c)).success) throw new CartError('VALIDATION', 'A sacola vem da DATA-01, não do chamador.', 400);
    return c.json(await service!.prepare(p));
  }));
  app.post(`${prefix}/confirm`, safe(async c => {
    const p = principal(c), parsed = command.safeParse(await json(c));
    if (!parsed.success) throw new CartError('VALIDATION', 'Callback CART-01 inválido.', 400);
    return c.json(await service!.confirm(p, parsed.data));
  }));
  app.get(`${prefix}/current`, safe(async c => { const p = principal(c); return c.json(await service!.inspect(p)); }));
  app.get(`${prefix}/operations/:operationId`, safe(c => {
    const p = principal(c), id = c.req.param('operationId')!;
    if (!/^[A-Za-z0-9_-]{32}$/.test(id)) throw new CartError('CART_INTENT_NOT_FOUND', 'Intenção não encontrada.', 404);
    return c.json(service!.operation(p, id));
  }));
  app.get(`${prefix}/requests/:requestId`, safe(c => {
    const p = principal(c), requestId = c.req.param('requestId')!;
    if (!z.uuid().safeParse(requestId).success) throw new CartError('VALIDATION', 'requestId inválido.', 400);
    return c.json(service!.request(p, requestId));
  }));
}
