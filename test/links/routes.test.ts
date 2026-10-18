// Contrato HTTP bot→API (docs/bot-api.md) com AS e MCP falsos.
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/server/app';
import { IfoodAuth } from '../../src/server/auth';
import { ADDRESS, BOT_TOKEN, ORG_A, ORG_B, authorize, connectAndConfirm, fx, setup } from '../helpers/fakes';

function mk(over: Parameters<typeof setup>[0] = {}) {
  const env = setup(over);
  const app = createApp(new IfoodAuth(env.cfg, env.as.fetch, { tokenFile: null }), { config: env.cfg, links: env.links });
  const call = (method: string, path: string, opts: { org?: string | null; token?: string | null; body?: unknown } = {}) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (opts.token !== null) headers.authorization = `Bearer ${opts.token ?? BOT_TOKEN}`;
    if (opts.org !== null) headers['x-telegram-user-id'] = opts.org ?? ORG_A;
    return app.request(path, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  };
  const LOCAL = { incoming: { socket: { remoteAddress: '127.0.0.1' } } };
  /** Navegador na máquina do backend (ou em outro IP), com cookies. */
  const browser = (path: string, cookie?: string, remoteAddress = '127.0.0.1') =>
    app.request(path, { headers: cookie ? { cookie } : {} }, remoteAddress === '127.0.0.1' ? LOCAL : { incoming: { socket: { remoteAddress } } });
  return { env, app, call, browser };
}

const cookieOf = (r: Response) => r.headers.get('set-cookie')!.split(';')[0]!;

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
  it('connect → navegador (start + callback) → botão confirmar → operações', async () => {
    const { call, browser, env } = mk();
    const c = await call('POST', '/api/bot/ifood/connect');
    expect(c.status).toBe(201);
    const cj = await c.json();
    expect(cj).toMatchObject({ state: 'AWAITING_AUTHORIZATION', attempt: { status: 'PENDING_AUTHORIZATION', confirmationId: null } });
    const startUrl = new URL(cj.authorizationUrl);

    // Navegador abre o link do bot: reivindica a tentativa com cookie HttpOnly
    const start = await browser(startUrl.pathname + startUrl.search);
    expect(start.status).toBe(302);
    expect(start.headers.get('location')).toMatch(/^https:\/\/as\.test\/authorize\?/);
    expect(start.headers.get('set-cookie')).toMatch(/HttpOnly/i);
    expect(start.headers.get('set-cookie')).toMatch(/SameSite=Lax/i);
    const cookie = cookieOf(start);

    // iFood redireciona para o redirect registrado (raiz), no mesmo navegador
    const state = env.as.lastState();
    const cb = await browser(`/?state=${encodeURIComponent(state)}&code=oauth-code-xyz`, cookie);
    expect(cb.status).toBe(200);
    expect(cb.headers.get('cache-control')).toBe('no-store');
    expect(cb.headers.get('referrer-policy')).toBe('no-referrer');
    const html = await cb.text();
    expect(html).toContain('Maria S.');
    expect(html).toContain('Confirmar conexão');
    expect(html).not.toMatch(/oauth-code-xyz|at-\d|rt-\d|Souza|99999/);

    // Antes de confirmar: nada liberado; status traz confirmationId e identidade mascarada
    expect((await call('GET', '/api/addresses')).status).toBe(409);
    const pending = await (await call('GET', '/api/bot/ifood/status')).json();
    expect(pending).toMatchObject({
      state: 'AWAITING_CONFIRMATION',
      account: null,
      attempt: { status: 'PENDING_CONFIRMATION', accountIdentity: { displayName: 'Maria S.', emailMasked: 'm***@example.com' } },
    });
    const confirmationId: string = pending.attempt.confirmationId;
    expect(confirmationId.length).toBeLessThanOrEqual(64); // cabe em callback_data do Telegram

    // Replay do callback
    expect((await browser(`/?state=${encodeURIComponent(state)}&code=outra`, cookie)).status).toBe(410);

    // Botão "Confirmar conexão"
    const conf = await call('POST', '/api/bot/ifood/confirm', { body: { confirmationId } });
    expect(conf.status).toBe(200);
    const confJson = await conf.json();
    expect(confJson).toMatchObject({ state: 'CONNECTED', operational: true, purchaseAuthorized: false, account: { identity: { displayName: 'Maria S.' } } });
    expect(JSON.stringify(confJson)).not.toMatch(/at-\d|rt-\d|oauth-code/);

    // Clique repetido
    const again = await call('POST', '/api/bot/ifood/confirm', { body: { confirmationId } });
    expect(again.status).toBe(410);
    expect((await again.json()).error).toMatchObject({ kind: 'ALREADY_CONFIRMED', state: 'CONNECTED' });

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

  it('confirm exige confirmationId (attemptId ou código não servem)', async () => {
    const { call, env } = mk();
    const a = await authorize(env, ORG_A);
    expect((await call('POST', '/api/bot/ifood/confirm', { body: { attemptId: a.attemptId } })).status).toBe(400);
    expect((await call('POST', '/api/bot/ifood/confirm', { body: { confirmationId: a.attemptId } })).status).toBe(404);
    expect((await call('POST', '/api/bot/ifood/confirm', { body: { confirmationId: a.confirmationId, verificationCode: 'X' } })).status).toBe(400);
  });

  it('callback com state inválido ⇒ 400; link de início adulterado ⇒ 404', async () => {
    const { browser } = mk();
    expect((await browser('/?state=inventado&code=x')).status).toBe(400);
    expect((await browser('/auth/ifood/start?a=x&t=y')).status).toBe(404);
  });
});

