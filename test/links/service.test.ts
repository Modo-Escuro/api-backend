import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { IfoodLinkService, LinkError } from '../../src/server/links/service';
import { ORG_A, ORG_B, authorize, connectAndConfirm, openStart, setup } from '../helpers/fakes';

const code = (p: Promise<unknown>) => p.then(() => 'OK', (e: LinkError) => e.code);
const noSecrets = (o: unknown) => {
  const s = JSON.stringify(o);
  expect(s).not.toMatch(/at-\d|rt-\d|code-\d|secret|accessToken|refreshToken/);
};

describe('tentativa OAuth', () => {
  it('connect cria tentativa ligada ao organizador; link aponta para o backend, sem segredos', async () => {
    const env = setup();
    const r = await env.links.connect(ORG_A);
    expect(r.status.state).toBe('AWAITING_AUTHORIZATION');
    expect(r.status.attempt).toMatchObject({ confirmationId: null, accountIdentity: null, browserClaimed: false });
    expect(r.authorizationUrl).toMatch(/^http:\/\/localhost:8000\/auth\/ifood\/start\?a=.+&t=.+/);
    expect(r.status.allowedOperations).toEqual([]);
    noSecrets(r);
  });

  it('start com token errado ⇒ 404; PAR com state/PKCE S256 e redirect registrado', async () => {
    const env = setup();
    const r = await env.links.connect(ORG_A);
    const u = new URL(r.authorizationUrl);
    expect(await code(env.links.startAuthorization(u.searchParams.get('a')!, 'errado'))).toBe('ATTEMPT_NOT_FOUND');
    const out = await env.links.startAuthorization(u.searchParams.get('a')!, u.searchParams.get('t')!);
    expect(out.url).toMatch(/^https:\/\/as\.test\/authorize\?client_id=cid&request_uri=urn%3Apar%3A/);
    expect(out.browserSecret.length).toBeGreaterThanOrEqual(40);
    const par = env.as.calls.find((c) => c.url === 'https://as.test/par')!.body;
    expect(par.get('code_challenge_method')).toBe('S256');
    expect(par.get('redirect_uri')).toBe('http://localhost:8000');
    expect(par.get('state')!.length).toBeGreaterThanOrEqual(40);
    expect((await env.links.status(ORG_A)).attempt!.browserClaimed).toBe(true);
  });

  it('callback: state inválido, repetido e expirado são rejeitados', async () => {
    const env = setup();
    expect(await code(env.links.handleCallback({ state: 'inventado', code: 'x' }))).toBe('INVALID_STATE');
    const a = await authorize(env, ORG_A);
    expect(await code(env.links.handleCallback({ state: a.state, code: 'de-novo', browserSecret: a.browserSecret }))).toBe('ATTEMPT_USED');

    const env2 = setup();
    const o = await openStart(env2, ORG_A);
    env2.clock.advance(11 * 60_000);
    expect(await code(env2.links.handleCallback({ state: o.state, code: 'x', browserSecret: o.browserSecret }))).toBe('ATTEMPT_EXPIRED');
    expect((await env2.links.status(ORG_A)).reason).toBe('ATTEMPT_EXPIRED');
    expect(env2.as.count('authorization_code')).toBe(0);
  });

  it('callbacks concorrentes com o mesmo state: só um troca o código', async () => {
    const env = setup();
    const o = await openStart(env, ORG_A);
    const results = await Promise.all([1, 2, 3].map((i) => code(env.links.handleCallback({ state: o.state, code: `c${i}`, browserSecret: o.browserSecret }))));
    expect(results.filter((x) => x === 'OK')).toHaveLength(1);
    expect(results.filter((x) => x === 'ATTEMPT_USED')).toHaveLength(2);
    expect(env.as.count('authorization_code')).toBe(1);
  });

  it('nova tentativa substitui a anterior (link antigo deixa de valer)', async () => {
    const env = setup();
    const first = await env.links.connect(ORG_A);
    const u1 = new URL(first.authorizationUrl);
    await env.links.connect(ORG_A);
    expect(await code(env.links.startAuthorization(u1.searchParams.get('a')!, u1.searchParams.get('t')!))).toBe('ATTEMPT_USED');
  });

  it('autorização negada no iFood ⇒ tentativa falha, sem tokens', async () => {
    const env = setup();
    const o = await openStart(env, ORG_A);
    expect(await code(env.links.handleCallback({ state: o.state, error: 'access_denied', browserSecret: o.browserSecret }))).toBe('AUTHORIZATION_DENIED');
    expect(await env.links.status(ORG_A)).toMatchObject({ state: 'DISCONNECTED', reason: 'AUTHORIZATION_DENIED' });
  });

  it('falha do iFood na troca do código ⇒ tentativa falha (503 para indisponível), nada vinculado', async () => {
    for (const [mode, http] of [['server_error', 503], ['invalid_grant', 400]] as const) {
      const env = setup();
      env.as.exchangeMode = mode;
      const o = await openStart(env, ORG_A);
      const err = await env.links.handleCallback({ state: o.state, code: 'c', browserSecret: o.browserSecret }).catch((e: LinkError) => e);
      expect(err).toMatchObject({ code: 'CODE_EXCHANGE_FAILED', httpStatus: http });
      expect((await env.links.status(ORG_A)).state).toBe('DISCONNECTED');
    }
  });
});

