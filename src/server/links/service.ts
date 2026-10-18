// Vínculo organizador Telegram ↔ conta iFood (F3.5). Contrato: docs/bot-api.md.
//
// Garantias:
//  - Identidade do organizador vem SÓ do adaptador autenticado (botAuth), nunca do corpo/LLM.
//  - Tentativa OAuth: state + PKCE aleatórios, validade, uso único, presa ao organizador que a criou.
//  - Link encaminhado: (1) com callback localhost, início e retorno só aceitam conexões da própria máquina;
//    (2) o primeiro navegador que abre o link "reivindica" a tentativa (cookie HttpOnly) e só ele conclui;
//    (3) após o callback, o vínculo fica AGUARDANDO CONFIRMAÇÃO e o bot mostra a identidade mascarada da
//    conta (quando verificável) com o botão "Confirmar conexão" — referência opaca `confirmationId`.
//  - Cada vínculo tem IfoodAuth, arquivo de tokens, sessão MCP e cache próprios.
//  - "Token presente" ≠ operacional: só uma leitura autenticada real (listAddresses) libera operações.
//  - Rede/provedor fora ⇒ UNAVAILABLE (tokens mantidos). Credencial rejeitada ⇒ RECONNECT_REQUIRED.
//  - Login não aprova compra (não há operação de compra no backend).
//  - A sessão global antiga (.tokens.json) nunca é importada como vínculo.

import type { CartGateway } from '../cart/contracts.js';
import { createHash, timingSafeEqual } from 'node:crypto';
import { IfoodAuth, LOGIN_ATTEMPT_TTL_MS, randomToken, type StoredTokens } from '../auth.js';
import type { AppConfig } from '../config.js';
import { ItemCache, type EvaluateDeps } from '../services/evaluate.js';
import { classifyFailure } from './classify.js';
import { identityFromGetUser, UNAVAILABLE_IDENTITY, type AccountIdentity } from './identity.js';
import { LinkStore, type LinkRecord } from './store.js';

export const CONFIRMATION_TTL_MS = 10 * 60_000;
const IDENTITY_TIMEOUT_MS = 10_000;

export type LinkState =
  | 'DISCONNECTED'
  | 'AWAITING_AUTHORIZATION'
  | 'AWAITING_CONFIRMATION'
  | 'CONNECTED'
  | 'RECONNECT_REQUIRED'
  | 'UNAVAILABLE';

export type Operation = 'ADDRESSES_READ' | 'OFFERS_EVALUATE' | 'CART_READ' | 'CART_WRITE' | 'CART_PAYMENT';

/** Escopos exigidos por operação (nomes observados no token real). */
export const OPERATION_SCOPES: Record<Operation, string[]> = {
  CART_READ: ['mcp.cart.read'],
  CART_WRITE: ['mcp.cart.read', 'mcp.cart.write'],
  CART_PAYMENT: ['mcp.cart.read', 'mcp.cart.write', 'mcp.cart.payment'],
  ADDRESSES_READ: ['mcp.user.addresses.read'],
  OFFERS_EVALUATE: ['mcp.user.addresses.read', 'mcp.discovery.search.read', 'mcp.discovery.details.read'],
};

/** Sessão MCP de UM vínculo (deps de leitura ligados ao cliente MCP desse vínculo). */
export interface LinkMcpSession {
  deps: EvaluateDeps;
  cart?: CartGateway;
  /** Perfil básico (getUser sem profileData) — usado só para a identidade mascarada da confirmação. */
  getUser?(): Promise<unknown>;
  close(): Promise<void>;
}
export type SessionFactory = (auth: IfoodAuth) => LinkMcpSession;

export interface OperationalContext {
  linkId: string;
  deps: EvaluateDeps;
  cart?: CartGateway;
  cache: ItemCache;
}

type AttemptStatus =
  | 'PENDING_AUTHORIZATION'
  | 'EXCHANGING'
  | 'PENDING_CONFIRMATION'
  | 'CONFIRMING'
  | 'CONFIRMED'
  | 'EXPIRED'
  | 'FAILED'
  | 'SUPERSEDED'
  | 'CANCELLED';

