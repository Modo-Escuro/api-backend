// Autenticação bot→API (contrato em docs/bot-api.md).
//   Authorization: Bearer <BOT_API_TOKEN>      — prova que a chamada vem do adaptador Telegram
//   X-Telegram-User-Id: <id numérico>          — organizador já validado pelo adaptador (from.id do update)
// A identidade nunca vem do corpo, da query ou de texto do usuário/LLM. Sem configuração ⇒ 503 (fail closed).

import { createHash, timingSafeEqual } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';

export interface BotAuthConfig {
  token: string | undefined;
  allowedOrganizerIds: string[];
  passwordAccess?: boolean;
}

const digest = (s: string) => createHash('sha256').update(s).digest();

export function botAuth(cfg: BotAuthConfig): MiddlewareHandler<{ Variables: { organizerId: string } }> {
  return async (c, next) => {
    if (!cfg.token || (!cfg.passwordAccess && cfg.allowedOrganizerIds.length === 0)) {
      return c.json({ error: { kind: 'BOT_API_NOT_CONFIGURED', message: 'Integração com o bot não configurada no backend' } }, 503);
    }
    const header = c.req.header('authorization') ?? '';
    const m = /^Bearer (.+)$/.exec(header);
    if (!m || !timingSafeEqual(digest(m[1]!), digest(cfg.token))) {
      return c.json({ error: { kind: 'BOT_AUTH_REQUIRED', message: 'Credencial do bot ausente ou inválida' } }, 401);
    }
    const id = c.req.header('x-telegram-user-id') ?? '';
    if (!/^[1-9][0-9]{0,19}$/.test(id)) {
      return c.json({ error: { kind: 'ORGANIZER_REQUIRED', message: 'X-Telegram-User-Id ausente ou inválido' } }, 400);
    }
    const passwordUser = cfg.passwordAccess === true && c.req.header('x-telegram-access') === 'PASSWORD';
    if (!passwordUser && !cfg.allowedOrganizerIds.includes(id)) {
      return c.json({ error: { kind: 'ORGANIZER_NOT_ALLOWED', message: 'Organizador não autorizado' } }, 403);
    }
    c.set('organizerId', id);
    await next();
  };
}

export const organizerOf = (c: Context): string => {
  const id = c.get('organizerId') as string | undefined;
  if (!id) throw new Error('rota de conta sem botAuth');
  return id;
};
