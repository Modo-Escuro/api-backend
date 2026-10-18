// Configuração lida exclusivamente do ambiente. Nunca logar segredos.
import type { OpenAIModelConfig } from './agent/openai-model.js';

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
  /** Durabilidade do diretório de vínculos, inferida da plataforma (OPS-01). */
  linksStorage: LinksStorageConfig;
  /** Base pública do backend para o link de início do login (precisa abrir no navegador da máquina do backend). */
  publicBaseUrl: string;
  /** Habilita a sessão global antiga (/api/auth/*, diagnóstico com MCP). Só desenvolvimento; nunca vira vínculo. */
  devGlobalSession: boolean;
  /** F7 legada: manter false na demo DEC-01; saída validada não autoriza mudar o escopo. Nunca habilita checkout. */
  cartEnabled: boolean;
  /** Opt-in da infraestrutura RUN-01; o modelo tem opt-in separado. */
  conversationRuntime?: { dbFile: string; botId: string };
  /** AI-01 candidato: opt-in separado, modelo explícito e tentativas limitadas por processo. */
  conversationModel?: OpenAIModelConfig;
}

/**
 * VOLUME     — Railway com volume montado e IFOOD_LINKS_DIR dentro dele: sobrevive a redeploy.
 * EPHEMERAL  — plataforma conhecida sem armazenamento persistente para o diretório (Railway sem volume, Vercel):
 *              tudo se perde no próximo deploy/reinício.
 * UNVERIFIED — produção fora das plataformas conhecidas: a persistência depende da infraestrutura e não é comprovada aqui.
 * LOCAL_DEV  — desenvolvimento local; o diretório sobrevive enquanto a máquina mantiver o disco.
 */
export type LinksDurability = 'VOLUME' | 'EPHEMERAL' | 'UNVERIFIED' | 'LOCAL_DEV';

export interface LinksStorageConfig {
  durability: LinksDurability;
  platform: 'RAILWAY' | 'VERCEL' | 'OTHER' | 'LOCAL';
  /** IFOOD_LINKS_DIR definido explicitamente (senão: volume Railway ou .ifood-links). */
  explicitDir: boolean;
  /** IFOOD_LINKS_ALLOW_EPHEMERAL=true: aceita novos vínculos mesmo sabendo que se perdem no redeploy. */
  allowEphemeral: boolean;
}