interface Attempt {
  attemptId: string;
  organizerId: string;
  oauthState: string;
  verifier: string;
  startToken: string;
  createdAt: number;
  authorizationExpiresAt: number;
  status: AttemptStatus;
  /** sha256 do segredo do cookie do navegador que abriu o link primeiro. */
  browserBinding: string | null;
  confirmationId: string | null;
  confirmationExpiresAt: number | null;
  identity: AccountIdentity | null;
  tokens: StoredTokens | null;
  failure: string | null;
}

interface CheckResult {
  at: number;
  outcome: 'OK' | 'UNAVAILABLE' | 'RECONNECT';
  reason: string | null;
  addressCount: number | null;
}

interface LinkRuntime {
  record: LinkRecord;
  auth: IfoodAuth;
  session: LinkMcpSession | null;
  cache: ItemCache;
  lastCheck: CheckResult | null;
  verifying: Promise<CheckResult> | null;
}

export class LinkError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus: 400 | 401 | 403 | 404 | 409 | 410 | 423 | 503,
    readonly state?: LinkState,
    readonly reason?: string | null,
  ) {
    super(message);
  }
}

export interface LinkStatus {
  state: LinkState;
  reason: string | null;
  linkId: string | null;
  connectedAt: string | null;
  operational: boolean;
  verification: { status: 'OK' | 'PENDING' | 'FAILED'; at: string | null; reason: string | null };
  token: { expiresAt: string | null; willRefresh: boolean } | null;
  account: { identity: AccountIdentity | null; addressCount: number | null } | null;
  attempt: {
    attemptId: string;
    status: 'PENDING_AUTHORIZATION' | 'PENDING_CONFIRMATION';
    expiresAt: string;
    /** Referência opaca para o botão "Confirmar conexão" (só após callback válido). */
    confirmationId: string | null;
    /** Identidade mascarada da conta que autorizou (só em PENDING_CONFIRMATION). */
    accountIdentity: AccountIdentity | null;
    /** O link já foi aberto num navegador (reivindicado). */
    browserClaimed: boolean;
  } | null;
  allowedOperations: Operation[];
  scopeEvidence: 'TOKEN_SCOPES' | 'NOT_PROVIDED' | null;
  missingScopes: string[];
  purchaseAuthorized: false;
  limitations: string[];
  nextActions: string[];
}

const sha = (s: string) => createHash('sha256').update(s).digest();
function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(sha(a), sha(b));
}
const iso = (t: number | null | undefined) => (t ? new Date(t).toISOString() : null);

export interface LinkServiceOptions {
  cfg: AppConfig;
  sessionFactory: SessionFactory;
  fetchImpl?: typeof fetch;
  now?: () => number;
  store?: LinkStore;
}

const ACTIVE: AttemptStatus[] = ['PENDING_AUTHORIZATION', 'EXCHANGING', 'PENDING_CONFIRMATION', 'CONFIRMING'];

export class IfoodLinkService {
  private attempts = new Map<string, Attempt>(); // por attemptId
  private byState = new Map<string, string>(); // oauthState → attemptId
  private byConfirmation = new Map<string, string>(); // confirmationId → attemptId
  private current = new Map<string, string>(); // organizerId → attemptId ativo
  private links = new Map<string, LinkRuntime>(); // organizerId → vínculo confirmado
  private lastEnd = new Map<string, string>(); // organizerId → motivo do último encerramento
  private records: Record<string, LinkRecord> = {};
  private readonly cfg: AppConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly store: LinkStore;
  private readonly sessionFactory: SessionFactory;
  private ready: Promise<void> | null = null;

  constructor(opts: LinkServiceOptions) {
    this.cfg = opts.cfg;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    this.store = opts.store ?? new LinkStore(opts.cfg.linksDir);
    this.sessionFactory = opts.sessionFactory;
  }

