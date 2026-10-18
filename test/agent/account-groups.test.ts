import { afterEach, describe, expect, it } from 'vitest';
import { TurnStore, sessionRef, scopeKey } from '../../src/server/turns/store';
import { TurnRuntime } from '../../src/server/turns/runtime';
import { createAgentProcessor } from '../../src/server/agent/processor';
import { DeterministicModel } from '../../src/server/agent/mock-model';
import { temporary, flush } from '../turns/helpers';
import { IfoodAuth } from '../../src/server/auth';
import { testConfig, setup, connectAndConfirm, ORG_A, BOT_TOKEN } from '../helpers/fakes';
import { IfoodLinkService } from '../../src/server/links/service';
import { createApp } from '../../src/server/app';

const p = { organizerId: '111111111', botId: '900001', conversationId: '111111111' };
const a = { key: 'a'.repeat(64), linkId: 'session-A-1' }, b = { key: 'b'.repeat(64), linkId: 'session-B-1' };
const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach(f => f()));

describe('grupos por conta e geração da sessão', () => {
  it('HTTP exige a sessão original em edições e mensagens; A → B → A restaura o cadastro', async () => {
    const dir = temporary(); let current = a;
    const runtime = new TurnRuntime(new TurnStore(dir.file), { accountScope: async (_org, fn) => fn(current) });
    cleanup.push(() => { runtime.stop(); dir.clean(); });
    const cfg = testConfig({ conversationRuntime: { botId: p.botId, dbFile: dir.file }, accountGroups: true });
    const app = createApp(new IfoodAuth(cfg, undefined, { tokenFile: null }), { config: cfg, conversations: runtime });
    const base = `/api/bot/v1/conversations/${p.conversationId}`;
    const headers = { authorization: `Bearer ${BOT_TOKEN}`, 'x-telegram-user-id': p.organizerId, 'x-telegram-chat-id': p.conversationId, 'content-type': 'application/json' };
    expect(await (await app.request(base + '/account-context', { headers })).json()).toEqual({ enabled: true, sessionRef: sessionRef(a.linkId) });
    const body = JSON.stringify({ source: 'TELEGRAM_CALLBACK', expectedVersion: 0, ops: [{ op: 'ADD_PARTICIPANT', displayName: 'Ana' }] });
    expect((await app.request(base + '/group', { method: 'POST', headers, body })).status).toBe(409);
    const bound = { ...headers, 'x-conversation-session': sessionRef(a.linkId) };
    expect((await app.request(base + '/group', { method: 'POST', headers: bound, body })).status).toBe(200);
    current = b;
    expect((await app.request(base + '/group', { method: 'POST', headers: bound, body })).status).toBe(409);
    expect(await (await app.request(base + '/group', { headers })).json()).toEqual({ version: 0, group: null });
    current = { ...a, linkId: 'session-A-2' };
    const restored = await (await app.request(base + '/group', { headers })).json();
    expect(restored.group.participants[0].displayName).toBe('Ana');
    expect((await app.request(base, { headers: bound })).status).toBe(409);
  });

  it('serviço persiste identidade e mantém logout fora do commit de conversa; referência antiga é recusada', async () => {
    const env = setup();
    let userinfoCalls = 0;
    const fetcher: typeof fetch = async (url, init) => {
      if (String(url).endsWith('/userinfo')) { userinfoCalls++; return Response.json({ sub: 'synthetic-stable-A' }); }
      const result = await env.as.fetch(url, init);
      if (String(url).endsWith('openid-configuration')) return Response.json({ ...await result.json(),
        userinfo_endpoint: 'https://as.test/userinfo', subject_types_supported: ['public'] });
      return result;
    };
    const build = () => new IfoodLinkService({ cfg: env.cfg, sessionFactory: env.mcp.factory, fetchImpl: fetcher, now: env.clock.now });
    env.links = build();
    await connectAndConfirm(env, ORG_A);
    const first = await env.links.withConversationAccount(ORG_A, async value => value);
    env.links = build();
    expect(await env.links.withConversationAccount(ORG_A, async value => value)).toEqual(first);
    expect(userinfoCalls).toBe(1);
    await expect(env.links.disconnect(ORG_A, 'old-session')).rejects.toThrow();
    let release!: () => void, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const commit = env.links.withConversationAccount(ORG_A, async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); });
    await started;
    let ended = false;
    const logout = env.links.disconnect(ORG_A, first.linkId).then(() => { ended = true; });
    await flush(); expect(ended).toBe(false);
    release(); await commit; await logout;
    await expect(env.links.withConversationAccount(ORG_A, async value => value)).rejects.toThrow('LINK_CHANGED');
    await connectAndConfirm(env, ORG_A);
    const next = await env.links.withConversationAccount(ORG_A, async value => value);
    expect(next.key).toBe(first.key); expect(next.linkId).not.toBe(first.linkId);
  });
  it('A → B → A após reinício recupera só o cadastro, sem sacola e sem atribuir legado', () => {
    const dir = temporary(); let store = new TurnStore(dir.file);
    cleanup.push(() => { store.close(); dir.clean(); });
    store.activateAccount(p, a);
    store.editGroup(p, 0, [{ op: 'ADD_PARTICIPANT', displayName: 'Ana' }]);
    const first = store.group(p);
    store.activateAccount(p, b);
    expect(store.group(p).group).toBeNull();
    store.editGroup(p, 0, [{ op: 'ADD_PARTICIPANT', displayName: 'Bia' }]);
    store.close(); store = new TurnStore(dir.file);
    store.activateAccount(p, { ...a, linkId: 'session-A-2' });
    expect(store.group(p)).toEqual(first);
    expect(JSON.stringify(store.snapshot(p))).not.toContain('Bia');
    const domain = JSON.parse(String(store.db.prepare('SELECT domain FROM conversations WHERE scope=?').get(scopeKey(p))!['domain']));
    expect(domain.bag).toBeUndefined();
    expect(domain.address.state).toBe('NOT_ASKED');
    store.editGroup(p, first.version, null);
    expect(store.group(p).group?.participants).toEqual([]);
    expect(() => store.editGroup(p, first.version, [{ op: 'ADD_PARTICIPANT', displayName: 'Ana' }])).toThrow('STALE_VERSION');
    store.activateAccount({ ...p, botId: '900002' }, a);
    expect(store.group({ ...p, botId: '900002' }).group).toBeNull();
  });

  it('mensagem aceita em A não executa em B nem em outro login de A, inclusive após reinício', async () => {
    const dir = temporary(); let current = a;
    const build = () => new TurnRuntime(new TurnStore(dir.file), {
      accountScope: async (_org, fn) => fn(current),
      processor: createAgentProcessor({ model: new DeterministicModel(), linkOf: async () => current.linkId }),
    });
    let runtime = build(); cleanup.push(() => { runtime.stop(); dir.clean(); });
    await runtime.withAccount(p, undefined, () => undefined, true);
    const event = { contractVersion: '1.0' as const, eventId: 'pending-from-A', conversationId: p.conversationId, expectedVersion: runtime.store.snapshot(p).version,
      source: { channel: 'TELEGRAM' as const, kind: 'MESSAGE' as const, botId: p.botId, conversationId: p.conversationId, messageId: '1' }, input: { kind: 'TEXT' as const, text: 'Somos Ana' } };
    const accepted = await runtime.withAccount(p, sessionRef(a.linkId), () => runtime.accept(p, event));
    runtime.stop(); current = b; runtime = build();
    runtime.tick(); await flush(); await flush();
    expect(runtime.store.operation(p, accepted.operation.operationId).error?.code).toBe('LINK_CHANGED');
    await runtime.withAccount(p, undefined, () => undefined, true);
    expect(runtime.store.group(p).group).toBeNull();
    await expect(runtime.withAccount(p, sessionRef(a.linkId), () => runtime.accept(p, event))).rejects.toThrow('LINK_CHANGED');
    current = { ...a, linkId: 'new-session-A' };
    await expect(runtime.withAccount(p, sessionRef(a.linkId), () => runtime.accept(p, event))).rejects.toThrow('LINK_CHANGED');
  });
});

