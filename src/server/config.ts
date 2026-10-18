// Configuração lida exclusivamente do ambiente. Nunca logar segredos.

export interface AppConfig {
  mcpUrl: string;
  clientId: string | undefined;
  clientSecret: string | undefined;
  redirectUri: string;
  scope: string | undefined;
  webOrigin: string;
  port: number;
  tokenFile: string;
  /** Issuer usado para OIDC discovery (verificado em /.well-known/openid-configuration). */
  authServer: string;
  /** Segredo compartilhado bot→API (Authorization: Bearer). Vazio = rotas do bot desativadas (fail closed). */
  botApiToken: string | undefined;
  /** IDs numéricos do Telegram autorizados como organizador. */
  allowedOrganizerIds: string[];
  /** Diretório dos vínculos Telegram↔iFood (metadados + tokens; fora do Git). */
  linksDir: string;
  /** Base pública do backend para o link de início do login (precisa abrir no navegador da máquina do backend). */
  publicBaseUrl: string;
  /** Habilita a sessão global antiga (/api/auth/*, diagnóstico com MCP). Só desenvolvimento; nunca vira vínculo. */
  devGlobalSession: boolean;
  /** Habilitar só após validar saída MCP e integrar correções #2/#3. Nunca habilita checkout. */
  cartEnabled: boolean;
  /** Opt-in da infraestrutura RUN-01; não instala processador de IA/domínio. */
  conversationRuntime?: { dbFile: string; botId: string };
}

import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Raiz do projeto (src/server/config.ts → ../../). Caminhos relativos de armazenamento são resolvidos a partir dela. */
export const PROJECT_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const fromRoot = (p: string) => (isAbsolute(p) ? p : resolve(PROJECT_ROOT, p));

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  let conversationRuntime: AppConfig['conversationRuntime'];
  if (env.CONVERSATION_RUNTIME_ENABLED === 'true') {
    const botId = env.BOT_TELEGRAM_ID ?? '';
    if (!/^[1-9][0-9]{0,19}$/.test(botId) || botId.trim() !== botId || !env.CONVERSATION_DB_FILE?.trim()) {
      throw new Error('RUN-01 exige BOT_TELEGRAM_ID válido e CONVERSATION_DB_FILE explícito.');
    }
    conversationRuntime = { dbFile: fromRoot(env.CONVERSATION_DB_FILE), botId };
  }
  return {
    mcpUrl: env.IFOOD_MCP_URL || 'https://consumer-mcp.ifood.com.br/marketplace',
    clientId: env.IFOOD_CLIENT_ID || undefined,
    clientSecret: env.IFOOD_CLIENT_SECRET || undefined,
    // Igual ao redirect registrado no client OAuth (sem barra final, sem /callback).
    redirectUri: env.IFOOD_REDIRECT_URI || 'http://localhost:8000',
    scope: env.IFOOD_SCOPE || undefined,
    webOrigin: env.WEB_ORIGIN || 'http://localhost:5173',
    port: Number(env.PORT || 8000),
    tokenFile: fromRoot(env.IFOOD_TOKEN_FILE || '.tokens.json'),
    authServer: env.IFOOD_AUTH_SERVER || 'https://id.ifood.com.br',
    botApiToken: env.BOT_API_TOKEN && env.BOT_API_TOKEN.length >= 32 ? env.BOT_API_TOKEN : undefined,
    allowedOrganizerIds: (env.ALLOWED_ORGANIZER_IDS || '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => /^[1-9][0-9]{0,19}$/.test(s)),
    linksDir: fromRoot(env.IFOOD_LINKS_DIR || '.ifood-links'),
    publicBaseUrl: (env.PUBLIC_BASE_URL || `http://localhost:${Number(env.PORT || 8000)}`).replace(/\/$/, ''),
    devGlobalSession: env.DEV_GLOBAL_SESSION === 'true',
    cartEnabled: env.IFOOD_CART_ENABLED === 'true',
    conversationRuntime,
  };
}

export const config = loadConfig();

/** Mascara um identificador público (ex.: clientId) para diagnóstico. */
export function mask(value: string | undefined): string | null {
  if (!value) return null;
  return value.length <= 6 ? '***' : `${value.slice(0, 4)}…${value.slice(-2)}`;
}
