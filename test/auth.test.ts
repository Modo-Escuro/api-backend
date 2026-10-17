import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { IfoodAuth, pkceChallenge } from '../src/server/auth';
import { loadConfig } from '../src/server/config';

const AS = 'https://as.test';
const md = {
  issuer: `${AS}/3p`,
  authorization_endpoint: `${AS}/authorize`,
  token_endpoint: `${AS}/token`,
  pushed_authorization_request_endpoint: `${AS}/par`,
};

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'auth-'));
  const cfg = {
    ...loadConfig({}),
    clientId: 'cid',
    clientSecret: 's3cr3t',
    redirectUri: 'http://localhost:8000',
    authServer: AS,
    tokenFile: join(dir, 'tokens.json'),
  };
  const calls: { url: string; body: URLSearchParams; auth: string | null }[] = [];
  let tokenCount = 0;
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/.well-known/openid-configuration')) return Response.json(md);
    const body = new URLSearchParams(String(init?.body ?? ''));
    calls.push({ url, body, auth: new Headers(init?.headers).get('authorization') });
    if (url === md.pushed_authorization_request_endpoint) return Response.json({ request_uri: 'urn:par:abc', expires_in: 60 });
    if (url === md.token_endpoint) {
      tokenCount++;
      return Response.json({ access_token: `at${tokenCount}`, refresh_token: `rt${tokenCount}`, expires_in: 3600, scope: 'mcp.discovery' });
    }
    return new Response('nf', { status: 404 });
  }) as typeof fetch;
  return { cfg, calls, auth: new IfoodAuth(cfg, fakeFetch) };
}

describe('PKCE', () => {
  it('S256 base64url sem padding', () => {
    const c = pkceChallenge('verifier-de-teste-com-tamanho-suficiente-1234567890');
    expect(c).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe('IfoodAuth', () => {
  it('login via PAR + callback + refresh', async () => {
    const { auth, calls, cfg } = setup();
    const url = new URL(await auth.startLogin());
    expect(url.origin + url.pathname).toBe(md.authorization_endpoint);
    expect(url.searchParams.get('request_uri')).toBe('urn:par:abc');
    expect(url.searchParams.get('client_id')).toBe('cid');

    const par = calls[0]!;
    expect(par.auth).toBe('Basic ' + Buffer.from('cid:s3cr3t').toString('base64'));
    expect(par.body.get('code_challenge_method')).toBe('S256');
    expect(par.body.get('redirect_uri')).toBe('http://localhost:8000');
    expect(par.body.get('resource')).toBe(cfg.mcpUrl);
    const state = par.body.get('state')!;

    await expect(auth.handleCallback('code1', 'estado-falso')).rejects.toThrow(/state/);
    await auth.handleCallback('code1', state);
    const tok = calls[1]!;
    expect(tok.body.get('grant_type')).toBe('authorization_code');
    expect(pkceChallenge(tok.body.get('code_verifier')!)).toBe(par.body.get('code_challenge'));
    expect(await auth.getAccessToken()).toBe('at1');

    // Token persistido com permissão restrita; status nunca expõe token.
    const stored = JSON.parse(readFileSync(cfg.tokenFile, 'utf8'));
    expect(stored.refreshToken).toBe('rt1');
    const status = await auth.status();
    expect(JSON.stringify(status)).not.toMatch(/at1|rt1/);
    expect(status.authenticated).toBe(true);

    // Expirado → refresh automático.
    writeFileSync(cfg.tokenFile, JSON.stringify({ ...stored, expiresAt: Date.now() - 1000 }));
    const fresh = new IfoodAuth(cfg, (auth as unknown as { fetchFn: typeof fetch }).fetchFn);
    expect(await fresh.getAccessToken()).toBe('at2');
  });

  it('sem token → LOGIN_REQUIRED', async () => {
    const { auth } = setup();
    await expect(auth.getAccessToken()).rejects.toMatchObject({ code: 'LOGIN_REQUIRED' });
  });

  it('ignora .tokens.json de outro clientId', async () => {
    const { cfg } = setup();
    writeFileSync(cfg.tokenFile, JSON.stringify({ clientId: 'outro', accessToken: 'x', refreshToken: null, expiresAt: null }));
    const a = new IfoodAuth(cfg, fetch);
    expect((await a.status()).authenticated).toBe(false);
  });

  it('callback do login de desenvolvimento rejeita tentativa expirada e state repetido', async () => {
    const { cfg, calls } = setup();
    let t = 1_000_000;
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/.well-known/openid-configuration')) return Response.json(md);
      calls.push({ url, body: new URLSearchParams(String(init?.body ?? '')), auth: null });
      if (url === md.pushed_authorization_request_endpoint) return Response.json({ request_uri: 'urn:par:x' });
      return Response.json({ access_token: 'at', expires_in: 3600 });
    }) as typeof fetch;
    const a = new IfoodAuth(cfg, fakeFetch, { now: () => t });
    await a.startLogin();
    const state = calls.at(-1)!.body.get('state')!;
    t += 11 * 60_000;
    await expect(a.handleCallback('c', state)).rejects.toMatchObject({ code: 'ATTEMPT_EXPIRED' });
    await expect(a.handleCallback('c', state)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(calls.some((c) => c.url === md.token_endpoint)).toBe(false);
  });

  it('falha de rede no AS vira PROVIDER_UNREACHABLE (não logout)', async () => {
    const { cfg } = setup();
    const a = new IfoodAuth(cfg, (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch, { tokenFile: null });
    await a.setTokens({ clientId: 'cid', accessToken: 'x', refreshToken: 'r', expiresAt: 1, scope: null, source: 't', obtainedAt: 0 });
    await expect(a.getAccessToken()).rejects.toMatchObject({ code: 'PROVIDER_UNREACHABLE' });
    expect((await a.tokenInfo()).present).toBe(true);
  });
});
