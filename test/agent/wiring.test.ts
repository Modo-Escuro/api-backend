import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/server/config';
import { createConversationRuntime } from '../../src/server/conversation-runtime';
import { createApp } from '../../src/server/app';
import { IfoodAuth } from '../../src/server/auth';
import type { IfoodLinkService } from '../../src/server/links/service';
import { BOT_TOKEN, ORG_A, connectAndConfirm, setup } from '../helpers/fakes';
import { event, flush, principal, temporary } from '../turns/helpers';
import { geminiReply } from '../helpers/gemini';

const environment = { CONVERSATION_RUNTIME_ENABLED: 'true', BOT_TELEGRAM_ID: principal.botId,
  CONVERSATION_DB_FILE: '.conversations/test.sqlite', BOT_API_TOKEN: 'synthetic-token-xxxxxxxxxxxxxxxxxxxxxx',
  ALLOWED_ORGANIZER_IDS: principal.organizerId, CONVERSATION_MODEL_ENABLED: 'true',
  CONVERSATION_MODEL_PROVIDER: 'google', CONVERSATION_MODEL: 'gemini-3.8-flash', GEMINI_API_KEY: 'synthetic-key',
  CONVERSATION_MODEL_MAX_REQUESTS: '3' };
const noOperational = { withOperational: vi.fn(async () => { throw new Error('MCP não deveria ser chamado'); }) };