  /** Carrega vínculos confirmados do disco. Nunca lê a sessão global antiga. */
  init(): Promise<void> {
    this.ready ??= (async () => {
      this.records = await this.store.load();
      for (const r of Object.values(this.records)) {
        if (!this.cfg.allowedOrganizerIds.includes(r.organizerId)) continue; // organizador removido da allowlist
        this.links.set(r.organizerId, this.runtimeFor(r));
      }
    })();
    return this.ready;
  }

  private runtimeFor(record: LinkRecord): LinkRuntime {
    const auth = new IfoodAuth(this.cfg, this.fetchImpl, { tokenFile: this.store.tokenPath(record.tokenFileName), now: this.now });
    return { record, auth, session: null, cache: new ItemCache(), lastCheck: null, verifying: null };
  }

  private session(rt: LinkRuntime): LinkMcpSession {
    rt.session ??= this.sessionFactory(rt.auth);
    return rt.session;
  }

  // ---------------- tentativas ----------------

  private gc(): void {
    const now = this.now();
    for (const a of this.attempts.values()) {
      if (a.status === 'PENDING_AUTHORIZATION' && now > a.authorizationExpiresAt) this.endAttempt(a, 'EXPIRED', 'ATTEMPT_EXPIRED');
      if (a.status === 'PENDING_CONFIRMATION' && a.confirmationExpiresAt && now > a.confirmationExpiresAt) {
        this.endAttempt(a, 'EXPIRED', 'CONFIRMATION_EXPIRED');
      }
    }
    // Remove registros terminais antigos (mantém por 1 h para responder "repetido/expirado").
    for (const [id, a] of this.attempts) {
      if (!ACTIVE.includes(a.status) && now - a.createdAt > 60 * 60_000) {
        this.attempts.delete(id);
        this.byState.delete(a.oauthState);
        if (a.confirmationId) this.byConfirmation.delete(a.confirmationId);
      }
    }
  }

  private endAttempt(a: Attempt, status: AttemptStatus, reason: string): void {
    a.status = status;
    a.failure = reason;
    a.tokens = null; // tokens de tentativa não confirmada são descartados
    if (this.current.get(a.organizerId) === a.attemptId) {
      this.current.delete(a.organizerId);
      if (status !== 'CONFIRMED') this.lastEnd.set(a.organizerId, reason);
    }
  }

  private activeAttempt(organizerId: string): Attempt | null {
    const id = this.current.get(organizerId);
    const a = id ? this.attempts.get(id) : undefined;
    return a && ACTIVE.includes(a.status) ? a : null;
  }

  /** Cria tentativa (substitui a anterior do mesmo organizador). */
  async connect(organizerId: string): Promise<{ status: LinkStatus; authorizationUrl: string; attemptId: string; expiresAt: string }> {
    await this.init();
    this.gc();
    if (!this.cfg.clientId || !this.cfg.clientSecret) throw new LinkError('IFOOD_CLIENT_NOT_CONFIGURED', 'Credenciais OAuth do iFood não configuradas no backend', 503);
    const prev = this.activeAttempt(organizerId);
    if (prev) this.endAttempt(prev, 'SUPERSEDED', 'ATTEMPT_SUPERSEDED');
    const now = this.now();
    const a: Attempt = {
      attemptId: randomToken(18),
      organizerId,
      oauthState: randomToken(32),
      verifier: randomToken(32),
      startToken: randomToken(24),
      createdAt: now,
      authorizationExpiresAt: now + LOGIN_ATTEMPT_TTL_MS,
      status: 'PENDING_AUTHORIZATION',
      browserBinding: null,
      confirmationId: null,
      confirmationExpiresAt: null,
      identity: null,
      tokens: null,
      failure: null,
    };
    this.attempts.set(a.attemptId, a);
    this.byState.set(a.oauthState, a.attemptId);
    this.current.set(organizerId, a.attemptId);
    const url = new URL('/auth/ifood/start', this.cfg.publicBaseUrl);
    url.searchParams.set('a', a.attemptId);
    url.searchParams.set('t', a.startToken);
    return { status: await this.status(organizerId), authorizationUrl: url.toString(), attemptId: a.attemptId, expiresAt: iso(a.authorizationExpiresAt)! };
  }