describe('link encaminhado', () => {
  it('início e callback só aceitam conexões da própria máquina (callback localhost)', async () => {
    const { call, browser, app } = mk();
    const cj = await (await call('POST', '/api/bot/ifood/connect')).json();
    const u = new URL(cj.authorizationUrl);
    expect((await browser(u.pathname + u.search, undefined, '192.168.0.50')).status).toBe(403);
    expect((await app.request(u.pathname + u.search)).status).toBe(403); // endereço desconhecido ⇒ fecha
    expect((await browser('/?state=x&code=y', undefined, '10.0.0.7')).status).toBe(403);
    expect((await browser(u.pathname + u.search)).status).toBe(302);
  });

  it('segundo navegador não usa o link já aberto; callback em outro navegador não conclui', async () => {
    const { call, browser, env } = mk();
    const cj = await (await call('POST', '/api/bot/ifood/connect')).json();
    const u = new URL(cj.authorizationUrl);
    const first = await browser(u.pathname + u.search);
    const cookie = cookieOf(first);
    expect((await browser(u.pathname + u.search)).status).toBe(409); // outro navegador (sem cookie)
    const state = env.as.lastState();
    expect((await browser(`/?state=${encodeURIComponent(state)}&code=c`)).status).toBe(409); // sem cookie
    expect((await browser(`/?state=${encodeURIComponent(state)}&code=c`, cookie)).status).toBe(200);
  });

  it('PUBLIC_BASE_URL público desativa a exigência de loopback (documentado como risco)', async () => {
    const { call, browser } = mk({ publicBaseUrl: 'https://demo.example.com' });
    const cj = await (await call('POST', '/api/bot/ifood/connect')).json();
    const u = new URL(cj.authorizationUrl);
    expect((await browser(u.pathname + u.search, undefined, '203.0.113.9')).status).toBe(302);
  });
});

describe('acesso cruzado', () => {
  it('organizador B não vê, não confirma e não usa o vínculo de A', async () => {
    const { call, env } = mk();
    const a = await connectAndConfirm(env, ORG_A); // A conecta (pela API de serviço)
    expect(a.status.state).toBe('CONNECTED');
    const sb = await (await call('GET', '/api/bot/ifood/status', { org: ORG_B })).json();
    expect(sb).toMatchObject({ state: 'DISCONNECTED', linkId: null });
    const pendingA = await authorize(env, ORG_A); // nova tentativa de A aguardando confirmação
    expect((await call('POST', '/api/bot/ifood/confirm', { org: ORG_B, body: { confirmationId: pendingA.confirmationId } })).status).toBe(404);
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
    [{ query: 'pizza', budget: { maxItemPrice: 100 } }], // decimal não é aceito: contrato em centavos
    [{ query: 'pizza', budget: { maxItemPriceCents: 99.5 } }],
  ] as [unknown][])('400 de validação %j (antes de qualquer chamada)', async (body) => {
    const { call, env } = mk();
    await connectAndConfirm(env, ORG_A);
    const before = env.mcp.used.length;
    expect((await call('POST', '/api/evaluate', { body })).status).toBe(400);
    expect(env.mcp.used.length).toBe(before);
  });
});

describe('/api/evaluate em centavos (contrato do bot)', () => {
  it('orçamento em centavos é convertido; preços saem em centavos inteiros com sufixo Cents', async () => {
    const { call, env } = mk();
    await connectAndConfirm(env, ORG_A);
    const r = await call('POST', '/api/evaluate', { body: { query: 'pizza', budget: { maxItemPriceCents: 10_000 } } });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.money).toEqual({ currency: 'BRL', unit: 'CENTS' });
    const pizza = body.blocked.find((c: { item: { name: string } }) => c.item.name === 'Promoção pizza grande');
    expect(pizza.blockers.map((b: { code: string }) => b.code)).toEqual(['ITEM_BUDGET_UNVERIFIED']); // faixa 6500–14300 vs teto 10000
    const p = pizza.pricing.minimumConfigurable;
    expect(p.unitTotalRange).toEqual({ minCents: 6500, maxCents: 14300 });
    expect(p.unit).toMatchObject({ listPriceCents: 7800, promotionalPriceCents: 6500, discountPerUnitCents: 1300 });
    expect(pizza.listingPrice).toEqual({ unitPriceCents: 7800, promotionalUnitPriceCents: 7800, definitive: false });
    expect(pizza.pricing.confirmedTotalCents).toBeNull();
    const ok = body.eligible.find((c: { item: { name: string } }) => c.item.name === 'Combo Individual - 1 Pizza 22cm + 1 Pizza Doce 22cm.');
    const okp = ok.pricing.minimumConfigurable;
    expect(okp.status).toBe('ESTIMATED');
    expect(okp.estimatedTotalCents).toBe(okp.unitTotalCents + okp.delivery.feeCents);
    expect(Number.isInteger(okp.estimatedTotalCents)).toBe(true);
    // Nenhum campo monetário decimal no contrato do bot
    const json = JSON.stringify(body);
    expect(json).not.toMatch(/"(unitTotal|estimatedTotal|listPrice|basePrice|fee|amount|unitPrice)":/);
    const nums: number[] = [];
    JSON.parse(json, (k, v) => (k.endsWith('Cents') && typeof v === 'number' && nums.push(v), v));
    expect(nums.length).toBeGreaterThan(10);
    expect(nums.every(Number.isInteger)).toBe(true);
  });
});