describe('link encaminhado: navegador vinculado', () => {
  it('outro navegador (sem o cookie) não abre o link já reivindicado', async () => {
    const env = setup();
    const o = await openStart(env, ORG_A);
    expect(await code(env.links.startAuthorization(o.a, o.t, null))).toBe('BROWSER_MISMATCH');
    expect(await code(env.links.startAuthorization(o.a, o.t, 'outro-segredo'))).toBe('BROWSER_MISMATCH');
    expect(await code(env.links.startAuthorization(o.a, o.t, o.browserSecret))).toBe('OK'); // recarregar no mesmo navegador
  });

  it('callback sem o cookie do navegador é rejeitado SEM consumir a tentativa', async () => {
    const env = setup();
    const o = await openStart(env, ORG_A);
    expect(await code(env.links.handleCallback({ state: o.state, code: 'c', browserSecret: null }))).toBe('BROWSER_MISMATCH');
    expect(await code(env.links.handleCallback({ state: o.state, code: 'c', browserSecret: 'x' }))).toBe('BROWSER_MISMATCH');
    expect(env.as.count('authorization_code')).toBe(0);
    expect(await code(env.links.handleCallback({ state: o.state, code: 'c', browserSecret: o.browserSecret }))).toBe('OK');
  });
});

describe('confirmação por botão no Telegram', () => {
  it('após o callback: aguardando confirmação com identidade mascarada; nenhuma operação liberada', async () => {
    const env = setup();
    const a = await authorize(env, ORG_A);
    const s = await env.links.status(ORG_A);
    expect(s).toMatchObject({
      state: 'AWAITING_CONFIRMATION',
      linkId: null,
      account: null,
      allowedOperations: [],
      operational: false,
      nextActions: ['CONFIRM_CONNECTION', 'CANCEL'],
      attempt: {
        status: 'PENDING_CONFIRMATION',
        confirmationId: a.confirmationId,
        accountIdentity: { status: 'VERIFIED', displayName: 'Maria S.', emailMasked: 'm***@example.com', source: 'getUser' },
      },
    });
    expect(JSON.stringify(s)).not.toMatch(/Clara|Souza|maria\.souza|99999/); // nome completo, e-mail e telefone nunca saem
    expect(a.confirmationId).not.toBe(a.attemptId);
    expect(await code(env.links.withOperational(ORG_A, 'ADDRESSES_READ', async () => 1))).toBe('IFOOD_LINK_REQUIRED');
    expect(env.mcp.used).toHaveLength(0);
  });

  it('confirmar ⇒ CONNECTED operacional após leitura autenticada real; identidade fica no vínculo', async () => {
    const env = setup();
    const r = await connectAndConfirm(env, ORG_A);
    expect(r.status).toMatchObject({
      state: 'CONNECTED',
      operational: true,
      verification: { status: 'OK' },
      allowedOperations: ['ADDRESSES_READ', 'OFFERS_EVALUATE'],
      scopeEvidence: 'TOKEN_SCOPES',
      account: { identity: { displayName: 'Maria S.' }, addressCount: 1 },
      purchaseAuthorized: false,
      attempt: null,
    });
    expect(r.previousLinkId).toBeNull();
    expect(env.mcp.used.map((u) => u.op)).toEqual(['listAddresses']);
    noSecrets(r);
  });

  it('identidade indisponível (getUser falha) não bloqueia, mas é explicitada', async () => {
    const env = setup();
    env.mcp.userFailure = 'internal';
    const a = await authorize(env, ORG_A);
    expect(a.identity).toMatchObject({ status: 'UNAVAILABLE', displayName: null, emailMasked: null });
    expect((await env.links.confirm(ORG_A, a.confirmationId)).status.state).toBe('CONNECTED');
  });

  it('getUser sem nome/e-mail ⇒ NOT_PROVIDED (não inventa identidade)', async () => {
    const env = setup();
    env.mcp.user = { success: true, data: {} };
    expect((await authorize(env, ORG_A)).identity).toMatchObject({ status: 'NOT_PROVIDED', displayName: null });
  });

  it('outro organizador não confirma (404, sem oráculo); confirmationId inventado ⇒ 404', async () => {
    const env = setup();
    const a = await authorize(env, ORG_A);
    expect(await code(env.links.confirm(ORG_B, a.confirmationId))).toBe('CONFIRMATION_NOT_FOUND');
    expect(await code(env.links.confirm(ORG_A, 'inventado-inventado'))).toBe('CONFIRMATION_NOT_FOUND');
    expect(await code(env.links.confirm(ORG_A, a.attemptId))).toBe('CONFIRMATION_NOT_FOUND'); // attemptId não serve
    expect((await env.links.status(ORG_B)).state).toBe('DISCONNECTED');
    expect((await env.links.status(ORG_A)).state).toBe('AWAITING_CONFIRMATION');
  });

  it('antes do callback não existe confirmationId ("já entrei" não comprova login)', async () => {
    const env = setup();
    await openStart(env, ORG_A);
    expect((await env.links.status(ORG_A)).attempt).toMatchObject({ status: 'PENDING_AUTHORIZATION', confirmationId: null });
  });

  it('confirmação expirada (10 min após o callback)', async () => {
    const env = setup();
    const a = await authorize(env, ORG_A);
    env.clock.advance(11 * 60_000);
    expect(await code(env.links.confirm(ORG_A, a.confirmationId))).toBe('CONFIRMATION_EXPIRED');
    expect(await env.links.status(ORG_A)).toMatchObject({ state: 'DISCONNECTED', reason: 'CONFIRMATION_EXPIRED', linkId: null });
  });

  it('confirmação repetida (clique duplicado) é rejeitada sem criar novo vínculo', async () => {
    const env = setup();
    const a = await authorize(env, ORG_A);
    const first = await env.links.confirm(ORG_A, a.confirmationId);
    const err = await env.links.confirm(ORG_A, a.confirmationId).catch((e: LinkError) => e);
    expect(err).toMatchObject({ code: 'ALREADY_CONFIRMED', httpStatus: 410, state: 'CONNECTED' });
    expect((await env.links.status(ORG_A)).linkId).toBe(first.status.linkId);
  });

  it('confirmações concorrentes: uma vence, a outra é rejeitada', async () => {
    const env = setup();
    const a = await authorize(env, ORG_A);
    const res = await Promise.all([code(env.links.confirm(ORG_A, a.confirmationId)), code(env.links.confirm(ORG_A, a.confirmationId))]);
    expect(res.sort()).toEqual(['ALREADY_CONFIRMED', 'OK']);
  });

  it('confirmationId de tentativa substituída não vale', async () => {
    const env = setup();
    const a = await authorize(env, ORG_A);
    await env.links.connect(ORG_A); // nova tentativa
    expect(await code(env.links.confirm(ORG_A, a.confirmationId))).toBe('CONFIRMATION_INVALID');
  });
});