describe('montagem do entrypoint AI-01 (rede sintética)', () => {
  afterEach(() => vi.restoreAllMocks());
  it('padrão não monta runtime/modelo nem usa chave incidental', () => {
    const cfg = loadConfig({ GEMINI_API_KEY: 'synthetic-key' });
    expect(cfg.conversationModel).toBeUndefined();
    const status = vi.fn();
    expect(createConversationRuntime(cfg, { status, ...noOperational })).toBeUndefined();
    expect(status).not.toHaveBeenCalled();
  });
  it.each([
    { CONVERSATION_RUNTIME_ENABLED: 'false' }, { CONVERSATION_MODEL_PROVIDER: 'other' },
    { CONVERSATION_MODEL: '' }, { CONVERSATION_MODEL: 'gpt-x' }, { CONVERSATION_MODEL_PROVIDER: 'openai' },
    { GEMINI_API_KEY: '' }, { GEMINI_API_KEY: 'bad\nkey' }, { CONVERSATION_MODEL_MAX_REQUESTS: '100001' },
    { CONVERSATION_MODEL_MAX_REQUESTS_PER_CONVERSATION: '0' }, { CONVERSATION_MODEL_BUDGET_MICRO_USD: '50000001' },
    { CONVERSATION_MODEL_MAX_REQUESTS: '' }, { CONVERSATION_MODEL_MAX_REQUESTS: '0' },
    { CONVERSATION_MODEL_MAX_REQUESTS: '1.5' }, { CONVERSATION_MODEL_TIMEOUT_MS: '20001' },
    { CONVERSATION_MODEL_MAX_OUTPUT_TOKENS: '999999' }, { CONVERSATION_MODEL_ENABLED: 'TRUE' },
    { IFOOD_CART_ENABLED: 'true' }, { DEV_GLOBAL_SESSION: 'true' }, { BOT_API_TOKEN: '' },
    { ALLOWED_ORGANIZER_IDS: 'invalid' }, { ALLOWED_ORGANIZER_IDS: '' },
  ])('configuração incompleta/incompatível falha sem expor chave: %j', (overrides) => {
    expect(() => loadConfig({ ...environment, ...overrides })).toThrow(/AI-01|CONVERSATION_MODEL_ENABLED/);
  });

  it('runtime sem opt-in do modelo continua recusando evento novo', () => {
    const dir = temporary();
    const cfg = loadConfig({ ...environment, CONVERSATION_DB_FILE: dir.file, CONVERSATION_MODEL_ENABLED: 'false' });
    const runtime = createConversationRuntime(cfg, { status: vi.fn(), ...noOperational })!;
    try { expect(() => runtime.accept(principal, event())).toThrow(); }
    finally { runtime.stop(); dir.clean(); }
  });

  it('monta modelo → agente → SQLite; replay não chama modelo; correção conserva alergia', async () => {
    const dir = temporary();
    const cfg = loadConfig({ ...environment, CONVERSATION_DB_FILE: dir.file });
    const status = vi.fn<IfoodLinkService['status']>(async () => ({ state: 'DISCONNECTED', linkId: null }) as Awaited<ReturnType<IfoodLinkService['status']>>);
    const outputs = [
      [{ action: 'ADD_PARTICIPANT', name: 'Ana' }, { action: 'ADD_RESTRICTION', participant: { name: 'Ana' }, restriction: { kind: 'ALLERGY', code: 'PEANUT', requirement: 'MANDATORY' } }, { action: 'SET_LIMIT', target: 'GROUP', amountCents: 18000, kind: 'MANDATORY' }],
      [{ action: 'SET_LIMIT', target: 'GROUP', amountCents: 15000, kind: 'MANDATORY' }],
    ];
    const transport = vi.fn<typeof fetch>(async () => geminiReply({ actions: outputs.shift() }));
    const runtime = createConversationRuntime(cfg, { status, ...noOperational }, transport)!;
    const send = async (n: number, text: string) => {
      const e = event(n, n - 1); e.input = { kind: 'TEXT', text };
      const a = runtime.accept(principal, e);
      for (let i = 0; i < 50; i++) {
        runtime.tick(); await flush();
        if (runtime.store.operation(principal, a.operation.operationId).status === 'SUCCEEDED') return { e, a };
      }
      throw new Error('ensaio não concluiu');
    };
    try {
      const first = await send(1, 'Somos Ana. Ana é alérgica a amendoim. Teto de R$ 180');
      expect(runtime.accept(principal, first.e).operation.operationId).toBe(first.a.operation.operationId);
      expect(transport).toHaveBeenCalledTimes(1);
      await send(2, 'Na verdade, no máximo R$ 150');
      expect(runtime.store.snapshot(principal)).toMatchObject({ version: 2, humanApproval: null, allowedActions: [] });
      expect(runtime.store.snapshot(principal).blocks.find(b => b.kind === 'GROUP')).toMatchObject({ budgetCents: 15000, participants: [{ displayName: 'Ana', conditions: ['Alergia: amendoim (obrigatória)'] }] });
      expect(status).toHaveBeenCalledWith(principal.organizerId);
      const second = JSON.parse(String(transport.mock.calls[1]![1]!.body));
      expect(JSON.parse(second.contents[0].parts[0].text).participants[0].restrictions).toEqual([{ kind: 'ALLERGY', code: 'PEANUT', requirement: 'MANDATORY' }]);
    } finally { runtime.stop(); dir.clean(); }
  });

  it('rotas autenticadas usam a montagem e o mesmo serviço de vínculos; GET não chama modelo', async () => {
    const dir = temporary();
    const modelConfig = loadConfig(environment).conversationModel!;
    const env = setup({ conversationRuntime: { dbFile: dir.file, botId: principal.botId }, conversationModel: modelConfig });
    const linked = await connectAndConfirm(env, ORG_A); // OAuth/MCP inteiramente falsos.
    const transport = vi.fn<typeof fetch>(async () => geminiReply({ actions: [{ action: 'ADD_PARTICIPANT', name: 'Ana' }] }));
    const runtime = createConversationRuntime(env.cfg, env.links, transport)!;
    const app = createApp(new IfoodAuth(env.cfg, env.as.fetch, { tokenFile: null }), {
      config: env.cfg, links: env.links, conversations: runtime,
    });
    const headers = { authorization: `Bearer ${BOT_TOKEN}`, 'x-telegram-user-id': ORG_A,
      'x-telegram-chat-id': ORG_A, 'content-type': 'application/json' };
    const base = `/api/bot/v1/conversations/${ORG_A}`;
    const message = event(); message.input = { kind: 'TEXT', text: 'Somos Ana' };
    try {
      const denied = await app.request(`${base}/events`, { method: 'POST', body: JSON.stringify(message) });
      expect(denied.status).toBe(401);
      expect(transport).not.toHaveBeenCalled();
      const accepted = await app.request(`${base}/events`, { method: 'POST', headers, body: JSON.stringify(message) });
      expect(accepted.status).toBe(202);
      const { operationId } = await accepted.json();
      let op;
      for (let i = 0; i < 50; i++) {
        runtime.tick(); await flush();
        op = await (await app.request(`${base}/operations/${operationId}`, { headers })).json();
        if (!['ACCEPTED', 'RUNNING'].includes(op.status)) break;
        await new Promise(r => setTimeout(r, 5));
      }
      expect(op).toMatchObject({ status: 'SUCCEEDED', resultVersion: 1 });
      expect(await (await app.request(base, { headers })).json()).toMatchObject({ version: 1,
        humanApproval: null, allowedActions: [], blocks: expect.arrayContaining([
          { kind: 'GROUP', budgetCents: null, participants: [expect.objectContaining({ displayName: 'Ana' })] },
        ]) });
      const replay = await app.request(`${base}/events`, { method: 'POST', headers, body: JSON.stringify(message) });
      expect((await replay.json()).operationId).toBe(operationId);
      expect(transport).toHaveBeenCalledTimes(1);
      const domain = JSON.parse(String(runtime.store.db.prepare('SELECT domain FROM conversations').get()!['domain']));
      expect(domain.linkId).toBe(linked.status.linkId);
    } finally { runtime.stop(); dir.clean(); }
  });

  it('coleta não depende do iFood: vínculo UNAVAILABLE (rede) não bloqueia o turno', async () => {
    const dir = temporary();
    const cfg = loadConfig({ ...environment, CONVERSATION_DB_FILE: dir.file });
    const status = vi.fn<IfoodLinkService['status']>(async () => ({ state: 'UNAVAILABLE', linkId: 'link-confirmado' }) as Awaited<ReturnType<IfoodLinkService['status']>>);
    const transport = vi.fn<typeof fetch>(async () => geminiReply({ actions: [{ action: 'ADD_PARTICIPANT', name: 'Ana' }] }));
    const runtime = createConversationRuntime(cfg, { status, ...noOperational }, transport)!;
    try {
      const e = event(1, 0); e.input = { kind: 'TEXT', text: 'Somos Ana' };
      const a = runtime.accept(principal, e);
      let op;
      for (let i = 0; i < 50; i++) {
        runtime.tick(); await flush();
        op = runtime.store.operation(principal, a.operation.operationId);
        if (!['ACCEPTED', 'RUNNING'].includes(op.status)) break;
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(op).toMatchObject({ status: 'SUCCEEDED', resultVersion: 1 });
      expect(noOperational.withOperational).not.toHaveBeenCalled();
    } finally { runtime.stop(); dir.clean(); }
  });

  it('Telegram → AI-02 → Gemini → GRP-01 → sacola simulada, MCP só leitura e sem aprovação', async () => {
    const dir = temporary();
    const modelConfig = loadConfig(environment).conversationModel!;
    const env = setup({ conversationRuntime: { dbFile: dir.file, botId: principal.botId }, conversationModel: { ...modelConfig, maxRequests: 10 } });
    await connectAndConfirm(env, ORG_A); // OAuth/MCP inteiramente falsos.
    const outputs = [
      [{ action: 'ADD_PARTICIPANT', name: 'Ana' }, { action: 'SET_NO_RESTRICTIONS', participant: { name: 'Ana' } }],
      [{ action: 'SUGGEST_PROPOSALS', query: 'pizza' }],
      [{ action: 'SELECT_PROPOSAL', position: 1 }],
    ];
    const transport = vi.fn<typeof fetch>(async () => geminiReply({ actions: outputs.shift() }));
    const runtime = createConversationRuntime(env.cfg, env.links, transport)!;
    const app = createApp(new IfoodAuth(env.cfg, env.as.fetch, { tokenFile: null }), { config: env.cfg, links: env.links, conversations: runtime });
    const headers = { authorization: `Bearer ${BOT_TOKEN}`, 'x-telegram-user-id': ORG_A, 'x-telegram-chat-id': ORG_A, 'content-type': 'application/json' };
    const base = `/api/bot/v1/conversations/${ORG_A}`;
    const send = async (n: number, text: string, expectedVersion: number) => {
      const message = event(n, expectedVersion); message.input = { kind: 'TEXT', text };
      const accepted = await app.request(`${base}/events`, { method: 'POST', headers, body: JSON.stringify(message) });
      expect(accepted.status).toBe(202);
      const { operationId } = await accepted.json();
      for (let i = 0; i < 80; i++) {
        runtime.tick(); await flush();
        const op = await (await app.request(`${base}/operations/${operationId}`, { headers })).json();
        if (!['ACCEPTED', 'RUNNING'].includes(op.status)) return op;
        await new Promise((r) => setTimeout(r, 5));
      }
      throw new Error('operação não terminou');
    };
    try {
      expect(await send(1, 'Somos Ana, sem restrições', 0)).toMatchObject({ status: 'SUCCEEDED', resultVersion: 1 });
      const sug = await send(2, 'Sugere pizza', 1);
      expect(sug).toMatchObject({ status: 'SUCCEEDED', snapshot: { phase: 'PROPOSALS_READY', humanApproval: null } });
      expect(sug.snapshot.blocks.some((b: { kind: string }) => b.kind === 'PROPOSAL')).toBe(true);
      const chosen = await send(3, 'Quero a proposta 1', 2);
      expect(chosen).toMatchObject({ status: 'SUCCEEDED', snapshot: { phase: 'EDITING_CART', humanApproval: null } });
      const review = chosen.snapshot.blocks.find((b: { kind: string }) => b.kind === 'REVIEW');
      expect(review.blockers).toContain('Sacola simulada: aprovação e pedido ainda não estão disponíveis nesta etapa.');
      expect(review.price).toEqual({ kind: 'UNKNOWN', currency: 'BRL' });
      const used = env.mcp.used.map((u: { op: string }) => u.op);
      expect(used.every((op: string) => ['listAddresses', 'searchOffers', 'getItem', 'getUser'].includes(op))).toBe(true);
      expect(used).toContain('getItem');
      expect(transport).toHaveBeenCalledTimes(3);
    } finally { runtime.stop(); dir.clean(); }
  });

  it('auditoria: config no formato antigo do #35 falha com motivo claro; ENABLED=false explícito desliga sem erro', () => {
    const legacy = { CONVERSATION_RUNTIME_ENABLED: 'true', BOT_TELEGRAM_ID: principal.botId, CONVERSATION_DB_FILE: '.conversations/test.sqlite',
      CONVERSATION_MODEL: 'gemini-3.8-flash', GEMINI_API_KEY: 'synthetic-key' };
    expect(() => loadConfig(legacy)).toThrow(/CONVERSATION_MODEL definido sem CONVERSATION_MODEL_ENABLED/);
    try { loadConfig(legacy); } catch (e) { expect(String(e)).not.toContain('synthetic-key'); }
    expect(loadConfig({ ...legacy, CONVERSATION_MODEL_ENABLED: 'false' }).conversationModel).toBeUndefined();
    expect(loadConfig({ ...legacy, CONVERSATION_MODEL: 'off' }).conversationModel).toBeUndefined();
  });
});
