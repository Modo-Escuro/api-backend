// OAuth 2.1 (authorization_code + PKCE S256 + PAR) contra o AS do iFood.
// Endpoints vêm do OIDC discovery (https://id.ifood.com.br/.well-known/openid-configuration).
//
// Uma instância de IfoodAuth = um conjunto de tokens (uma sessão). Tokens ficam em memória e,
// quando `tokenFile` é definido, também em arquivo (modo 600, fora do Git). Nunca em HTTP/log.
// Falha de rede/provedor é PROVIDER_UNREACHABLE/PROVIDER_ERROR — nunca equivale a logout.

import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { config as defaultConfig, type AppConfig } from './config.js';

export interface StoredTokens {
  clientId: string | null;
  accessToken: string;
  refreshToken: string | null;
  /** epoch ms */
  expiresAt: number | null;
  scope: string | null;
  source: string;
  obtainedAt: number;
}

interface AsMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  pushed_authorization_request_endpoint?: string;
  code_challenge_methods_supported?: string[];
}

interface PendingLogin {
  verifier: string;
  createdAt: number;
}

export class AuthError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

const b64url = (buf: Buffer) => buf.toString('base64url');
export const pkceChallenge = (verifier: string) => b64url(createHash('sha256').update(verifier).digest());
export const randomToken = (bytes = 32) => b64url(randomBytes(bytes));

const REFRESH_SKEW_MS = 60_000;
export const LOGIN_ATTEMPT_TTL_MS = 10 * 60_000;

export interface AuthOptions {
  /** Arquivo de persistência; null = somente memória. Default: cfg.tokenFile. */
  tokenFile?: string | null;
  now?: () => number;
}

export class IfoodAuth {
  private tokens: StoredTokens | null = null;
  private loaded: boolean;
  private metadata: AsMetadata | null = null;
  private pending = new Map<string, PendingLogin>();
  private refreshing: Promise<StoredTokens> | null = null;
  private fetchFn: typeof fetch;
  private tokenFile: string | null;
  private now: () => number;

  constructor(
    private readonly cfg: AppConfig = defaultConfig,
    fetchImpl: typeof fetch = fetch,
    opts: AuthOptions = {},
  ) {
    this.fetchFn = fetchImpl;
    this.tokenFile = opts.tokenFile === undefined ? cfg.tokenFile : opts.tokenFile;
    this.loaded = this.tokenFile === null;
    this.now = opts.now ?? Date.now;
  }

