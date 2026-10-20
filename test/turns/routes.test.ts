import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/server/app';
import { loadConfig } from '../../src/server/config';
import { OperationSchema, SnapshotSchema } from '../../src/server/contracts/conversation';
import { TurnRuntime, type TurnProcessor, type TurnResult } from '../../src/server/turns/runtime';
import { TurnStore } from '../../src/server/turns/store';
import { cancelEnvelope, deferred, event, flush, principal, result, temporary } from './helpers';

const TOKEN = 'synthetic-only-xxxxxxxxxxxxxxxxxxxxxxxxxx';
const base = '/api/bot/v1/conversations/111111111';
const auth = { authorization: `Bearer ${TOKEN}`, 'x-telegram-user-id': '111111111',
  'x-telegram-chat-id': '111111111', 'content-type': 'application/json' };
describe('RUN-01 rotas autenticadas reais, sem MCP', () => {
  const cleanup: (() => void)[] = [];
  afterEach(() => { cleanup.splice(0).forEach(f => f()); vi.restoreAllMocks(); });
  function setup(processor: TurnProcessor = async context => result(context)) {
    const dir = temporary(), store = new TurnStore(dir.file);
    const runtime = new TurnRuntime(store, { processor });
    const config = loadConfig({ BOT_API_TOKEN: TOKEN, ALLOWED_ORGANIZER_IDS: '111111111,222222222',
      IFOOD_LINKS_DIR: dir.dir, CONVERSATION_RUNTIME_ENABLED: 'true', BOT_TELEGRAM_ID: '900001',
      CONVERSATION_DB_FILE: dir.file });
    const app = createApp({ config, conversations: runtime });
    cleanup.push(() => { runtime.stop(); dir.clean(); });
    return { app, runtime, store };
  }
  it('202 é durável, replay retorna 200 e GET recupera resultado sem executar novamente', async () => {
    const { app, runtime } = setup();
    const post = () => app.request(base + '/events', { method: 'POST', headers: auth, body: JSON.stringify(event()) });
    const response = await post(); expect(response.status).toBe(202);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const accepted = OperationSchema.parse(await response.json());
    runtime.tick(); await flush();
    const replay = await post(); expect(replay.status).toBe(200);
    const completed = OperationSchema.parse(await replay.json()); expect(completed.status).toBe('SUCCEEDED');
    expect(completed.operationId).toBe(accepted.operationId);
    const get = await app.request(`${base}/operations/${accepted.operationId}`, { headers: auth });
    expect(OperationSchema.parse(await get.json())).toEqual(completed);
    const snapshot = await app.request(base, { headers: auth });
    expect(SnapshotSchema.parse(await snapshot.json()).version).toBe(1);
  });
  it('auth legada, identidade de chat, origem e pertencimento são conferidos', async () => {
    const { app } = setup();
    expect((await app.request(base, { headers: { ...auth, authorization: 'Bearer bad' } })).status).toBe(401);
    expect((await app.request(base, { headers: { ...auth, 'x-telegram-chat-id': '222222222' } })).status).toBe(400);
    expect((await app.request(base, { headers: { ...auth, 'x-telegram-user-id': '222222222', 'x-telegram-chat-id': '222222222' } })).status).toBe(404);
    const forged = event(); forged.source.botId = '900002';
    const response = await app.request(base + '/events', { method: 'POST', headers: auth, body: JSON.stringify(forged) });
    expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ error: { code: 'INVALID_SOURCE' } });
  });
  it('corpo, versão, campos inesperados, limites monetários e tipos desconhecidos falham fechados', async () => {
    const { app } = setup();
    for (const json of [{ ...event(), contractVersion: '2.0' }, { ...event(), userConsent: true },
      { ...event(), expectedVersion: 2 ** 53 }, { ...event(), expectedVersion: true },
      { ...event(), input: { kind: 'TEXT', text: '🍕'.repeat(2001) } }]) {
      const response = await app.request(base + '/events', { method: 'POST', headers: auth, body: JSON.stringify(json) });
      expect(response.status).toBe(400);
    }
    for (const body of ['{', '{}'.padEnd(17_000), 'null']) {
      expect((await app.request(base + '/events', { method: 'POST', headers: auth, body })).status).toBe(400);
    }
    expect((await app.request(base + '/events', { method: 'POST', headers: { ...auth, 'content-type': 'text/plain' }, body: '{}' })).status).toBe(400);
  });
  it('ajuda/status de saúde continuam responsivos durante trabalho pendente e cancelamento só é local', async () => {
    const pending = deferred<TurnResult>(); const { app, runtime } = setup(() => pending.promise);
    const accepted = runtime.accept(principal, event()).operation; runtime.tick();
    const health = await app.request('/api/health'); expect(await health.json()).toMatchObject({ ok: true });
    const envelope = cancelEnvelope(2);
    const cancel = await app.request(`${base}/operations/${accepted.operationId}/cancel`, {
      method: 'POST', headers: auth, body: JSON.stringify({ ...envelope, operationId: accepted.operationId }),
    });
    expect(cancel.status).toBe(202); expect(await cancel.json()).toMatchObject({ remoteCancellation: 'NOT_REQUESTED', status: 'REQUESTED' });
    pending.reject(new Error('synthetic abort')); await flush();
  });
  it('rota de aprovação e ações gerais não habilitam compra; runtime desativado retorna erro seguro', async () => {
    const { app } = setup();
    const approval = await app.request(base + '/purchase-approvals', { method: 'POST', headers: auth, body: '{}' });
    expect(approval.status).toBe(409);
    const action = event(); action.source = { ...action.source, kind: 'CALLBACK', callbackQueryId: 'click' };
    action.input = { kind: 'ACTION', action: 'REQUEST_REVIEW', actionRef: 'a'.repeat(24) };
    expect((await app.request(base + '/events', { method: 'POST', headers: auth, body: JSON.stringify(action) })).status).toBe(409);
    const disabled = createApp({ config: loadConfig({ BOT_API_TOKEN: TOKEN, ALLOWED_ORGANIZER_IDS: '111111111' }) });
    const response = await disabled.request(base, { headers: auth }); expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'UNAVAILABLE' } });
  });
  it('logs não contêm identidade, operação, texto, referência ou segredo', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { app } = setup();
    await app.request(base + '/events', { method: 'POST', headers: auth, body: JSON.stringify(event()) });
    await app.request(`${base}/operations/${'o'.repeat(24)}`, { headers: auth });
    const output = JSON.stringify([log.mock.calls, error.mock.calls]);
    for (const value of ['111111111', '900001', 'o'.repeat(24), TOKEN, 'Mensagem sintética']) expect(output).not.toContain(value);
  });
  it('flag exige caminho e bot explícitos; não lê nem expõe token Telegram', () => {
    expect(loadConfig({}).conversationRuntime).toBeUndefined();
    expect(() => loadConfig({ CONVERSATION_RUNTIME_ENABLED: 'true' })).toThrowError('RUN-01 exige');
    expect(() => loadConfig({ CONVERSATION_RUNTIME_ENABLED: 'true', BOT_TELEGRAM_ID: 'x', CONVERSATION_DB_FILE: 'db.sqlite' })).toThrow();
    expect(() => loadConfig({ CONVERSATION_RUNTIME_ENABLED: 'true', BOT_TELEGRAM_ID: '900001', CONVERSATION_DB_FILE: 'db.sqlite', RAILWAY_SERVICE_ID: 'synthetic' })).toThrowError('armazenamento persistente');
  });
  it('diretório de memória devolve personas do vínculo atual, desabilitado sem conta', async () => {
    const dir = temporary(), store = new TurnStore(dir.file);
    const runtime = new TurnRuntime(store, { processor: async context => result(context) });
    const config = loadConfig({ BOT_API_TOKEN: TOKEN, ALLOWED_ORGANIZER_IDS: '111111111', IFOOD_LINKS_DIR: dir.dir,
      CONVERSATION_RUNTIME_ENABLED: 'true', BOT_TELEGRAM_ID: '900001', CONVERSATION_DB_FILE: dir.file });
    const statusless = { status: vi.fn(async () => ({ state: 'CONNECTED', linkId: null, operational: false }) as never) };
    const empty = createApp({ config, conversations: runtime, links: statusless as never });
    expect(await (await empty.request(base + '/memory', { headers: auth })).json())
      .toEqual({ contractVersion: '1.0', revision: 0, recipients: [], enabled: false });
    const linked = { status: vi.fn(async () => ({ state: 'CONNECTED', linkId: 'synthetic-link-A', operational: true }) as never) };
    const app = createApp({ config, conversations: runtime, links: linked as never });
    expect(await (await app.request(base + '/memory', { headers: auth })).json())
      .toEqual({ contractVersion: '1.0', revision: 0, recipients: [], enabled: true });
    runtime.stop(); dir.clean();
  });
});
