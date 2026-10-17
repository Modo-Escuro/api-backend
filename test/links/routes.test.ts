// Contrato HTTP bot→API (docs/bot-api.md) com AS e MCP falsos.
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/server/app';
import { IfoodAuth } from '../../src/server/auth';
import { ADDRESS, BOT_TOKEN, ORG_A, ORG_B, connectAndConfirm, setup } from '../helpers/fakes';

function mk(over: Parameters<typeof setup>[0] = {}) {
  const env = setup(over);
  const app = createApp(new IfoodAuth(env.cfg, env.as.fetch, { tokenFile: null }), { config: env.cfg, links: env.links });
  const call = (method: string, path: string, opts: { org?: string | null; token?: string | null; body?: unknown } = {}) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (opts.token !== null) headers.authorization = `Bearer ${opts.token ?? BOT_TOKEN}`;
    if (opts.org !== null) headers['x-telegram-user-id'] = opts.org ?? ORG_A;
    return app.request(path, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  };
  return { env, app, call };
}

describe('autenticação bot→API', () => {
  it.each([
    [{ token: null }, 401, 'BOT_AUTH_REQUIRED'],
    [{ token: 'x'.repeat(40) }, 401, 'BOT_AUTH_REQUIRED'],
    [{ org: null }, 400, 'ORGANIZER_REQUIRED'],
    [{ org: 'abc' }, 400, 'ORGANIZER_REQUIRED'],
    [{ org: '999999' }, 403, 'ORGANIZER_NOT_ALLOWED'],
  ] as [Record<string, string | null>, number, string][])('%j ⇒ %i %s', async (opts, status, kind) => {
    const { call } = mk();
    for (const [m, p] of [['GET', '/api/bot/ifood/status'], ['GET', '/api/addresses'], ['POST', '/api/evaluate']]) {
      const r = await call(m!, p!, { ...opts, body: m === 'POST' ? { query: 'pizza' } : undefined });
      expect(r.status).toBe(status);
      expect((await r.json()).error.kind).toBe(kind);
    }
  });

  it('sem BOT_API_TOKEN configurado ⇒ 503 (fail closed)', async () => {
    const { call } = mk({ botApiToken: undefined });
    expect((await call('GET', '/api/bot/ifood/status')).status).toBe(503);
  });
});

describe('sem vínculo confirmado, nenhuma operação iFood', () => {
  it('/api/addresses e /api/evaluate ⇒ 409 sem chamar o MCP', async () => {
    const { call, env } = mk();
    const a = await call('GET', '/api/addresses');
    expect(a.status).toBe(409);
    expect((await a.json()).error).toMatchObject({ kind: 'IFOOD_LINK_REQUIRED', state: 'DISCONNECTED' });
    expect((await call('POST', '/api/evaluate', { body: { query: 'pizza' } })).status).toBe(409);
    expect(env.mcp.used).toHaveLength(0);
  });

  it('identidade no corpo é rejeitada (não define organizador), com ou sem vínculo', async () => {
    const { call, env } = mk();
    const body = { query: 'pizza', telegramUserId: ORG_B };
    expect((await call('POST', '/api/evaluate', { body })).status).toBe(400);
    await connectAndConfirm(env, ORG_A);
    const r = await call('POST', '/api/evaluate', { body });
    expect(r.status).toBe(400);
    expect((await r.json()).error.kind).toBe('VALIDATION');
  });

  it('rotas da sessão global antiga não existem por padrão', async () => {
    const { app } = mk();
    expect((await app.request('/api/auth/login')).status).toBe(404);
    expect((await app.request('/api/auth/status')).status).toBe(404);
    expect((await app.request('/api/diagnostics/search')).status).toBe(404);
  });
});

