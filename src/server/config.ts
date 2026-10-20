// Configuração lida exclusivamente do ambiente. Nunca logar segredos.
import { GEMINI_BOUNDS, GEMINI_MODEL } from './ai/gemini.js';

/** Configuração do modelo conversacional (AI-01). A chave só existe aqui; nunca é logada nem enviada ao modelo. */
export interface ConversationModelConfig {
  provider: 'google';
  model: typeof GEMINI_MODEL;
  apiKey: string;
  timeoutMs: number;
  maxOutputTokens: number;
  /** Chamadas por processo (obrigatório ao habilitar). */
  maxRequests: number;
  maxRequestsPerConversation: number;
  /** Reserva local de gasto em micro-USD (não substitui o limite de cobrança do provedor). */
  budgetMicroUsd: number;
}

export interface AppConfig {
  mcpUrl: string;
  clientId: string | undefined;
  clientSecret: string | undefined;
  redirectUri: string;
  scope: string | undefined;
  port: number;
  /** Issuer usado para OIDC discovery (verificado em /.well-known/openid-configuration). */
  authServer: string;
  /** Segredo compartilhado bot→API (Authorization: Bearer). Vazio = rotas do bot desativadas (fail closed). */
  botApiToken: string | undefined;
  /** IDs numéricos do Telegram autorizados como organizador. */
  allowedOrganizerIds: string[];
  /** Acesso da demo por senha validada pelo bot autenticado; não é acesso HTTP anônimo. */
  botPasswordAccess?: boolean;
  /** Diretório dos vínculos Telegram↔iFood (metadados + tokens; fora do Git). */
  linksDir: string;
  /** Durabilidade do diretório de vínculos, inferida da plataforma (OPS-01). */
  linksStorage: LinksStorageConfig;
  /** Base pública do backend para o link de início do login (precisa abrir no navegador da máquina do backend). */
  publicBaseUrl: string;
  /** Opt-in da infraestrutura RUN-01; o modelo tem opt-in separado. */
  conversationRuntime?: { dbFile: string; botId: string };
  /**
   * OPS-02: liberação gradual da conversa. Lista vazia = todos os organizadores autorizados (ALLOWED_ORGANIZER_IDS).
   * Só restringe; nunca autoriza alguém fora de ALLOWED_ORGANIZER_IDS.
   */
  conversationOrganizerIds?: string[];
  /**
   * OPS-02: envio de pedido não tem flag. Se alguém definir IFOOD_SUBMIT_ENABLED, o valor é ignorado e reportado
   * (checkout nunca é habilitado por configuração isolada — DEC-01 D8 / BUY-01/02).
   */
  submitFlagIgnored?: boolean;
  /** AI-01: opt-in separado (CONVERSATION_MODEL_ENABLED), provedor Gemini, limites explícitos. */
  conversationModel?: ConversationModelConfig;
  /** CART-01: opt-in local separado da F7; exige manifesto de saídas observadas e o banco DATA-01. */
  confirmedCartWrites?: { evidenceFile: string };
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

/**
 * OPS-02: lista de liberação gradual. Ausente ou vazia = todos os autorizados. Definida com qualquer entrada inválida
 * ⇒ erro de configuração (falha fechada): descartar entradas em silêncio esvaziaria a lista e abriria para todos.
 */
export function parseRollout(raw: string | undefined): string[] {
  if (raw === undefined || raw === '') return [];
  const ids = raw.split(',').map((s) => s.trim());
  if (!ids.every((s) => /^[1-9][0-9]{0,19}$/.test(s))) throw new Error('CONVERSATION_ORGANIZER_IDS inválido: use IDs numéricos separados por vírgula.');
  return [...new Set(ids)];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  if (env.CONVERSATION_ACCOUNT_GROUPS_ENABLED === 'true')
    throw new Error('CONVERSATION_ACCOUNT_GROUPS_ENABLED foi retirado do assistente; grupos antigos são preservados, sem associação automática entre reconexões.');
  // Aceita o valor assistant de instalações anteriores, mas não existe mais seleção de processador.
  if (env.CONVERSATION_AGENT_MODE !== undefined && env.CONVERSATION_AGENT_MODE !== 'assistant')
    throw new Error('CONVERSATION_AGENT_MODE foi retirado; remova a variável. O único processador é o assistente.');
  if (env.IFOOD_CART_ENABLED === 'true' || env.DEV_GLOBAL_SESSION === 'true')
    throw new Error('F7 e sessão global foram retiradas; remova IFOOD_CART_ENABLED e DEV_GLOBAL_SESSION.');
  if (env.BOT_PASSWORD_ACCESS_ENABLED && !['true', 'false'].includes(env.BOT_PASSWORD_ACCESS_ENABLED)) {
    throw new Error('BOT_PASSWORD_ACCESS_ENABLED deve ser true ou false.');
  }
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
  let conversationModel: ConversationModelConfig | undefined;
  if (env.CONVERSATION_MODEL_ENABLED && !['true', 'false'].includes(env.CONVERSATION_MODEL_ENABLED)) {
    throw new Error('CONVERSATION_MODEL_ENABLED deve ser true ou false.');
  }
  // Formato antigo do #35 (CONVERSATION_MODEL=gemini-... sem ENABLED): falhar com motivo claro em vez de subir
  // silenciosamente sem processador. ENABLED=false explícito continua desligando sem erro.
  if (env.CONVERSATION_MODEL_ENABLED === undefined && env.CONVERSATION_MODEL && env.CONVERSATION_MODEL !== 'off') {
    throw new Error('AI-01: CONVERSATION_MODEL definido sem CONVERSATION_MODEL_ENABLED. Use CONVERSATION_MODEL_ENABLED=true (ver docs/ai-01-montagem-ensaio.md) ou remova CONVERSATION_MODEL.');
  }
  if (env.CONVERSATION_MODEL_ENABLED === 'true') {
    const apiKey = env.GEMINI_API_KEY ?? '';
    const organizers = (env.ALLOWED_ORGANIZER_IDS ?? '').split(',').map((s) => s.trim());
    if (!conversationRuntime || !env.BOT_API_TOKEN || env.BOT_API_TOKEN.length < 32 || !organizers.length || organizers.some((s) => !/^[1-9][0-9]{0,19}$/.test(s))) {
      throw new Error('AI-01 exige runtime e adaptador autenticado configurados.');
    }
    if (env.CONVERSATION_MODEL_PROVIDER !== 'google' || env.CONVERSATION_MODEL !== GEMINI_MODEL || !apiKey.trim() || /\s/.test(apiKey)) {
      throw new Error(`AI-01 exige CONVERSATION_MODEL_PROVIDER=google, CONVERSATION_MODEL=${GEMINI_MODEL} e GEMINI_API_KEY válida.`);
    }
    const integer = (key: string, fallback: string, b: { min: number; max: number }) => {
      const raw = env[key] ?? fallback;
      const value = Number(raw);
      if (!/^[0-9]+$/.test(raw) || !Number.isSafeInteger(value) || value < b.min || value > b.max) throw new Error(`AI-01: ${key} inválido.`);
      return value;
    };
    const B = GEMINI_BOUNDS;
    conversationModel = { provider: 'google', model: GEMINI_MODEL, apiKey,
      timeoutMs: integer('CONVERSATION_MODEL_TIMEOUT_MS', String(B.timeoutMs.default), B.timeoutMs),
      maxOutputTokens: integer('CONVERSATION_MODEL_MAX_OUTPUT_TOKENS', String(B.maxOutputTokens.default), B.maxOutputTokens),
      maxRequests: integer('CONVERSATION_MODEL_MAX_REQUESTS', '', B.maxRequests),
      maxRequestsPerConversation: integer('CONVERSATION_MODEL_MAX_REQUESTS_PER_CONVERSATION', String(B.maxRequestsPerConversation.default), B.maxRequestsPerConversation),
      budgetMicroUsd: integer('CONVERSATION_MODEL_BUDGET_MICRO_USD', String(B.budgetMicroUsd.default), B.budgetMicroUsd),
    };
  }
  const links = resolveLinksStorage(env);
  if (env.IFOOD_CONFIRMED_CART_WRITES_ENABLED !== undefined && !['true','false'].includes(env.IFOOD_CONFIRMED_CART_WRITES_ENABLED))
    throw new Error('IFOOD_CONFIRMED_CART_WRITES_ENABLED deve ser true ou false.');
  let confirmedCartWrites: AppConfig['confirmedCartWrites'];
  if (env.IFOOD_CONFIRMED_CART_WRITES_ENABLED === 'true') {
    if (!conversationRuntime || !env.IFOOD_CART_CONTRACT_EVIDENCE_FILE?.trim())
      throw new Error('CART-01 exige DATA-01/RUN-01 e manifesto explícito de contrato observado. Não exige modelo.');
    confirmedCartWrites = { evidenceFile: fromRoot(env.IFOOD_CART_CONTRACT_EVIDENCE_FILE) };
  }
  return {
    mcpUrl: env.IFOOD_MCP_URL || 'https://consumer-mcp.ifood.com.br/marketplace',
    clientId: env.IFOOD_CLIENT_ID || undefined,
    clientSecret: env.IFOOD_CLIENT_SECRET || undefined,
    // Igual ao redirect registrado no client OAuth (sem barra final, sem /callback).
    redirectUri: env.IFOOD_REDIRECT_URI || 'http://localhost:8000',
    scope: env.IFOOD_SCOPE || undefined,
    port: Number(env.PORT || 8000),
    authServer: env.IFOOD_AUTH_SERVER || 'https://id.ifood.com.br',
    botApiToken: env.BOT_API_TOKEN && env.BOT_API_TOKEN.length >= 32 ? env.BOT_API_TOKEN : undefined,
    allowedOrganizerIds: (env.ALLOWED_ORGANIZER_IDS || '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => /^[1-9][0-9]{0,19}$/.test(s)),
    botPasswordAccess: env.BOT_PASSWORD_ACCESS_ENABLED === 'true',
    linksDir: links.dir,
    linksStorage: links.storage,
    publicBaseUrl: (env.PUBLIC_BASE_URL || `http://localhost:${Number(env.PORT || 8000)}`).replace(/\/$/, ''),
    conversationRuntime,
    conversationOrganizerIds: parseRollout(env.CONVERSATION_ORGANIZER_IDS),
    submitFlagIgnored: env.IFOOD_SUBMIT_ENABLED !== undefined,
    conversationModel,
    confirmedCartWrites,
  };
}

export const config = loadConfig();

/** Mascara um identificador público (ex.: clientId) para diagnóstico. */
export function mask(value: string | undefined): string | null {
  if (!value) return null;
  return value.length <= 6 ? '***' : `${value.slice(0, 4)}…${value.slice(-2)}`;
}