describe('sessão operacional, renovação e falhas', () => {
  it('token expirado + refresh aceito ⇒ operação segue; requisições concorrentes renovam uma vez', async () => {
    const env = setup();
    await connectAndConfirm(env, ORG_A);
    env.clock.advance(2 * 3600_000);
    const out = await Promise.all([1, 2, 3].map(() => env.links.withOperational(ORG_A, 'ADDRESSES_READ', (ctx) => ctx.deps.listAddresses())));
    expect(out).toHaveLength(3);
    expect(env.as.count('refresh_token')).toBe(1);
    expect((await env.links.status(ORG_A)).state).toBe('CONNECTED');
  });

  it('refresh recusado (invalid_grant) ⇒ RECONNECT_REQUIRED, persiste após reinício', async () => {
    const env = setup();
    await connectAndConfirm(env, ORG_A);
    env.clock.advance(2 * 3600_000);
    env.as.refreshMode = 'invalid_grant';
    expect(await code(env.links.withOperational(ORG_A, 'ADDRESSES_READ', (ctx) => ctx.deps.listAddresses()))).toBe('IFOOD_RECONNECT_REQUIRED');
    const s = await env.links.status(ORG_A);
    expect(s).toMatchObject({ state: 'RECONNECT_REQUIRED', reason: 'REFRESH_REJECTED', allowedOperations: [] });
    expect(s.nextActions).toContain('CONNECT');

    const restarted = new IfoodLinkService({ cfg: env.cfg, sessionFactory: env.mcp.factory, fetchImpl: env.as.fetch, now: env.clock.now });
    expect(await restarted.status(ORG_A)).toMatchObject({ state: 'RECONNECT_REQUIRED', reason: 'REFRESH_REJECTED' });
  });

  it('falha temporária do provedor (AS 5xx / rede) ⇒ UNAVAILABLE, tokens mantidos, recupera depois', async () => {
    for (const mode of ['server_error', 'network'] as const) {
      const env = setup();
      const { status } = await connectAndConfirm(env, ORG_A);
      env.clock.advance(2 * 3600_000);
      env.as.refreshMode = mode;
      expect(await code(env.links.withOperational(ORG_A, 'ADDRESSES_READ', (ctx) => ctx.deps.listAddresses()))).toBe('IFOOD_UNAVAILABLE');
      expect(await env.links.status(ORG_A)).toMatchObject({ state: 'UNAVAILABLE', linkId: status.linkId, operational: false });
      expect(readdirSync(env.cfg.linksDir).some((f) => f.endsWith('.tokens.json'))).toBe(true);
      env.as.refreshMode = 'ok';
      expect(await env.links.verify(ORG_A)).toMatchObject({ state: 'CONNECTED', operational: true, linkId: status.linkId });
    }
  });

  it('erro interno do iFood na verificação ⇒ UNAVAILABLE (não é logout)', async () => {
    const env = setup();
    env.mcp.failure = 'internal';
    const r = await connectAndConfirm(env, ORG_A);
    expect(r.status).toMatchObject({ state: 'UNAVAILABLE', reason: 'PROVIDER_ERROR', operational: false, allowedOperations: [] });
    env.mcp.failure = 'none';
    expect((await env.links.verify(ORG_A)).state).toBe('CONNECTED');
  });

  it('401 do MCP após refresh ⇒ TOKEN_REJECTED ⇒ reconectar', async () => {
    const env = setup();
    await connectAndConfirm(env, ORG_A);
    env.mcp.failure = 'http401';
    expect(await code(env.links.withOperational(ORG_A, 'OFFERS_EVALUATE', (ctx) => ctx.deps.searchOffers({} as never, {})))).toBe('IFOOD_RECONNECT_REQUIRED');
    expect(await env.links.status(ORG_A)).toMatchObject({ state: 'RECONNECT_REQUIRED', reason: 'TOKEN_REJECTED' });
  });

  it('erro de tool durante operação não muda o vínculo', async () => {
    const env = setup();
    await connectAndConfirm(env, ORG_A);
    env.mcp.failure = 'internal';
    await expect(env.links.withOperational(ORG_A, 'OFFERS_EVALUATE', (ctx) => ctx.deps.searchOffers({} as never, {}))).rejects.toThrow(/internal failure/);
    expect((await env.links.status(ORG_A)).state).toBe('CONNECTED');
  });

  it('zero endereços é sessão válida (≠ falha de autenticação)', async () => {
    const env = setup();
    env.mcp.addresses = [];
    const r = await connectAndConfirm(env, ORG_A);
    expect(r.status).toMatchObject({ state: 'CONNECTED', operational: true, account: { addressCount: 0 } });
  });

  it('token vencido com refresh: status não afirma operacional até renovar', async () => {
    const env = setup();
    await connectAndConfirm(env, ORG_A);
    env.clock.advance(2 * 3600_000);
    expect(await env.links.status(ORG_A)).toMatchObject({ state: 'CONNECTED', operational: false, reason: 'TOKEN_REFRESH_PENDING', allowedOperations: [] });
    expect(await env.links.verify(ORG_A)).toMatchObject({ state: 'CONNECTED', operational: true });
    expect(env.as.count('refresh_token')).toBe(1);
  });

  it('token vencido sem refresh_token ⇒ RECONNECT_REQUIRED/TOKEN_EXPIRED sem chamar o iFood', async () => {
    const env = setup();
    env.as.issueRefreshToken = false;
    await connectAndConfirm(env, ORG_A);
    env.clock.advance(2 * 3600_000);
    expect(await env.links.status(ORG_A)).toMatchObject({ state: 'RECONNECT_REQUIRED', reason: 'TOKEN_EXPIRED' });
    const before = env.mcp.used.length;
    expect(await code(env.links.withOperational(ORG_A, 'ADDRESSES_READ', (ctx) => ctx.deps.listAddresses()))).toBe('IFOOD_RECONNECT_REQUIRED');
    expect(env.mcp.used.length).toBe(before);
  });

  it('escopo ausente no token bloqueia a operação correspondente', async () => {
    const env = setup();
    env.as.scope = 'mcp.user.addresses.read';
    const r = await connectAndConfirm(env, ORG_A);
    expect(r.status.allowedOperations).toEqual(['ADDRESSES_READ']);
    expect(r.status.missingScopes).toEqual(['mcp.discovery.search.read', 'mcp.discovery.details.read']);
    expect(await code(env.links.withOperational(ORG_A, 'OFFERS_EVALUATE', async () => 1))).toBe('IFOOD_SCOPE_MISSING');
  });
});