  /**
   * Navegador abre o link do bot: valida a tentativa, reivindica-a para este navegador e gera a URL do
   * iFood (PAR feito agora). Retorna o segredo a gravar em cookie quando é a primeira abertura.
   */
  async startAuthorization(
    attemptId: string,
    startToken: string,
    browserSecret?: string | null,
  ): Promise<{ url: string; browserSecret: string }> {
    await this.init();
    this.gc();
    const a = this.attempts.get(attemptId);
    if (!a || !safeEqual(a.startToken, startToken)) throw new LinkError('ATTEMPT_NOT_FOUND', 'Link de conexão inválido', 404);
    if (a.status === 'EXPIRED') throw new LinkError('ATTEMPT_EXPIRED', 'Link de conexão expirado — gere outro no Telegram', 410);
    if (a.status !== 'PENDING_AUTHORIZATION') throw new LinkError('ATTEMPT_USED', 'Link de conexão já utilizado ou substituído — gere outro no Telegram', 410);
    let secret = browserSecret ?? null;
    if (a.browserBinding) {
      if (!secret || !safeEqual(a.browserBinding, sha(secret).toString('hex'))) {
        throw new LinkError('BROWSER_MISMATCH', 'Este link já foi aberto em outro navegador. Se não foi você, gere um novo link no Telegram.', 409);
      }
    } else {
      secret = randomToken(32);
      a.browserBinding = sha(secret).toString('hex');
    }
    const authForUrl = new IfoodAuth(this.cfg, this.fetchImpl, { tokenFile: null, now: this.now });
    try {
      return { url: await authForUrl.authorizationUrl(a.oauthState, a.verifier), browserSecret: secret };
    } catch (e) {
      const c = classifyFailure(e);
      throw new LinkError('PROVIDER_UNAVAILABLE', `Não foi possível iniciar a autorização no iFood (${c.kind === 'OTHER' ? 'erro' : c.reason})`, 503);
    }
  }

  /** attemptId dono de um state (para o cookie do navegador no callback). */
  attemptIdForState(state: string | undefined): string | null {
    return state ? this.byState.get(state) ?? null : null;
  }

  /** Callback OAuth: valida, troca o código, consulta a identidade mascarada e deixa AGUARDANDO CONFIRMAÇÃO. */
  async handleCallback(q: { state?: string; code?: string; error?: string; browserSecret?: string | null }): Promise<{ expiresAt: string; identity: AccountIdentity }> {
    await this.init();
    this.gc();
    const id = q.state ? this.byState.get(q.state) : undefined;
    const a = id ? this.attempts.get(id) : undefined;
    if (!a) throw new LinkError('INVALID_STATE', 'Retorno de autorização desconhecido', 400);
    if (a.status === 'EXPIRED') throw new LinkError('ATTEMPT_EXPIRED', 'Tentativa expirada — gere um novo link no Telegram', 410);
    if (a.status !== 'PENDING_AUTHORIZATION') throw new LinkError('ATTEMPT_USED', 'Este retorno já foi utilizado', 410);
    if (this.now() > a.authorizationExpiresAt) {
      this.endAttempt(a, 'EXPIRED', 'ATTEMPT_EXPIRED');
      throw new LinkError('ATTEMPT_EXPIRED', 'Tentativa expirada — gere um novo link no Telegram', 410);
    }
    // Só o navegador que abriu o link conclui (não consome a tentativa em caso de divergência).
    if (!a.browserBinding || !q.browserSecret || !safeEqual(a.browserBinding, sha(q.browserSecret).toString('hex'))) {
      throw new LinkError('BROWSER_MISMATCH', 'Conclua o login no mesmo navegador em que abriu o link do Telegram.', 409);
    }
    a.status = 'EXCHANGING'; // consumo único: callbacks concorrentes com o mesmo state param aqui
    if (q.error || !q.code) {
      this.endAttempt(a, 'FAILED', 'AUTHORIZATION_DENIED');
      throw new LinkError('AUTHORIZATION_DENIED', 'Autorização não concedida no iFood', 400);
    }
    const pendingAuth = new IfoodAuth(this.cfg, this.fetchImpl, { tokenFile: null, now: this.now });
    try {
      a.tokens = await pendingAuth.exchangeCode(q.code, a.verifier, 'telegram-link');
    } catch (e) {
      const c = classifyFailure(e);
      this.endAttempt(a, 'FAILED', c.kind === 'UNAVAILABLE' ? 'PROVIDER_UNAVAILABLE' : 'CODE_EXCHANGE_FAILED');
      throw new LinkError('CODE_EXCHANGE_FAILED', 'Não foi possível concluir a autorização — gere um novo link no Telegram', c.kind === 'UNAVAILABLE' ? 503 : 400);
    }
    // Identidade mascarada para confirmação consciente (falha ⇒ UNAVAILABLE, não bloqueia).
    await pendingAuth.setTokens(a.tokens);
    a.identity = await this.fetchIdentity(pendingAuth);
    if (a.status !== 'EXCHANGING') {
      // Substituída/cancelada durante a troca: descarta.
      a.tokens = null;
      throw new LinkError('ATTEMPT_USED', 'Tentativa substituída — use o link mais recente', 410);
    }
    a.status = 'PENDING_CONFIRMATION';
    a.confirmationId = randomToken(18);
    this.byConfirmation.set(a.confirmationId, a.attemptId);
    a.confirmationExpiresAt = this.now() + CONFIRMATION_TTL_MS;
    return { expiresAt: iso(a.confirmationExpiresAt)!, identity: a.identity };
  }

