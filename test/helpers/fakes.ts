// Fakes para testes de vínculo: AS OAuth, sessão MCP por vínculo (fixtures reais) e relógio.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IfoodAuth } from '../../src/server/auth';
import { loadConfig, type AppConfig } from '../../src/server/config';
import { McpToolError } from '../../src/server/mcp/errors';
import type { SearchOffersArgs } from '../../src/server/mcp/types';
import { IfoodLinkService, type LinkMcpSession } from '../../src/server/links/service';
import type { EvaluateDeps } from '../../src/server/services/evaluate';

export const fx = (n: string) => JSON.parse(readFileSync(`fixtures/${n}`, 'utf8'));
export const ITEMS = new Map<string, unknown>(
  [...fx('getItem-samples.json'), ...fx('getItem-pricing-audit.json')].map((i: { itemId: string }) => [i.itemId, i]),
);
/** Endereço SINTÉTICO (fixtures não guardam dados pessoais). */
export const ADDRESS = { addressId: 'addr-test-1', alias: 'Casa', coordinates: { latitude: -1.5, longitude: -2.5 } };

export const BOT_TOKEN = 'test-bot-token-0123456789abcdefghijklmnop';
export const ORG_A = '111111111';
export const ORG_B = '222222222';

export class Clock {
  t = 1_800_000_000_000;
  now = () => this.t;
  advance(ms: number) {
    this.t += ms;
  }
}

// ---------------- AS OAuth falso ----------------
export type AsMode = 'ok' | 'invalid_grant' | 'server_error' | 'network';
export class FakeAs {
  calls: { url: string; body: URLSearchParams }[] = [];
  refreshMode: AsMode = 'ok';
  exchangeMode: AsMode = 'ok';
  expiresIn = 3600;
  issueRefreshToken = true;
  scope: string | null = 'mcp.user.addresses.read mcp.discovery.search.read mcp.discovery.details.read';
  private n = 0;
  fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/.well-known/openid-configuration')) {
      return Response.json({
        issuer: 'https://as.test/3p',
        authorization_endpoint: 'https://as.test/authorize',
        token_endpoint: 'https://as.test/token',
        pushed_authorization_request_endpoint: 'https://as.test/par',
      });
    }
    const body = new URLSearchParams(String(init?.body ?? ''));
    this.calls.push({ url, body });
    if (url === 'https://as.test/par') return Response.json({ request_uri: `urn:par:${body.get('state')}`, expires_in: 60 });
    if (url === 'https://as.test/token') {
      const mode = body.get('grant_type') === 'refresh_token' ? this.refreshMode : this.exchangeMode;
      if (mode === 'network') throw new TypeError('fetch failed');
      if (mode === 'server_error') return new Response('upstream', { status: 502 });
      if (mode === 'invalid_grant') return Response.json({ error: 'invalid_grant', error_description: 'revoked' }, { status: 400 });
      this.n++;
      return Response.json({
        access_token: `at-${this.n}-${body.get('grant_type')}`,
        ...(this.issueRefreshToken ? { refresh_token: `rt-${this.n}` } : {}),
        expires_in: this.expiresIn,
        ...(this.scope ? { scope: this.scope } : {}),
      });
    }
    return new Response('nf', { status: 404 });
  }) as typeof fetch;
  /** state enviado no último PAR. */
  lastState(): string {
    const par = [...this.calls].reverse().find((c) => c.url === 'https://as.test/par');
    return par!.body.get('state')!;
  }
  count(grant: string) {
    return this.calls.filter((c) => c.url === 'https://as.test/token' && c.body.get('grant_type') === grant).length;
  }
}

// ---------------- sessão MCP falsa por vínculo ----------------
export type McpFailure = 'none' | 'internal' | 'network' | 'http401' | 'http503';
export class FakeMcp {
  /** token usado em cada chamada (prova de isolamento). */
  used: { op: string; token: string }[] = [];
  failure: McpFailure = 'none';
  addresses: unknown[] = [ADDRESS];
  searchPages: unknown[] = [{ ...fx('searchOffers-pizza.json'), hasMore: false, nextPageToken: undefined }];
  sessions = 0;
  closed = 0;
  /** Resposta SINTÉTICA de getUser (formato observado: { success, data: { fullName, email, phone } }). */
  user: unknown = { success: true, data: { fullName: 'Maria Clara Souza', email: 'maria.souza@example.com', phone: '+5516999990000' } };
  userFailure: McpFailure = 'none';