describe('isolamento e ciclo de vida', () => {
  it('dois organizadores: tokens, sessões e caches separados', async () => {
    const env = setup();
    await connectAndConfirm(env, ORG_A);
    await connectAndConfirm(env, ORG_B);
    const tokA = new Set<string>();
    const tokB = new Set<string>();
    let cacheA: unknown, cacheB: unknown;
    await env.links.withOperational(ORG_A, 'ADDRESSES_READ', async (ctx) => {
      cacheA = ctx.cache;
      await ctx.deps.listAddresses();
      tokA.add(env.mcp.used.at(-1)!.token);
    });
    await env.links.withOperational(ORG_B, 'ADDRESSES_READ', async (ctx) => {
      cacheB = ctx.cache;
      await ctx.deps.listAddresses();
      tokB.add(env.mcp.used.at(-1)!.token);
    });
    expect([...tokA][0]).not.toBe([...tokB][0]);
    expect(cacheA).not.toBe(cacheB);
    expect(env.mcp.sessions).toBe(4); // 2 sessões de vínculo + 2 sessões descartáveis de identidade (getUser)
    await env.links.disconnect(ORG_A);
    expect((await env.links.status(ORG_A)).state).toBe('DISCONNECTED');
    expect((await env.links.status(ORG_B)).state).toBe('CONNECTED');
  });

  it('troca de conta: nova confirmação substitui o vínculo e apaga tokens antigos', async () => {
    const env = setup();
    const first = await connectAndConfirm(env, ORG_A);
    const second = await connectAndConfirm(env, ORG_A);
    expect(second.previousLinkId).toBe(first.status.linkId);
    expect(second.status.linkId).not.toBe(first.status.linkId);
    expect(existsSync(join(env.cfg.linksDir, `${first.status.linkId}.tokens.json`))).toBe(false);
    expect(env.mcp.closed).toBe(3); // 2 identidades (descartáveis) + sessão do vínculo anterior
  });

  it('desconectar remove vínculo e tokens locais; não alega revogação no provedor', async () => {
    const env = setup();
    const { status } = await connectAndConfirm(env, ORG_A);
    const r = await env.links.disconnect(ORG_A);
    expect(r).toMatchObject({ providerRevocation: 'NOT_ATTEMPTED', status: { state: 'DISCONNECTED', reason: 'DISCONNECTED_BY_USER', linkId: null } });
    expect(existsSync(join(env.cfg.linksDir, `${status.linkId}.tokens.json`))).toBe(false);
  });

  it('reinício: vínculo carregado do disco não é operacional até nova leitura autenticada', async () => {
    const env = setup();
    await connectAndConfirm(env, ORG_A);
    const restarted = new IfoodLinkService({ cfg: env.cfg, sessionFactory: env.mcp.factory, fetchImpl: env.as.fetch, now: env.clock.now });
    const s = await restarted.status(ORG_A);
    expect(s).toMatchObject({ state: 'CONNECTED', operational: false, reason: 'VERIFICATION_PENDING', allowedOperations: [] });
    await restarted.withOperational(ORG_A, 'ADDRESSES_READ', (ctx) => ctx.deps.listAddresses()); // verifica antes
    expect((await restarted.status(ORG_A)).operational).toBe(true);
  });

  it('sessão global antiga (.tokens.json) nunca vira vínculo', async () => {
    const env = setup();
    writeFileSync(join(env.cfg.linksDir, '.tokens.json'), JSON.stringify({ clientId: 'cid', accessToken: 'legacy', refreshToken: 'legacy-rt', expiresAt: null, scope: null }));
    expect(await env.links.status(ORG_A)).toMatchObject({ state: 'DISCONNECTED', reason: 'NEVER_CONNECTED' });
    expect(await code(env.links.withOperational(ORG_A, 'ADDRESSES_READ', async () => 1))).toBe('IFOOD_LINK_REQUIRED');
  });

  it('organizador removido da allowlist não tem vínculo carregado', async () => {
    const env = setup();
    await connectAndConfirm(env, ORG_A);
    const restricted = new IfoodLinkService({ cfg: { ...env.cfg, allowedOrganizerIds: [ORG_B] }, sessionFactory: env.mcp.factory, fetchImpl: env.as.fetch, now: env.clock.now });
    expect((await restricted.status(ORG_A)).state).toBe('DISCONNECTED');
  });
});

