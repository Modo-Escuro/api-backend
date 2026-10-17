// OAuth 2.1 (authorization_code + PKCE S256 + PAR) contra o AS do iFood.
// Endpoints vêm do OIDC discovery (https://id.ifood.com.br/.well-known/openid-configuration).
// Tokens: memória + arquivo (.tokens.json, no .gitignore). Nunca expostos em HTTP/log.

import { createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile, rm } from 'node:fs/promises';
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

const REFRESH_SKEW_MS = 60_000;
const PENDING_TTL_MS = 10 * 60_000;

export class IfoodAuth {
  private tokens: StoredTokens | null = null;
  private loaded = false;
  private metadata: AsMetadata | null = null;
  private pending = new Map<string, PendingLogin>();
  private refreshing: Promise<StoredTokens> | null = null;
  private fetchFn: typeof fetch;

  constructor(
    private readonly cfg: AppConfig = defaultConfig,
    fetchImpl: typeof fetch = fetch,
  ) {
    this.fetchFn = fetchImpl;
  }

  // ---------- storage ----------
  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(await readFile(this.cfg.tokenFile, 'utf8')) as StoredTokens;
      if (raw.clientId && this.cfg.clientId && raw.clientId !== this.cfg.clientId) {
        console.warn('[auth] .tokens.json pertence a outro clientId — ignorado.');
        return;
      }
      if (raw.accessToken) this.tokens = raw;
    } catch {
      /* sem arquivo de token ainda */
    }
  }

  private async save(t: StoredTokens): Promise<void> {
    this.tokens = t;
    await writeFile(this.cfg.tokenFile, JSON.stringify(t, null, 2), { mode: 0o600 });
  }

  async logout(): Promise<void> {
    this.tokens = null;
    await rm(this.cfg.tokenFile, { force: true });
  }

  // ---------- metadata ----------
  async getMetadata(): Promise<AsMetadata> {
    if (this.metadata) return this.metadata;
    const res = await this.fetchFn(`${this.cfg.authServer}/.well-known/openid-configuration`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new AuthError(`OIDC discovery falhou (HTTP ${res.status})`, 'DISCOVERY_FAILED', res.status);
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
    const res = await this.fetchFn(url, {
      method: 'POST',
      headers: {
        Authorization: this.basicAuth(),
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams(body),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      /* corpo não-JSON */
    }
    if (!res.ok) {
      const err = typeof json.error === 'string' ? json.error : 'http_error';
      const desc = typeof json.error_description === 'string' ? `: ${json.error_description}` : '';
      throw new AuthError(`${err}${desc} (HTTP ${res.status})`, err.toUpperCase(), res.status);
    }
    return json;
  }

  // ---------- login ----------
  /** Inicia login: PAR (se suportado) e retorna a URL de autorização para redirecionar o navegador. */
  async startLogin(): Promise<string> {
    const { id } = this.requireClient();
    const md = await this.getMetadata();
    const verifier = b64url(randomBytes(32));
    const state = b64url(randomBytes(16));
    this.gcPending();
    this.pending.set(state, { verifier, createdAt: Date.now() });

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

    if (md.pushed_authorization_request_endpoint) {
      const par = await this.postForm(md.pushed_authorization_request_endpoint, params);
      if (typeof par.request_uri !== 'string') throw new AuthError('PAR sem request_uri', 'PAR_INVALID');
      const u = new URL(md.authorization_endpoint);
      u.searchParams.set('client_id', id);
      u.searchParams.set('request_uri', par.request_uri);
      return u.toString();
    }
    const u = new URL(md.authorization_endpoint);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return u.toString();
  }

  private gcPending() {
    const now = Date.now();
    for (const [k, v] of this.pending) if (now - v.createdAt > PENDING_TTL_MS) this.pending.delete(k);
  }

  /** Troca o code pelo token (callback). */
  async handleCallback(code: string, state: string): Promise<void> {
    const p = this.pending.get(state);
    if (!p) throw new AuthError('state inválido ou expirado — reinicie o login', 'INVALID_STATE', 400);
    this.pending.delete(state);
    const md = await this.getMetadata();
    const json = await this.postForm(md.token_endpoint, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.cfg.redirectUri,
      code_verifier: p.verifier,
      resource: this.cfg.mcpUrl,
    });
    await this.save(this.toStored(json, 'oauth', null));
  }

  private toStored(json: Record<string, unknown>, source: string, prevRefresh: string | null): StoredTokens {
    if (typeof json.access_token !== 'string') throw new AuthError('Resposta de token sem access_token', 'TOKEN_INVALID');
    const expiresIn = typeof json.expires_in === 'number' ? json.expires_in : null;
    return {
      clientId: this.cfg.clientId ?? null,
      accessToken: json.access_token,
      refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : prevRefresh,
      expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : null,
      scope: typeof json.scope === 'string' ? json.scope : null,
      source,
      obtainedAt: Date.now(),
    };
  }

  // ---------- uso ----------
  async refresh(): Promise<StoredTokens> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      await this.load();
      const rt = this.tokens?.refreshToken;
      if (!rt) throw new AuthError('Sem refresh_token — faça login novamente', 'LOGIN_REQUIRED', 401);
      const md = await this.getMetadata();
      const json = await this.postForm(md.token_endpoint, {
        grant_type: 'refresh_token',
        refresh_token: rt,
        resource: this.cfg.mcpUrl,
      });
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
    if (!this.tokens) throw new AuthError('Não autenticado — acesse /api/auth/login', 'LOGIN_REQUIRED', 401);
    if (this.tokens.expiresAt && this.tokens.expiresAt - Date.now() < REFRESH_SKEW_MS) {
      return (await this.refresh()).accessToken;
    }
    return this.tokens.accessToken;
  }

  /** Estado seguro para diagnóstico (sem tokens). */
  async status() {
    await this.load();
    const t = this.tokens;
    return {
      configured: Boolean(this.cfg.clientId && this.cfg.clientSecret),
      authenticated: Boolean(t),
      source: t?.source ?? null,
      expiresAt: t?.expiresAt ? new Date(t.expiresAt).toISOString() : null,
      expired: t?.expiresAt ? t.expiresAt < Date.now() : null,
      hasRefreshToken: Boolean(t?.refreshToken),
      scopes: t?.scope ? t.scope.split(' ') : [],
    };
  }
}

export const auth = new IfoodAuth();