  private async gate(auth: IfoodAuth, op: string) {
    const token = await auth.getAccessToken(); // exercita expiração/refresh do vínculo
    this.used.push({ op, token });
    if (this.failure === 'internal') throw new McpToolError(op, [{ message: 'An internal failure at an upstream service prevented the request from completing.', code: 'INTERNAL' }]);
    if (this.failure === 'network') throw new TypeError('fetch failed');
    if (this.failure === 'http401') throw Object.assign(new Error('Unauthorized'), { code: 401 });
    if (this.failure === 'http503') throw Object.assign(new Error('Service Unavailable'), { code: 503 });
  }

  factory = (auth: IfoodAuth): LinkMcpSession => {
    this.sessions++;
    let page = 0;
    const deps: EvaluateDeps = {
      listAddresses: async () => {
        await this.gate(auth, 'listAddresses');
        return { results: structuredClone(this.addresses) as never };
      },
      searchOffers: async (_args: SearchOffersArgs) => {
        await this.gate(auth, 'searchOffers');
        const p = this.searchPages[Math.min(page++, this.searchPages.length - 1)];
        return structuredClone(p);
      },
      getItem: async ({ itemId }) => {
        await this.gate(auth, 'getItem');
        const it = ITEMS.get(itemId);
        if (!it) throw new McpToolError('getItem', [{ message: 'item indisponível (sintético: sem fixture)' }]);
        return structuredClone(it);
      },
    };
    const getUser = async () => {
      await auth.getAccessToken();
      if (this.userFailure === 'internal') throw new McpToolError('getUser', [{ message: 'falha sintética', code: 'INTERNAL' }]);
      if (this.userFailure === 'network') throw new TypeError('fetch failed');
      return structuredClone(this.user);
    };
    return { deps, getUser, close: async () => void this.closed++ };
  };
}

export function testConfig(over: Partial<AppConfig> = {}): AppConfig {
  return {
    ...loadConfig({}),
    clientId: 'cid',
    clientSecret: 'secret',
    authServer: 'https://as.test',
    redirectUri: 'http://localhost:8000',
    botApiToken: BOT_TOKEN,
    allowedOrganizerIds: [ORG_A, ORG_B],
    linksDir: mkdtempSync(join(tmpdir(), 'links-')),
    tokenFile: join(mkdtempSync(join(tmpdir(), 'legacy-')), '.tokens.json'),
    publicBaseUrl: 'http://localhost:8000',
    devGlobalSession: false,
    ...over,
  };
}

export function setup(over: Partial<AppConfig> = {}) {
  const cfg = testConfig(over);
  const as = new FakeAs();
  const mcp = new FakeMcp();
  const clock = new Clock();
  const links = new IfoodLinkService({ cfg, sessionFactory: mcp.factory, fetchImpl: as.fetch, now: clock.now });
  return { cfg, as, mcp, clock, links };
}

/** Abre o link de início como um navegador (devolve o segredo do cookie). */
export async function openStart(env: ReturnType<typeof setup>, org: string) {
  const c = await env.links.connect(org);
  const u = new URL(c.authorizationUrl);
  const a = u.searchParams.get('a')!;
  const t = u.searchParams.get('t')!;
  const r = await env.links.startAuthorization(a, t, null);
  return { attemptId: c.attemptId, a, t, browserSecret: r.browserSecret, state: env.as.lastState() };
}

/** Fluxo completo até o callback; devolve o confirmationId que o bot leria no status. */
export async function authorize(env: ReturnType<typeof setup>, org: string) {
  const o = await openStart(env, org);
  const cb = await env.links.handleCallback({ state: o.state, code: `code-${org}`, browserSecret: o.browserSecret });
  const st = await env.links.status(org);
  return { ...o, identity: cb.identity, confirmationId: st.attempt!.confirmationId! };
}

export async function connectAndConfirm(env: ReturnType<typeof setup>, org: string) {
  const a = await authorize(env, org);
  return env.links.confirm(org, a.confirmationId);
}