  // ---------- storage ----------
  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(await readFile(this.tokenFile!, 'utf8')) as StoredTokens;
      if (raw.clientId && this.cfg.clientId && raw.clientId !== this.cfg.clientId) {
        console.warn('[auth] arquivo de token pertence a outro clientId — ignorado.');
        return;
      }
      if (raw.accessToken) this.tokens = raw;
    } catch {
      /* sem arquivo de token ainda */
    }
  }

  private async save(t: StoredTokens): Promise<void> {
    // Memória primeiro: num refresh o AS já rotacionou o refresh_token; perder o novo por falha de disco
    // derrubaria a sessão. Falha de gravação ainda é propagada ao chamador.
    this.tokens = t;
    if (this.tokenFile) {
      // Diretório ausente é criado (700); permissão de diretório existente é responsabilidade do dono (LinkStore.ensureDir).
      await mkdir(dirname(this.tokenFile), { recursive: true, mode: 0o700 });
      await writeFile(this.tokenFile, JSON.stringify(t, null, 2), { mode: 0o600 });
      await chmod(this.tokenFile, 0o600); // arquivo pré-existente mantém a permissão antiga sem isto
    }
  }

  /** Define tokens já obtidos (ex.: após troca de código numa tentativa de vínculo). */
  async setTokens(t: StoredTokens): Promise<void> {
    this.loaded = true;
    await this.save(t);
  }

  /** Passa a persistir em `file` (ex.: quando o vínculo é confirmado). */
  async persistTo(file: string): Promise<void> {
    this.tokenFile = file;
    if (this.tokens) await this.save(this.tokens);
  }

  async logout(): Promise<void> {
    this.tokens = null;
    if (this.tokenFile) await rm(this.tokenFile, { force: true });
  }

  // ---------- metadata ----------
  async getMetadata(): Promise<AsMetadata> {
    if (this.metadata) return this.metadata;
    let res: Response;
    try {
      res = await this.fetchFn(`${this.cfg.authServer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(15_000) });
    } catch (e) {
      throw new AuthError(`AS inacessível: ${e instanceof Error ? e.message : String(e)}`, 'PROVIDER_UNREACHABLE');
    }
    if (!res.ok) throw new AuthError(`OIDC discovery falhou (HTTP ${res.status})`, res.status >= 500 ? 'PROVIDER_ERROR' : 'DISCOVERY_FAILED', res.status);
    this.metadata = (await res.json()) as AsMetadata;
    return this.metadata;
  }

  private requireClient(): { id: string; secret: string } {
    if (!this.cfg.clientId || !this.cfg.clientSecret) {
      throw new AuthError('IFOOD_CLIENT_ID/IFOOD_CLIENT_SECRET não configurados', 'MISSING_CLIENT_CONFIG');
    }
    return { id: this.cfg.clientId, secret: this.cfg.clientSecret };
  }

  /** client_secret_basic (RFC 6749 §2.3.1: form-urlencode antes do base64). */
  private basicAuth(): string {
    const { id, secret } = this.requireClient();
    return 'Basic ' + Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`).toString('base64');
  }

  private async postForm(url: string, body: Record<string, string>): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method: 'POST',
        headers: { Authorization: this.basicAuth(), 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      if (e instanceof AuthError) throw e;
      throw new AuthError(`AS inacessível: ${e instanceof Error ? e.message : String(e)}`, 'PROVIDER_UNREACHABLE');
    }
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      /* corpo não-JSON */
    }
    if (!res.ok) {
      if (res.status >= 500) throw new AuthError(`AS indisponível (HTTP ${res.status})`, 'PROVIDER_ERROR', res.status);
      const err = typeof json.error === 'string' ? json.error : 'http_error';
      const desc = typeof json.error_description === 'string' ? `: ${json.error_description}` : '';
      throw new AuthError(`${err}${desc} (HTTP ${res.status})`, err.toUpperCase(), res.status);
    }
    return json;
  }

  // ---------- autorização (genérico: usado pelo vínculo Telegram e pelo login de desenvolvimento) ----------
  /** URL de autorização com PAR (se suportado) para um state/verifier já criados pelo chamador. */
  async authorizationUrl(state: string, verifier: string): Promise<string> {
    const { id } = this.requireClient();
    const md = await this.getMetadata();
    const params: Record<string, string> = {
      response_type: 'code',
      client_id: id,
      redirect_uri: this.cfg.redirectUri,
      code_challenge: pkceChallenge(verifier),
      code_challenge_method: 'S256',
      state,
      resource: this.cfg.mcpUrl,
    };
    if (this.cfg.scope) params.scope = this.cfg.scope;
    const u = new URL(md.authorization_endpoint);
    if (md.pushed_authorization_request_endpoint) {
      const par = await this.postForm(md.pushed_authorization_request_endpoint, params);
      if (typeof par.request_uri !== 'string') throw new AuthError('PAR sem request_uri', 'PAR_INVALID');
      u.searchParams.set('client_id', id);
      u.searchParams.set('request_uri', par.request_uri);
      return u.toString();
    }
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return u.toString();
  }

  /** Troca o code por tokens (não persiste; o chamador decide onde guardar). */
  async exchangeCode(code: string, verifier: string, source = 'oauth'): Promise<StoredTokens> {
    const md = await this.getMetadata();
    const json = await this.postForm(md.token_endpoint, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.cfg.redirectUri,
      code_verifier: verifier,
      resource: this.cfg.mcpUrl,
    });
    return this.toStored(json, source, null);
  }

  // ---------- login de desenvolvimento (sessão global; só com DEV_GLOBAL_SESSION) ----------
  async startLogin(): Promise<string> {
    const verifier = randomToken();
    const state = randomToken(16);
    this.gcPending();
    this.pending.set(state, { verifier, createdAt: this.now() });
    return this.authorizationUrl(state, verifier);
  }

  hasPendingState(state: string): boolean {
    return this.pending.has(state);
  }

  private gcPending() {
    const now = this.now();
    for (const [k, v] of this.pending) if (now - v.createdAt > LOGIN_ATTEMPT_TTL_MS) this.pending.delete(k);
  }

  async handleCallback(code: string, state: string): Promise<void> {
    const p = this.pending.get(state);
    if (!p) throw new AuthError('state inválido ou expirado — reinicie o login', 'INVALID_STATE', 400);
    this.pending.delete(state); // uso único, mesmo se a troca falhar
    if (this.now() - p.createdAt > LOGIN_ATTEMPT_TTL_MS) throw new AuthError('tentativa de login expirada — reinicie o login', 'ATTEMPT_EXPIRED', 400);
    await this.setTokens(await this.exchangeCode(code, p.verifier));
  }

  private toStored(json: Record<string, unknown>, source: string, prevRefresh: string | null): StoredTokens {
    if (typeof json.access_token !== 'string') throw new AuthError('Resposta de token sem access_token', 'TOKEN_INVALID');
    const expiresIn = typeof json.expires_in === 'number' ? json.expires_in : null;
    return {
      clientId: this.cfg.clientId ?? null,
      accessToken: json.access_token,
      refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : prevRefresh,
      expiresAt: expiresIn ? this.now() + expiresIn * 1000 : null,
      scope: typeof json.scope === 'string' ? json.scope : null,
      source,
      obtainedAt: this.now(),
    };
  }

  // ---------- uso ----------
  async refresh(): Promise<StoredTokens> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      await this.load();
      const rt = this.tokens?.refreshToken;
      if (!rt) throw new AuthError('Token expirado e sem refresh_token — conecte novamente', 'LOGIN_REQUIRED', 401);
      const md = await this.getMetadata();
      const json = await this.postForm(md.token_endpoint, { grant_type: 'refresh_token', refresh_token: rt, resource: this.cfg.mcpUrl });
      const t = this.toStored(json, `${this.tokens?.source ?? 'oauth'}+refresh`, rt);
      await this.save(t);
      return t;
    })();
    try {
      return await this.refreshing;
    } finally {
      this.refreshing = null;
    }
  }

  /** Access token válido (renova se expira em < 60s). */
  async getAccessToken(): Promise<string> {
    await this.load();
    if (!this.tokens) throw new AuthError('Não autenticado', 'LOGIN_REQUIRED', 401);
    if (this.tokens.expiresAt && this.tokens.expiresAt - this.now() < REFRESH_SKEW_MS) {
      return (await this.refresh()).accessToken;
    }
    return this.tokens.accessToken;
  }

  /** Metadados do token, sem valores sensíveis. */
  async tokenInfo() {
    await this.load();
    const t = this.tokens;
    return {
      present: Boolean(t),
      expiresAt: t?.expiresAt ?? null,
      expired: t?.expiresAt ? t.expiresAt < this.now() : null,
      hasRefreshToken: Boolean(t?.refreshToken),
      scopes: t?.scope ? t.scope.split(' ').filter(Boolean) : null,
    };
  }

  /** Estado para o diagnóstico de desenvolvimento (sem tokens). `authenticated` = token presente, não sessão operacional. */
  async status() {
    const i = await this.tokenInfo();
    return {
      configured: Boolean(this.cfg.clientId && this.cfg.clientSecret),
      authenticated: i.present,
      source: this.tokens?.source ?? null,
      expiresAt: i.expiresAt ? new Date(i.expiresAt).toISOString() : null,
      expired: i.expired,
      hasRefreshToken: i.hasRefreshToken,
      scopes: i.scopes ?? [],
    };
  }
}

export const auth = new IfoodAuth();