  private async fetchIdentity(auth: IfoodAuth): Promise<AccountIdentity> {
    const s = this.sessionFactory(auth);
    try {
      if (!s.getUser) return UNAVAILABLE_IDENTITY;
      const payload = await Promise.race([
        s.getUser(),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('identity timeout')), IDENTITY_TIMEOUT_MS).unref?.()),
      ]);
      return identityFromGetUser(payload);
    } catch {
      return UNAVAILABLE_IDENTITY;
    } finally {
      await s.close().catch(() => undefined);
    }
  }

  /** Organizador toca em "Confirmar conexão" no Telegram (bot envia o confirmationId recebido no status). */
  async confirm(organizerId: string, confirmationId: string): Promise<{ status: LinkStatus; previousLinkId: string | null }> {
    await this.init();
    this.gc();
    const id = this.byConfirmation.get(confirmationId);
    const a = id ? this.attempts.get(id) : undefined;
    // Tentativa de outro organizador ⇒ mesmo erro de inexistente (sem oráculo).
    if (!a || a.organizerId !== organizerId) throw new LinkError('CONFIRMATION_NOT_FOUND', 'Confirmação não encontrada', 404);
    if (a.status === 'EXPIRED') throw new LinkError('CONFIRMATION_EXPIRED', 'Confirmação expirada — gere um novo link', 410);
    if (a.status === 'CONFIRMED' || a.status === 'CONFIRMING') {
      throw new LinkError('ALREADY_CONFIRMED', 'Esta conexão já foi confirmada', 410, (await this.status(organizerId)).state);
    }
    if (a.status !== 'PENDING_CONFIRMATION') throw new LinkError('CONFIRMATION_INVALID', 'Tentativa substituída ou cancelada — gere um novo link', 410);
    if (a.confirmationExpiresAt && this.now() > a.confirmationExpiresAt) {
      this.endAttempt(a, 'EXPIRED', 'CONFIRMATION_EXPIRED');
      throw new LinkError('CONFIRMATION_EXPIRED', 'Confirmação expirada — gere um novo link', 410);
    }
    a.status = 'CONFIRMING'; // confirmações concorrentes/repetidas param aqui
    const tokens = a.tokens!;
    const linkId = randomToken(18);
    const record: LinkRecord = {
      linkId,
      organizerId,
      confirmedAt: this.now(),
      tokenFileName: `${linkId}.tokens.json`,
      reconnectReason: null,
      accountIdentity: a.identity,
    };
    const rt = this.runtimeFor(record);
    await rt.auth.setTokens(tokens);
    // Troca de conta/reconexão: encerra o vínculo anterior (tokens, sessão e cache).
    const previous = this.links.get(organizerId) ?? null;
    if (previous) await this.closeRuntime(previous);
    this.links.set(organizerId, rt);
    this.records[organizerId] = record;
    await this.store.save(this.records);
    this.endAttempt(a, 'CONFIRMED', 'CONFIRMED');
    this.lastEnd.delete(organizerId);
    await this.verifyRuntime(rt);
    return { status: await this.status(organizerId), previousLinkId: previous?.record.linkId ?? null };
  }

  private async closeRuntime(rt: LinkRuntime): Promise<void> {
    await rt.session?.close().catch(() => undefined);
    rt.session = null;
    rt.cache = new ItemCache();
    await rt.auth.logout(); // apaga o arquivo de tokens local
  }

  /** Remove o vínculo e encerra a sessão local. Não revoga no provedor (sem suporte verificado). */
  async disconnect(organizerId: string): Promise<{ status: LinkStatus; providerRevocation: 'NOT_ATTEMPTED' }> {
    await this.init();
    const a = this.activeAttempt(organizerId);
    if (a) this.endAttempt(a, 'CANCELLED', 'DISCONNECTED_BY_USER');
    const rt = this.links.get(organizerId);
    if (rt) {
      await this.closeRuntime(rt);
      this.links.delete(organizerId);
      delete this.records[organizerId];
      await this.store.save(this.records);
    }
    this.lastEnd.set(organizerId, 'DISCONNECTED_BY_USER');
    return { status: await this.status(organizerId), providerRevocation: 'NOT_ATTEMPTED' };
  }

  // ---------------- verificação operacional ----------------

  /** Leitura autenticada real (listAddresses). Resultado não é devolvido, só usado para o estado. */
  private verifyRuntime(rt: LinkRuntime): Promise<CheckResult> {
    rt.verifying ??= (async () => {
      let result: CheckResult;
      try {
        const r = await this.session(rt).deps.listAddresses();
        // Zero endereços é sessão válida (≠ falha de autenticação).
        result = { at: this.now(), outcome: 'OK', reason: null, addressCount: Array.isArray(r?.results) ? r.results.length : null };
        if (rt.record.reconnectReason) {
          rt.record.reconnectReason = null;
          await this.store.save(this.records);
        }
      } catch (e) {
        result = await this.applyFailure(rt, e, true);
      }
      rt.lastCheck = result;
      return result;
    })().finally(() => {
      rt.verifying = null;
    });
    return rt.verifying;
  }

  private async applyFailure(rt: LinkRuntime, e: unknown, isVerification: boolean): Promise<CheckResult> {
    const c = classifyFailure(e, { toolErrorsAreUnavailable: isVerification });
    if (c.kind === 'RECONNECT') {
      rt.record.reconnectReason = c.reason;
      await this.store.save(this.records);
      await rt.session?.close().catch(() => undefined);
      rt.session = null;
      return { at: this.now(), outcome: 'RECONNECT', reason: c.reason, addressCount: null };
    }
    if (c.kind === 'UNAVAILABLE') return { at: this.now(), outcome: 'UNAVAILABLE', reason: c.reason, addressCount: null };
    return rt.lastCheck ?? { at: this.now(), outcome: 'OK', reason: null, addressCount: null };
  }

  async verify(organizerId: string): Promise<LinkStatus> {
    await this.init();
    const rt = this.links.get(organizerId);
    if (!rt) throw new LinkError('IFOOD_LINK_REQUIRED', 'Nenhuma conta iFood vinculada', 409, (await this.status(organizerId)).state);
    await this.verifyRuntime(rt);
    return this.status(organizerId);
  }

  /**
   * Executa uma operação de leitura da conta. Sem vínculo confirmado e operacional, nada é chamado.
   * Falhas de credencial durante a operação atualizam o estado do vínculo.
   */
  async withOperational<T>(organizerId: string, op: Operation, fn: (ctx: OperationalContext) => Promise<T>): Promise<T> {
    await this.init();
    const rt = this.links.get(organizerId);
    if (!rt) {
      const s = await this.status(organizerId);
      throw new LinkError('IFOOD_LINK_REQUIRED', 'Conecte e confirme uma conta iFood antes desta operação', 409, s.state, s.reason);
    }
    if (rt.record.reconnectReason) {
      throw new LinkError('IFOOD_RECONNECT_REQUIRED', 'A conexão com o iFood precisa ser refeita', 409, 'RECONNECT_REQUIRED', rt.record.reconnectReason);
    }
    if (!rt.lastCheck || rt.lastCheck.outcome !== 'OK') {
      const check = await this.verifyRuntime(rt);
      if (check.outcome === 'RECONNECT') throw new LinkError('IFOOD_RECONNECT_REQUIRED', 'A conexão com o iFood precisa ser refeita', 409, 'RECONNECT_REQUIRED', check.reason);
      if (check.outcome === 'UNAVAILABLE') throw new LinkError('IFOOD_UNAVAILABLE', 'iFood indisponível no momento — tente novamente mais tarde', 503, 'UNAVAILABLE', check.reason);
    }
    const scopes = await this.scopeCheck(rt);
    const missing = scopes.list ? OPERATION_SCOPES[op].filter((s) => !scopes.list!.includes(s)) : [];
    if (missing.length) throw new LinkError('IFOOD_SCOPE_MISSING', `Escopo insuficiente: ${missing.join(', ')}`, 403, 'CONNECTED', 'MISSING_SCOPES');
    const linkId = rt.record.linkId;
    try {
      return await fn({ linkId, deps: this.session(rt).deps, cart: this.session(rt).cart, cache: rt.cache });
    } catch (e) {
      // Ignora falhas de um vínculo que já foi substituído no meio da operação.
      if (this.links.get(organizerId) === rt) {
        const res = await this.applyFailure(rt, e, false);
        if (res.outcome !== 'OK') rt.lastCheck = res;
        if (res.outcome === 'RECONNECT') throw new LinkError('IFOOD_RECONNECT_REQUIRED', 'A conexão com o iFood precisa ser refeita', 409, 'RECONNECT_REQUIRED', res.reason);
        if (res.outcome === 'UNAVAILABLE') {
          throw new LinkError('IFOOD_UNAVAILABLE', 'iFood indisponível no momento — tente novamente mais tarde', 503, 'UNAVAILABLE', res.reason);
        }
      }
      throw e;
    }
  }

  private async scopeCheck(rt: LinkRuntime): Promise<{ list: string[] | null }> {
    const info = await rt.auth.tokenInfo();
    return { list: info.scopes };
  }

  // ---------------- status ----------------

  async status(organizerId: string): Promise<LinkStatus> {
    await this.init();
    this.gc();
    const a = this.activeAttempt(organizerId);
    const rt = this.links.get(organizerId) ?? null;
    const limitations = [
      'Login não aprova compra: envio de pedidos desabilitado; carrinho F7 depende de habilitação explícita.',
      'O callback OAuth é http://localhost:8000 — abra o link no navegador da mesma máquina do backend.',
    ];
    const nextActions: string[] = [];

    let linkState: LinkState | null = null;
    let reason: string | null = null;
    let operational = false;
    let token: LinkStatus['token'] = null;
    let allowed: Operation[] = [];
    let scopeEvidence: LinkStatus['scopeEvidence'] = null;
    let missingScopes: string[] = [];
    let verification: LinkStatus['verification'] = { status: 'PENDING', at: null, reason: null };

    if (rt) {
      const info = await rt.auth.tokenInfo();
      token = { expiresAt: iso(info.expiresAt), willRefresh: info.hasRefreshToken };
      const check = rt.lastCheck;
      if (check) verification = { status: check.outcome === 'OK' ? 'OK' : 'FAILED', at: iso(check.at), reason: check.reason };
      if (!info.present) {
        linkState = 'RECONNECT_REQUIRED';
        reason = 'TOKENS_MISSING';
      } else if (rt.record.reconnectReason) {
        linkState = 'RECONNECT_REQUIRED';
        reason = rt.record.reconnectReason;
      } else if (info.expired && !info.hasRefreshToken) {
        linkState = 'RECONNECT_REQUIRED';
        reason = 'TOKEN_EXPIRED';
      } else if (check?.outcome === 'UNAVAILABLE') {
        linkState = 'UNAVAILABLE';
        reason = check.reason;
      } else {
        linkState = 'CONNECTED';
        // Token vencido (mesmo com refresh disponível) não é operacional até renovar/verificar.
        operational = check?.outcome === 'OK' && !info.expired;
        reason = operational ? null : info.expired ? 'TOKEN_REFRESH_PENDING' : 'VERIFICATION_PENDING';
      }
      if (linkState === 'CONNECTED') {
        scopeEvidence = info.scopes ? 'TOKEN_SCOPES' : 'NOT_PROVIDED';
        const ops = (Object.keys(OPERATION_SCOPES) as Operation[]).filter((o) => this.cfg.cartEnabled || !o.startsWith('CART_'));
        const has = (s: string) => !info.scopes || info.scopes.includes(s);
        missingScopes = [...new Set(ops.flatMap((o) => OPERATION_SCOPES[o]).filter((s) => !has(s)))];
        if (operational) allowed = ops.filter((o) => OPERATION_SCOPES[o].every(has));
        if (!info.scopes) limitations.push('O token não informou escopos; operações dependem da resposta do iFood.');
      }
    }

    let state: LinkState;
    if (a) {
      state = a.status === 'PENDING_CONFIRMATION' || a.status === 'CONFIRMING' ? 'AWAITING_CONFIRMATION' : 'AWAITING_AUTHORIZATION';
      reason = rt ? `RECONNECTING_FROM_${linkState}` : null;
      nextActions.push(state === 'AWAITING_AUTHORIZATION' ? 'OPEN_AUTHORIZATION_LINK' : 'CONFIRM_CONNECTION', 'CANCEL');
    } else if (linkState) {
      state = linkState;
      if (state === 'CONNECTED') nextActions.push(operational ? 'USE' : 'VERIFY', 'DISCONNECT');
      if (state === 'UNAVAILABLE') nextActions.push('VERIFY', 'DISCONNECT');
      if (state === 'RECONNECT_REQUIRED') nextActions.push('CONNECT', 'DISCONNECT');
    } else {
      state = 'DISCONNECTED';
      reason = this.lastEnd.get(organizerId) ?? 'NEVER_CONNECTED';
      nextActions.push('CONNECT');
    }

    return {
      state,
      reason,
      linkId: rt?.record.linkId ?? null,
      connectedAt: iso(rt?.record.confirmedAt),
      operational,
      verification,
      token,
      account: rt ? { identity: rt.record.accountIdentity ?? null, addressCount: operational ? (rt.lastCheck?.addressCount ?? null) : null } : null,
      attempt: a
        ? {
            attemptId: a.attemptId,
            status: a.status === 'PENDING_CONFIRMATION' || a.status === 'CONFIRMING' ? 'PENDING_CONFIRMATION' : 'PENDING_AUTHORIZATION',
            expiresAt: iso(a.status === 'PENDING_CONFIRMATION' || a.status === 'CONFIRMING' ? a.confirmationExpiresAt : a.authorizationExpiresAt)!,
            confirmationId: a.status === 'PENDING_CONFIRMATION' ? a.confirmationId : null,
            accountIdentity: a.status === 'PENDING_CONFIRMATION' ? a.identity : null,
            browserClaimed: a.browserBinding !== null,
          }
        : null,
      allowedOperations: allowed,
      scopeEvidence,
      missingScopes,
      purchaseAuthorized: false,
      limitations,
      nextActions,
    };
  }

  /** Resumo sem identidades, para o diagnóstico. */
  async summary() {
    await this.init();
    return { confirmedLinks: this.links.size, activeAttempts: [...this.attempts.values()].filter((a) => this.activeAttempt(a.organizerId) === a).length };
  }
}

