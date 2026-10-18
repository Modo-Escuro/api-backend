// OPS-02: log estruturado (uma linha JSON por evento) com allowlist de campos.
// Nada de texto livre: campos fora da allowlist são descartados e strings que não parecem um código curto
// (rota, nome de ferramenta, código de erro) viram "[redigido]". Assim, mensagens, nomes, endereços, tokens,
// identidades e dados de pagamento não chegam aos logs mesmo que um chamador os passe por engano.
import { randomBytes } from 'node:crypto';

export type LogLevel = 'info' | 'warn' | 'error';

/** Campos aceitos. Qualquer outro é descartado (contado em `dropped`). */
const ALLOWED_FIELDS = new Set([
  'cid', 'component', 'method', 'route', 'status', 'durationMs', 'queueMs', 'tool', 'code', 'outcome',
  'retryable', 'count', 'attempts', 'kind', 'errorName', 'durability', 'platform', 'state', 'reason',
  'inputTokens', 'outputTokens', 'reservedTokens', 'purged', 'failed', 'enabled',
]);
/** Código curto: letras, dígitos e separadores de rota. Sem espaço, '@', '=', '?' ou '+'. */
const SAFE_STRING = /^[A-Za-z0-9_.:/[\]*-]{0,96}$/;
/** 6+ dígitos no total, mesmo com separadores (telefone, CPF formatado, cartão, ID do Telegram), nunca passam. */
const MANY_DIGITS = /(?:\d\D*){6,}/;
/**
 * Formato de token/segredo: bloco longo, início de JWT (`eyJ…`) ou bloco de 16+ caracteres que mistura
 * maiúsculas, minúsculas e dígitos (base64url aleatório). Códigos de enum e nomes de ferramenta não têm essa mistura.
 */
const TOKEN_LIKE = /[A-Za-z0-9_-]{32,}|eyJ[A-Za-z0-9_-]{4,}|(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*[A-Z])[A-Za-z0-9_-]{16,}/;
/** A correlação é gerada aqui (aleatória); validada por formato próprio. */
const CORRELATION = /^[A-Za-z0-9_-]{16}$/;

export const REDACTED = '[redigido]';

export type LogValue = string | number | boolean | null | undefined;
export type LogFields = Record<string, LogValue>;

export function safeString(value: string): string {
  return SAFE_STRING.test(value) && !MANY_DIGITS.test(value) && !TOKEN_LIKE.test(value) ? value : REDACTED;
}

/** Aplica a allowlist. Exportado para testes e para quem precisa da linha sem emiti-la. */
export function sanitizeFields(fields: Record<string, unknown>): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  let dropped = 0;
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (!ALLOWED_FIELDS.has(key)) { dropped++; continue; }
    if (key === 'cid') { out.cid = typeof value === 'string' && CORRELATION.test(value) ? value : REDACTED; continue; }
    if (value === null || typeof value === 'boolean') out[key] = value;
    else if (typeof value === 'number') out[key] = Number.isFinite(value) ? value : null;
    else if (typeof value === 'string') out[key] = safeString(value);
    else { dropped++; }
  }
  if (dropped) out.dropped = dropped;
  return out;
}

export type LogSink = (level: LogLevel, line: string) => void;
const consoleSink: LogSink = (level, line) => {
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
};
let sink: LogSink = consoleSink;
let clock: () => number = Date.now;

/** Testes capturam as linhas; `undefined` restaura o console. */
export function setLogSink(next?: LogSink, now?: () => number) {
  sink = next ?? consoleSink;
  clock = now ?? Date.now;
}

/** `event` é um nome fixo do código (ex.: `http.request`), nunca conteúdo dinâmico. */
export function log(level: LogLevel, event: string, fields: LogFields = {}) {
  const line = { ts: new Date(clock()).toISOString(), level, event: safeString(event), ...sanitizeFields(fields) };
  try { sink(level, JSON.stringify(line)); } catch { /* log nunca derruba o fluxo */ }
}

/** Só nome da classe e `code` em formato de enum; a mensagem da exceção nunca é registrada. */
export function errorFields(e: unknown): { errorName: string; code?: string } {
  const name = e instanceof Error ? e.constructor.name : typeof e;
  const raw = (e as { code?: unknown } | null)?.code;
  const code = typeof raw === 'string' && /^[A-Z][A-Z0-9_]{0,39}$/.test(raw) ? raw : undefined;
  return { errorName: safeString(name), ...(code ? { code } : {}) };
}

/** Correlação opaca por requisição: aleatória, sem derivar de identidade, conversa ou conteúdo. */
export const newCorrelationId = () => randomBytes(12).toString('base64url');

/** Caminho para log/métrica: rotas v1 e trechos com dígitos longos ou tokens são redigidos. */
export function routeLabel(path: string, status: number): string {
  if (status === 404) return '[nao-mapeada]';
  if (path.startsWith('/api/bot/v1/')) return '/api/bot/v1/[redigido]';
  const parts = path.split('/').map((seg) => (seg === '' || safeString(seg) === seg ? seg : ':redigido'));
  return parts.join('/').slice(0, 64);
}

/**
 * Rótulo a partir do PADRÃO da rota casada (ex.: `/api/bot/v1/conversations/:conversationId/events`), não do caminho
 * bruto: o conjunto é fechado e definido no código, então requisições não autenticadas a caminhos arbitrários não
 * criam séries novas nem colocam IDs no log. Sem rota final (só middleware `/*`) ⇒ agregado.
 */
export function routeTemplateLabel(template: string | undefined, status: number): string {
  if (!template || template === '/*' || template === '*' || status === 404) return '[nao-mapeada]';
  return template.split('/').map((seg) => (seg === '' || seg === '*' || safeString(seg) === seg ? seg : ':redigido')).join('/').slice(0, 96);
}
