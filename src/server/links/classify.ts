// Classifica falhas de uma sessão iFood. Regra central: falha de rede/provedor NÃO é logout.
//  RECONNECT   — credencial comprovadamente inválida (refresh recusado, token rejeitado após refresh).
//  UNAVAILABLE — rede, timeout, 5xx, AS fora, erro interno do provedor: tokens são mantidos.
//  OTHER       — erro da operação (ex.: validação de uma tool); não muda o estado do vínculo.

import { AuthError } from '../auth.js';
import { McpToolError } from '../mcp/errors.js';

export type FailureClass =
  | { kind: 'RECONNECT'; reason: 'REFRESH_REJECTED' | 'TOKEN_EXPIRED' | 'TOKEN_REJECTED' | 'ACCESS_FORBIDDEN' }
  | { kind: 'UNAVAILABLE'; reason: 'AUTH_PROVIDER_UNAVAILABLE' | 'MCP_UNAVAILABLE' | 'PROVIDER_ERROR' | 'CLIENT_CONFIG_REJECTED' | 'NETWORK_ERROR' }
  | { kind: 'OTHER' };

/** Erros OAuth (RFC 6749 §5.2) que significam credencial inválida para refresh. */
const REJECTED_GRANT = new Set(['INVALID_GRANT', 'INVALID_TOKEN', 'UNAUTHORIZED_CLIENT', 'ACCESS_DENIED']);

function httpStatus(e: unknown): number | undefined {
  const c = (e as { code?: unknown })?.code;
  return typeof c === 'number' ? c : undefined;
}

export function classifyFailure(e: unknown, opts: { toolErrorsAreUnavailable?: boolean } = {}): FailureClass {
  if (e instanceof AuthError) {
    if (e.code === 'LOGIN_REQUIRED') return { kind: 'RECONNECT', reason: 'TOKEN_EXPIRED' };
    if (REJECTED_GRANT.has(e.code)) return { kind: 'RECONNECT', reason: 'REFRESH_REJECTED' };
    if (e.code === 'PROVIDER_UNREACHABLE' || e.code === 'PROVIDER_ERROR' || e.code === 'DISCOVERY_FAILED') {
      return { kind: 'UNAVAILABLE', reason: 'AUTH_PROVIDER_UNAVAILABLE' };
    }
    if (e.code === 'INVALID_CLIENT' || e.code === 'MISSING_CLIENT_CONFIG') return { kind: 'UNAVAILABLE', reason: 'CLIENT_CONFIG_REJECTED' };
    // Outro 4xx do AS no refresh: não comprova revogação ⇒ indisponível, mantém tokens.
    return { kind: 'UNAVAILABLE', reason: 'AUTH_PROVIDER_UNAVAILABLE' };
  }
  if (e instanceof McpToolError) {
    return opts.toolErrorsAreUnavailable ? { kind: 'UNAVAILABLE', reason: 'PROVIDER_ERROR' } : { kind: 'OTHER' };
  }
  const status = httpStatus(e);
  const name = (e as { name?: unknown })?.name;
  // 401 do transporte MCP chega aqui só depois de o fetch autenticado já ter tentado o refresh.
  if (status === 401 || name === 'UnauthorizedError') return { kind: 'RECONNECT', reason: 'TOKEN_REJECTED' };
  if (status === 403) return { kind: 'RECONNECT', reason: 'ACCESS_FORBIDDEN' };
  if (status !== undefined && status >= 500) return { kind: 'UNAVAILABLE', reason: 'MCP_UNAVAILABLE' };
  if (isNetworkError(e)) return { kind: 'UNAVAILABLE', reason: 'NETWORK_ERROR' };
  // Erro desconhecido: numa verificação conta como indisponível (nunca logout); numa operação não muda o vínculo.
  return opts.toolErrorsAreUnavailable ? { kind: 'UNAVAILABLE', reason: 'NETWORK_ERROR' } : { kind: 'OTHER' };
}

const MCP_REQUEST_TIMEOUT = -32001;

export function isNetworkError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  if ((e as { code?: unknown }).code === MCP_REQUEST_TIMEOUT) return true;
  if (e.name === 'AbortError' || e.name === 'TimeoutError') return true;
  if (e.name === 'TypeError' && /fetch failed|network/i.test(e.message)) return true;
  const cause = (e as { cause?: { code?: unknown } }).cause?.code;
  if (typeof cause === 'string' && /^(ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EPIPE|UND_ERR)/.test(cause)) return true;
  return /timed? ?out|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(e.message);
}