describe('cancelar tentativa × desconectar vínculo (rotas separadas)', () => {
  it('cancel encerra só a tentativa; vínculo confirmado continua', async () => {
    const { call, env } = mk();
    const first = await connectAndConfirm(env, ORG_A);
    await authorize(env, ORG_A); // reconexão pendente
    const r = await call('POST', '/api/bot/ifood/cancel');
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j).toMatchObject({ cancelled: true, state: 'CONNECTED', linkId: first.status.linkId, attempt: null });
    expect((await call('GET', '/api/addresses')).status).toBe(200);
    expect(await (await call('POST', '/api/bot/ifood/cancel')).json()).toMatchObject({ cancelled: false }); // idempotente
  });

  it('DELETE /link remove só o vínculo; tentativa pendente continua confirmável', async () => {
    const { call, env } = mk();
    await connectAndConfirm(env, ORG_A);
    const pending = await authorize(env, ORG_A);
    const d = await (await call('DELETE', '/api/bot/ifood/link')).json();
    expect(d).toMatchObject({ removed: true, state: 'AWAITING_CONFIRMATION', linkId: null, providerRevocation: 'NOT_ATTEMPTED' });
    expect((await call('GET', '/api/addresses')).status).toBe(409);
    const conf = await call('POST', '/api/bot/ifood/confirm', { body: { confirmationId: pending.confirmationId } });
    expect((await conf.json()).state).toBe('CONNECTED');
    const again = await (await call('DELETE', '/api/bot/ifood/link')).json();
    expect(again).toMatchObject({ removed: true, state: 'DISCONNECTED' });
    expect(await (await call('DELETE', '/api/bot/ifood/link')).json()).toMatchObject({ removed: false }); // idempotente
  });

  it('cancel sem nada pendente e sem vínculo ⇒ 200 cancelled=false', async () => {
    const { call } = mk();
    expect(await (await call('POST', '/api/bot/ifood/cancel')).json()).toMatchObject({ cancelled: false, state: 'DISCONNECTED' });
  });
});

describe('regressão de alergia em /api/evaluate (issue #3)', () => {
  it('ALLERGY:GLUTEN: filtro GLUTEN_FREE enviado ao iFood, mas nenhum candidato elegível', async () => {
    const { call, env } = mk();
    await connectAndConfirm(env, ORG_A);
    env.mcp.searchPages = [{ ...fx('searchOffers-lanche-glutenfree.json'), hasMore: false }];
    const r = await call('POST', '/api/evaluate', { body: { query: 'lanche', restrictions: [{ kind: 'ALLERGY', code: 'GLUTEN' }] } });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(env.mcp.searchArgs.at(-1)!.refinements).toMatchObject({ itemRestrictions: ['GLUTEN_FREE'] });
    expect(body.serverFilters).toEqual(['GLUTEN_FREE']);
    expect(body.summary).toMatchObject({ candidates: 1, eligible: 0, blocked: 1 });
    const c = body.blocked[0];
    expect(c.item.name).toBe('Veggie Burger');
    expect(c.detail.status).toBe('DETAILED');
    expect(c.eligible).toBe(false);
    expect(c.restrictions[0]).toMatchObject({ status: 'UNKNOWN', source: 'SERVER_FILTER_INSUFFICIENT', blocking: true });
    expect(c.blockers.map((b: { code: string }) => b.code)).toEqual(['ALLERGY_UNVERIFIED']);
    expect(body.summary.blockerCounts).toEqual({ ALLERGY_UNVERIFIED: 1 });
    // Preço continua sendo informado em centavos para transparência, mesmo bloqueado
    expect(c.pricing.minimumConfigurable.unitTotalCents).toBe(5980);
  });

  it('restrição alimentar GLUTEN_FREE (preferência de dieta) com o mesmo item continua elegível', async () => {
    const { call, env } = mk();
    await connectAndConfirm(env, ORG_A);
    env.mcp.searchPages = [{ ...fx('searchOffers-lanche-glutenfree.json'), hasMore: false }];
    const body = await (await call('POST', '/api/evaluate', { body: { query: 'lanche', restrictions: [{ kind: 'DIETARY', code: 'GLUTEN_FREE' }] } })).json();
    expect(body.summary).toMatchObject({ eligible: 1 });
  });
});

