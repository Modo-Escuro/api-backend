// OPS-02: falhas controladas, autorização do status, cardinalidade, concorrência e reinício (offline, sintético).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createApp } from '../../src/server/app';
import type { AssistantModel } from '../../src/server/assistant/protocol';
import { offlineAssistant } from '../helpers/assistant';
import { ContractError } from '../../src/server/contracts/guards';
import { ALLOWED_TOOLS, callReadTool } from '../../src/server/mcp/tools';
import { SpendBudget } from '../../src/server/ops/budget';
import { setLogSink } from '../../src/server/ops/log';
import { MAX_SERIES, metrics } from '../../src/server/ops/metrics';
import type { TurnContext } from '../../src/server/turns/runtime';
import { TurnRuntime } from '../../src/server/turns/runtime';
import { TurnStore } from '../../src/server/turns/store';
import { BOT_TOKEN, ORG_A, ORG_B, connectAndConfirm, setup } from '../helpers/fakes';
import { event, principal, result, temporary } from '../turns/helpers';

const auth = (org = ORG_A, token = BOT_TOKEN) => ({ authorization: `Bearer ${token}`, 'x-telegram-user-id': org });

describe('OPS-02 falhas e limites', () => {
  const lines: string[] = [];
  const cleanup: (() => void)[] = [];
  beforeEach(() => { metrics.reset(); setLogSink((_, l) => lines.push(l)); vi.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(() => { cleanup.splice(0).forEach((f) => f()); setLogSink(); lines.length = 0; vi.restoreAllMocks(); });

  it('requisições não autenticadas a caminhos arbitrários não criam séries nem IDs nas métricas', async () => {
    const env = setup();
    const app = createApp({ config: env.cfg, links: env.links });
    for (let i = 0; i < MAX_SERIES + 50; i++) await app.request(`/api/bot/x${i}/11988887777`);
    await app.request('/api/health');
    const snap = metrics.snapshot();
    expect(snap.droppedSeries).toBe(0);
    expect(Object.keys(snap.counters).length).toBeLessThan(10);
    expect(metrics.counter('http_requests_total', { method: 'GET', route: '/api/bot/*', statusClass: '4xx' })).toBe(MAX_SERIES + 50);
    expect(metrics.counter('http_requests_total', { method: 'GET', route: '/api/health', statusClass: '2xx' })).toBe(1);
    expect(JSON.stringify(snap) + lines.join('\n')).not.toMatch(/bot\/x\d|11988887777/);
  });

  it('GET /api/ops/status: autenticação, autorização, configuração ausente e no-store', async () => {
    const env = setup();
    const app = createApp({ config: env.cfg, links: env.links });
    expect((await app.request('/api/ops/status')).status).toBe(401);
    expect((await app.request('/api/ops/status', { headers: auth(ORG_A, 'x'.repeat(40)) })).status).toBe(401);
    expect((await app.request('/api/ops/status', { headers: { authorization: `Bearer ${BOT_TOKEN}` } })).status).toBe(400);
    expect((await app.request('/api/ops/status', { headers: auth('333333333') })).status).toBe(403);
    expect((await app.request('/api/ops/status', { headers: auth(`${ORG_A}, ${ORG_B}`) })).status).toBe(400);
    expect((await app.request('/api/ops/status?organizerId=' + ORG_A)).status).toBe(401);
    const ok = await app.request('/api/ops/status', { headers: auth() });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toBe('no-store');
    const off = createApp({ config: { ...env.cfg, botApiToken: undefined }, links: env.links });
    expect((await off.request('/api/ops/status', { headers: auth() })).status).toBe(503);
  });

  it('sessões: operacional, indisponível (rede), reconectar (refresh recusado) e não verificada após reinício', async () => {
    const env = setup();
    const app = createApp({ config: env.cfg, links: env.links });
    const sessions = async (a = app) => (await (await a.request('/api/ops/status', { headers: auth() })).json()).sessions;
    const { status } = await connectAndConfirm(env, ORG_A);
    await connectAndConfirm(env, ORG_B);
    expect(await sessions()).toEqual({ confirmed: 2, operational: 2, unavailable: 0, reconnectRequired: 0, unverified: 0 });

    env.clock.advance(2 * 3600_000);
    env.as.refreshMode = 'network';
    await env.links.withOperational(ORG_A, 'ADDRESSES_READ', (ctx) => ctx.deps.listAddresses()).catch(() => null);
    env.as.refreshMode = 'invalid_grant';
    await env.links.withOperational(ORG_B, 'ADDRESSES_READ', (ctx) => ctx.deps.listAddresses()).catch(() => null);
    expect(await sessions()).toMatchObject({ confirmed: 2, operational: 0, unavailable: 1, reconnectRequired: 1 });

    // HTTP continua saudável enquanto as sessões não estão operacionais.
    expect((await app.request('/api/health')).status).toBe(200);
    const body = JSON.stringify(await (await app.request('/api/ops/status', { headers: auth() })).json());
    for (const forbidden of [status.linkId!, ORG_A, ORG_B, env.cfg.linksDir, 'Maria', 'example.com', 'at-', 'rt-']) expect(body).not.toContain(forbidden);

    // Reinício: o vínculo com refresh recusado continua RECONNECT; o outro aparece como não verificado (sem chamada remota).
    const { IfoodLinkService } = await import('../../src/server/links/service');
    const restarted = new IfoodLinkService({ cfg: env.cfg, sessionFactory: env.mcp.factory, fetchImpl: env.as.fetch, now: env.clock.now });
    const calls = env.mcp.used.length;
    expect(await sessions(createApp({ config: env.cfg, links: restarted }))).toEqual(
      { confirmed: 2, operational: 0, unavailable: 0, reconnectRequired: 1, unverified: 1 });
    expect(env.mcp.used.length).toBe(calls);
  });

  it('falhas MCP: métricas por ferramenta/código sem argumentos; ferramenta de escrita é recusada antes do cliente', async () => {
    const calls: string[] = [];
    const client = (impl: () => unknown) => ({ callTool: async (r: { name: string }) => { calls.push(r.name); return impl(); } }) as unknown as Client;
    const args = { query: 'Rua das Flores 123', userLocation: { latitude: -23.5, longitude: -46.6 } };
    await callReadTool('searchOffers', args, client(() => ({ structuredContent: { results: [] } })));
    await expect(callReadTool('searchOffers', args, client(() => ({ structuredContent: { errors: [{ code: 'RATE_LIMITED', message: 'Rua das Flores', retryable: true }] } })))).rejects.toThrow();
    await expect(callReadTool('getItem', args, client(() => { throw new TypeError('fetch failed para https://x?token=abc'); }))).rejects.toThrow();
    for (const write of ['createCart', 'addItemToCart', 'checkout']) {
      await expect(callReadTool(write, {}, client(() => ({})))).rejects.toThrow(/não permitida/);
    }
    expect(calls).toEqual(['searchOffers', 'searchOffers', 'getItem']);
    expect(metrics.counter('mcp_tool_calls_total', { tool: 'searchOffers', outcome: 'OK' })).toBe(1);
    expect(metrics.counter('mcp_tool_calls_total', { tool: 'searchOffers', outcome: 'TOOL_ERROR', code: 'RATE_LIMITED' })).toBe(1);
    expect(metrics.counter('mcp_tool_calls_total', { tool: 'getItem', outcome: 'TRANSPORT_ERROR' })).toBe(1);
    expect(JSON.stringify(metrics.snapshot())).not.toMatch(/Flores|token|-23|createCart|submitOrder/);
    expect([...ALLOWED_TOOLS].sort()).toEqual(['browseOffers', 'getItem', 'getMerchant', 'getRecommendations', 'getUser', 'listAddresses', 'searchOffers']);
  });

  it('runtime indisponível: admissão fecha, status mostra, log sem caminho', async () => {
    const dir = temporary();
    const store = new TurnStore(dir.file);
    const runtime = new TurnRuntime(store, { processor: async (c) => result(c) });
    cleanup.push(() => { try { runtime.stop(); } catch { /* fechado */ } dir.clean(); });
    expect(runtime.health()).toMatchObject({ accepting: true, healthy: true, storage: 'OK' });
    store.db.close(); // falha controlada do armazenamento
    runtime.tick();
    expect(runtime.health()).toMatchObject({ accepting: false, healthy: false, storage: 'UNAVAILABLE' });
    expect(() => runtime.accept(principal, event())).toThrow(ContractError);
    expect(lines.some((l) => JSON.parse(l).event === 'turns.runtime_unhealthy')).toBe(true);
    expect(lines.join('\n')).not.toContain(dir.dir);
  });
});

describe('OPS-02 orçamento sob concorrência e reinício', () => {
  afterEach(() => setLogSink());
  beforeEach(() => setLogSink(() => {}));

  function ctx(signal = new AbortController().signal): TurnContext {
    return {
      event: event(), principal: { ...principal }, purchase: null, signal,
      snapshot: { contractVersion: '1.0', conversationId: principal.conversationId, version: 0, phase: 'COLLECTING',
        blocks: [], pending: [], allowedActions: [], humanApproval: null },
      previewDomain: () => null, beforeExternalWrite: () => { throw new ContractError('ACTION_UNAVAILABLE'); },
    };
  }

  it('turnos simultâneos da mesma conversa não ultrapassam o teto de chamadas', async () => {
    const budget = new SpendBudget({ maxCallsPerConversation: 2 });
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const model: AssistantModel = { id: 'slow', propose: async () => { calls++; await gate; return { message: 'Certo.', requests: [], itemRefs: [] }; } };
    const processor = offlineAssistant(model, budget);
    const outcome = (p: ReturnType<typeof processor>) => Promise.resolve(p).then(() => 'OK', (e) => (e as ContractError).code);
    const first = outcome(processor(ctx()));
    for (let i = 0; i < 30 && !calls; i++) await new Promise(r => setTimeout(r, 1));
    const runs = [first, outcome(processor(ctx())), outcome(processor(ctx()))];
    release();
    expect((await Promise.all(runs)).sort()).toEqual(['LIMIT_EXCEEDED', 'LIMIT_EXCEEDED', 'OK']);
    expect(calls).toBe(1);
  });

  it('uso reportado maior que a reserva é cobrado; uso inválido não reduz a contagem', async () => {
    const budget = new SpendBudget({ maxTokensPerConversation: 10_000 });
    const usage = [{ inputTokens: 9_000, outputTokens: 900 }, { inputTokens: -5, outputTokens: Number.NaN }];
    let i = 0;
    const model: AssistantModel = { id: 'u', propose: async r => { r.reportUsage?.(usage[i++]!); return { message: 'Certo.', requests: [], itemRefs: [] }; } };
    const processor = offlineAssistant(model, budget, 50);
    await processor(ctx());
    expect(budget.summary().global.tokens).toBe(9_900);
    await expect(processor(ctx())).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
  });

  it('reinício zera orçamento e métricas: o limite é por processo, não uma garantia global persistente', () => {
    const a = new SpendBudget({ maxCallsPerConversation: 1 });
    expect(a.reserve('k', 1).ok).toBe(true);
    expect(a.reserve('k', 1).ok).toBe(false);
    const afterRestart = new SpendBudget({ maxCallsPerConversation: 1 });
    expect(afterRestart.reserve('k', 1).ok).toBe(true); // comportamento documentado em docs/ops-02-operacao.md
  });
});

describe('OPS-02 ausência de escrita', () => {
  it('módulos de observabilidade e agente não importam carrinho nem ferramentas de escrita', () => {
    const root = join(__dirname, '../../src/server');
    for (const f of ['ops/log.ts', 'ops/metrics.ts', 'ops/budget.ts', 'ops/storage-check.ts', 'assistant/processor.ts']) {
      const src = readFileSync(join(root, f), 'utf8');
      expect(src).not.toMatch(/from '\.\.\/cart|mcp\/cart|submitOrder|createCart|beginExternalEffect/);
    }
  });
});