import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Raiz do projeto (src/server/config.ts → ../../). Caminhos relativos de armazenamento são resolvidos a partir dela. */
export const PROJECT_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const fromRoot = (p: string) => (isAbsolute(p) ? p : resolve(PROJECT_ROOT, p));
const isInside = (child: string, parent: string) => {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

/** Resolve o diretório de vínculos e classifica sua durabilidade. Exportado para testes. */
export function resolveLinksStorage(env: NodeJS.ProcessEnv): { dir: string; storage: LinksStorageConfig } {
  const railway = Boolean(env.RAILWAY_ENVIRONMENT || env.RAILWAY_ENVIRONMENT_NAME || env.RAILWAY_PROJECT_ID || env.RAILWAY_SERVICE_ID);
  const vercel = env.VERCEL === '1' || Boolean(env.VERCEL_ENV);
  // Variável injetada pela Railway quando há volume anexado ao serviço.
  const volume = env.RAILWAY_VOLUME_MOUNT_PATH && isAbsolute(env.RAILWAY_VOLUME_MOUNT_PATH) ? env.RAILWAY_VOLUME_MOUNT_PATH : undefined;
  const explicitDir = Boolean(env.IFOOD_LINKS_DIR);
  const dir = explicitDir ? fromRoot(env.IFOOD_LINKS_DIR!) : volume ? join(volume, 'ifood-links') : fromRoot('.ifood-links');

  let platform: LinksStorageConfig['platform'];
  let durability: LinksDurability;
  if (vercel) {
    platform = 'VERCEL';
    durability = 'EPHEMERAL';
  } else if (railway) {
    platform = 'RAILWAY';
    durability = volume && isInside(dir, volume) ? 'VOLUME' : 'EPHEMERAL';
  } else if (env.NODE_ENV === 'production') {
    platform = 'OTHER';
    durability = 'UNVERIFIED';
  } else {
    platform = 'LOCAL';
    durability = 'LOCAL_DEV';
  }
  return { dir, storage: { durability, platform, explicitDir, allowEphemeral: env.IFOOD_LINKS_ALLOW_EPHEMERAL === 'true' } };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  let conversationRuntime: AppConfig['conversationRuntime'];
  if (env.CONVERSATION_RUNTIME_ENABLED === 'true') {
    const botId = env.BOT_TELEGRAM_ID ?? '';
    if (!/^[1-9][0-9]{0,19}$/.test(botId) || botId.trim() !== botId || !env.CONVERSATION_DB_FILE?.trim()) {
      throw new Error('RUN-01 exige BOT_TELEGRAM_ID válido e CONVERSATION_DB_FILE explícito.');
    }
    const dbFile = fromRoot(env.CONVERSATION_DB_FILE);
    const storage = resolveLinksStorage({ ...env, IFOOD_LINKS_DIR: dirname(dbFile) }).storage;
    if (storage.durability === 'EPHEMERAL') throw new Error('RUN-01 exige banco em armazenamento persistente.');
    conversationRuntime = { dbFile, botId };
  }
  let conversationModel: OpenAIModelConfig | undefined;
  if (env.CONVERSATION_MODEL_ENABLED && !['true', 'false'].includes(env.CONVERSATION_MODEL_ENABLED)) {
    throw new Error('CONVERSATION_MODEL_ENABLED deve ser true ou false.');
  }
  if (env.CONVERSATION_MODEL_ENABLED === 'true') {
    const model = env.CONVERSATION_MODEL ?? '';
    const apiKey = env.OPENAI_API_KEY ?? '';
    const organizers = (env.ALLOWED_ORGANIZER_IDS ?? '').split(',').map(s => s.trim());
    if (!conversationRuntime || !env.BOT_API_TOKEN || env.BOT_API_TOKEN.length < 32 || !organizers.length || organizers.some(s => !/^[1-9][0-9]{0,19}$/.test(s))) {
      throw new Error('AI-01 exige runtime e adaptador autenticado configurados.');
    }
    if (env.CONVERSATION_MODEL_PROVIDER !== 'openai' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(model) || !apiKey.trim() || /\s/.test(apiKey)) {
      throw new Error('AI-01 exige provedor openai, modelo explícito e OPENAI_API_KEY válida.');
    }
    if (env.IFOOD_CART_ENABLED === 'true' || env.DEV_GLOBAL_SESSION === 'true') throw new Error('AI-01 exige DEC-01: F7 e sessão global desligadas.');
    const integer = (key: string, fallback: string, min: number, max: number) => {
      const raw = env[key] ?? fallback;
      const value = Number(raw);
      if (!/^[0-9]+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`AI-01: ${key} inválido.`);
      return value;
    };
    conversationModel = { provider: 'openai', model, apiKey,
      timeoutMs: integer('CONVERSATION_MODEL_TIMEOUT_MS', '8000', 100, 20000),
      maxOutputTokens: integer('CONVERSATION_MODEL_MAX_OUTPUT_TOKENS', '2048', 256, 4096),
      maxRequests: integer('CONVERSATION_MODEL_MAX_REQUESTS', '', 1, 1000),
    };
  }
  const links = resolveLinksStorage(env);
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
    linksDir: links.dir,
    linksStorage: links.storage,
    publicBaseUrl: (env.PUBLIC_BASE_URL || `http://localhost:${Number(env.PORT || 8000)}`).replace(/\/$/, ''),
    devGlobalSession: env.DEV_GLOBAL_SESSION === 'true',
    cartEnabled: env.IFOOD_CART_ENABLED === 'true',
    conversationRuntime,
    conversationModel,
  };
}

export const config = loadConfig();

/** Mascara um identificador público (ex.: clientId) para diagnóstico. */
export function mask(value: string | undefined): string | null {
  if (!value) return null;
  return value.length <= 6 ? '***' : `${value.slice(0, 4)}…${value.slice(-2)}`;
}