describe('fluxo HTTP completo', () => {
  it('connect → navegador (start + callback) → confirm → operações', async () => {
    const { call, app, env } = mk();
    const c = await call('POST', '/api/bot/ifood/connect');
    expect(c.status).toBe(201);
    const cj = await c.json();
    expect(cj).toMatchObject({ state: 'AWAITING_AUTHORIZATION', attempt: { status: 'PENDING_AUTHORIZATION' } });
    const startUrl = new URL(cj.authorizationUrl);

    // Navegador: abre o link do bot (sem cabeçalhos do bot)
    const start = await app.request(startUrl.pathname + startUrl.search);
    expect(start.status).toBe(302);
    expect(start.headers.get('location')).toMatch(/^https:\/\/as\.test\/authorize\?/);

    // iFood redireciona para o redirect registrado (raiz)
    const state = env.as.lastState();
    const cb = await app.request(`/?state=${encodeURIComponent(state)}&code=oauth-code-xyz`);
    expect(cb.status).toBe(200);
    expect(cb.headers.get('cache-control')).toBe('no-store');
    expect(cb.headers.get('referrer-policy')).toBe('no-referrer');
    const html = await cb.text();
    expect(html).not.toMatch(/oauth-code-xyz|at-\d|rt-\d/);
    const verification = /<code>([A-Z0-9-]+)<\/code>/.exec(html)![1]!;

    // Antes de confirmar: nada liberado
    expect((await call('GET', '/api/addresses')).status).toBe(409);
    const pending = await (await call('GET', '/api/bot/ifood/status')).json();
    expect(pending).toMatchObject({ state: 'AWAITING_CONFIRMATION', account: null });

    // Replay do callback
    const replay = await app.request(`/?state=${encodeURIComponent(state)}&code=outra`);
    expect(replay.status).toBe(410);

    // Confirmação no Telegram
    const conf = await call('POST', '/api/bot/ifood/confirm', { body: { attemptId: cj.attempt.attemptId, verificationCode: verification } });
    expect(conf.status).toBe(200);
    const confJson = await conf.json();
    expect(confJson).toMatchObject({ state: 'CONNECTED', operational: true, purchaseAuthorized: false });
    expect(JSON.stringify(confJson)).not.toMatch(/at-\d|rt-\d|oauth-code/);

    // Operações
    const addr = await call('GET', '/api/addresses');
    expect(addr.status).toBe(200);
    expect((await addr.json()).addresses[0].addressId).toBe(ADDRESS.addressId);
    const ev = await call('POST', '/api/evaluate', { body: { query: 'pizza' } });
    expect(ev.status).toBe(200);
    expect((await ev.json()).summary.candidates).toBe(5);

    // Desconectar
    const del = await call('DELETE', '/api/bot/ifood/link');
    expect(await del.json()).toMatchObject({ state: 'DISCONNECTED', providerRevocation: 'NOT_ATTEMPTED' });
    expect((await call('GET', '/api/addresses')).status).toBe(409);
  });

  it('callback com state inválido ⇒ 400; link de início adulterado ⇒ 404', async () => {
    const { app } = mk();
    expect((await app.request('/?state=inventado&code=x')).status).toBe(400);
    expect((await app.request('/auth/ifood/start?a=x&t=y')).status).toBe(404);
  });
});

describe('acesso cruzado', () => {
  it('organizador B não vê, não confirma e não usa o vínculo de A', async () => {
    const { call, env } = mk();
    const r = await call('POST', '/api/bot/ifood/connect');
    const { attempt } = await r.json();
    const a = await connectAndConfirm(env, ORG_A); // A conecta (pela API de serviço)
    expect(a.status.state).toBe('CONNECTED');
    const sb = await (await call('GET', '/api/bot/ifood/status', { org: ORG_B })).json();
    expect(sb).toMatchObject({ state: 'DISCONNECTED', linkId: null });
    expect((await call('POST', '/api/bot/ifood/confirm', { org: ORG_B, body: { attemptId: attempt.attemptId, verificationCode: 'AAA-AAA' } })).status).toBe(404);
    expect((await call('GET', '/api/addresses', { org: ORG_B })).status).toBe(409);
    expect((await call('GET', '/api/addresses', { org: ORG_A })).status).toBe(200);
  });
});

describe('/api/evaluate com vínculo (erros preservados)', () => {
  it('vários endereços ⇒ 409; addressId fora da lista ⇒ 400; erro do iFood ⇒ 502 com mensagem', async () => {
    const { call, env } = mk();
    await connectAndConfirm(env, ORG_A);
    env.mcp.addresses = [ADDRESS, { ...ADDRESS, addressId: 'addr-test-2' }];
    expect((await call('POST', '/api/evaluate', { body: { query: 'pizza' } })).status).toBe(409);
    expect((await call('POST', '/api/evaluate', { body: { query: 'pizza', addressId: 'inexistente' } })).status).toBe(400);
    expect((await call('POST', '/api/evaluate', { body: { query: 'pizza', addressId: 'addr-test-2' } })).status).toBe(200);
    env.mcp.failure = 'internal';
    const r = await call('POST', '/api/evaluate', { body: { query: 'pizza', addressId: 'addr-test-2' } });
    expect(r.status).toBe(502);
    expect((await r.json()).error).toMatchObject({ kind: 'MCP_TOOL_ERROR', code: 'INTERNAL' });
    expect((await (await call('GET', '/api/bot/ifood/status')).json()).state).toBe('CONNECTED');
  });

  it.each([
    [{ query: '' }],
    [{ query: 'pizza', restrictions: [{ kind: 'ALLERGY', code: 'PEANUT', requirement: 'PREFERENCE' }] }],
    [{ query: 'pizza', refinements: { sort: 'RATING' } }],
  ] as [unknown][])('400 de validação %j (antes de qualquer chamada)', async (body) => {
    const { call, env } = mk();
    await connectAndConfirm(env, ORG_A);
    const before = env.mcp.used.length;
    expect((await call('POST', '/api/evaluate', { body })).status).toBe(400);
    expect(env.mcp.used.length).toBe(before);
  });
});