describe('classificação de falhas', () => {
  it('erro de entrada durante operação não marca o vínculo como indisponível', async () => {
    const env = setup();
    await connectAndConfirm(env, ORG_A);
    await expect(env.links.withOperational(ORG_A, 'OFFERS_EVALUATE', async () => { throw new Error('entrada inválida'); })).rejects.toThrow('entrada inválida');
    expect((await env.links.status(ORG_A)).state).toBe('CONNECTED');
  });

  it('erro de rede/5xx do MCP durante operação ⇒ UNAVAILABLE (não logout)', async () => {
    for (const f of ['network', 'http503'] as const) {
      const env = setup();
      const { status } = await connectAndConfirm(env, ORG_A);
      env.mcp.failure = f;
      expect(await code(env.links.withOperational(ORG_A, 'ADDRESSES_READ', (ctx) => ctx.deps.listAddresses()))).toBe('IFOOD_UNAVAILABLE');
      expect(await env.links.status(ORG_A)).toMatchObject({ state: 'UNAVAILABLE', linkId: status.linkId });
      env.mcp.failure = 'none';
      await env.links.withOperational(ORG_A, 'ADDRESSES_READ', (ctx) => ctx.deps.listAddresses()); // re-verifica e segue
      expect((await env.links.status(ORG_A)).state).toBe('CONNECTED');
    }
  });
});