describe('identidade UserInfo interna', () => {
  const token = { clientId: 'cid', accessToken: 'synthetic-token', refreshToken: null, expiresAt: null, scope: null, source: 'test', obtainedAt: 1 };
  async function identity(sub: unknown, extra: Record<string, unknown> = {}, endpoint = 'https://as.test/userinfo') {
    let requests = 0;
    const auth = new IfoodAuth(testConfig(), async (url, init) => {
      if (String(url).includes('openid-configuration')) return Response.json({ issuer: 'https://as.test/3p', userinfo_endpoint: endpoint, subject_types_supported: ['public'] });
      requests++;
      expect(init?.redirect).toBe('error');
      expect(init?.headers).toMatchObject({ authorization: 'Bearer synthetic-token' });
      return Response.json({ sub, ...extra });
    }, { tokenFile: null });
    await auth.setTokens(token);
    return { auth, requests: () => requests };
  }
  it('usa issuer/client/sub, permanece igual em logins diferentes e ignora nome/email', async () => {
    const one = await identity('stable-A', { name: 'Ana', email: 'a@test.local' });
    const two = await identity('stable-A', { name: 'Outro nome', email: 'b@test.local' });
    const other = await identity('stable-B');
    expect(await one.auth.accountKey()).toEqual(await two.auth.accountKey());
    expect(await one.auth.accountKey()).not.toEqual(await other.auth.accountKey());
    expect(await one.auth.accountKey()).toMatch(/^[a-f0-9]{64}$/);
  });
  it('recusa identidade ausente, issuer divergente e endpoint que vazaria o token', async () => {
    for (const value of [undefined, '', 123, 'has spaces']) await expect((await identity(value)).auth.accountKey()).rejects.toThrow('Identidade estável indisponível');
    await expect((await identity('A', { iss: 'https://other.test' })).auth.accountKey()).rejects.toThrow();
    const foreign = await identity('A', {}, 'https://other.test/userinfo');
    await expect(foreign.auth.accountKey()).rejects.toThrow();
    expect(foreign.requests()).toBe(0);
  });
});
