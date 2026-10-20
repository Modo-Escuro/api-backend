// OPS-02 × AI-01: orçamento SpendBudget ligado ao adaptador Gemini real (createGeminiModel) via createConversationRuntime.
// Rede inteiramente sintética (transporte falso): nenhuma chamada ao Gemini, ao iFood ou a compra.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/server/app';
import { loadConfig } from '../../src/server/config';
import { createConversationRuntime } from '../../src/server/conversation-runtime';
import type { IfoodLinkService } from '../../src/server/links/service';
import { SpendBudget } from '../../src/server/ops/budget';
import { setLogSink } from '../../src/server/ops/log';
import { metrics } from '../../src/server/ops/metrics';
import { BOT_TOKEN, ORG_A, setup } from '../helpers/fakes';
import { geminiReply } from '../helpers/gemini';
import { event, flush, principal, temporary } from '../turns/helpers';

const KEY = 'synthetic-gemini-key-ops02';
const environment = { CONVERSATION_RUNTIME_ENABLED: 'true', BOT_TELEGRAM_ID: principal.botId,
  CONVERSATION_DB_FILE: '.conversations/test.sqlite', BOT_API_TOKEN: 'synthetic-token-xxxxxxxxxxxxxxxxxxxxxx',
  ALLOWED_ORGANIZER_IDS: `${principal.organizerId},222222222`, CONVERSATION_MODEL_ENABLED: 'true',
  CONVERSATION_MODEL_PROVIDER: 'google', CONVERSATION_MODEL: 'gemini-3.8-flash', GEMINI_API_KEY: KEY,
  CONVERSATION_MODEL_MAX_REQUESTS: '50' };
const status = vi.fn<IfoodLinkService['status']>(async () => ({ state: 'DISCONNECTED', linkId: null }) as Awaited<ReturnType<IfoodLinkService['status']>>);
const links = { status, withOperational: vi.fn(async () => { throw new Error('MCP não deveria ser chamado'); }) };
const reply = (init?: RequestInit) => {
  const input = JSON.parse(JSON.parse(String(init?.body)).contents[0].parts[0].text);
  return geminiReply(input.round === undefined
    ? { targets: [{ kind: 'SELF' }], mentioned: [], purpose: 'FOOD', ambiguous: false }
    : { message: 'Vamos organizar seu pedido.', requests: [], itemRefs: [] });
};
// geminiReply reporta 800 tokens de entrada e 40 de saída; custo de referência = 800×0,75 + 40×3,75 µUSD.
const REPORTED = 1680; // roteador + planejador, ambos com uso reportado
const COST = 1500;

type Runtime = NonNullable<ReturnType<typeof createConversationRuntime>>;
async function send(runtime: Runtime, n: number, who = principal, waitMs = 2, expectedVersion = n - 1) {
  const e = event(n, expectedVersion); e.conversationId = who.conversationId; e.source.conversationId = who.conversationId;
  e.input = { kind: 'TEXT', text: 'Somos Ana' };
  const a = runtime.accept(who, e);
  for (let i = 0; i < 400; i++) {
    runtime.tick(); await flush();
    const op = runtime.store.operation(who, a.operation.operationId);
    if (!['ACCEPTED', 'RUNNING'].includes(op.status)) return op;
    await new Promise(r => setTimeout(r, waitMs));
  }
  throw new Error('operação não terminou');
}

describe('OPS-02 × AI-01 Gemini: orçamento, reportUsage e falhas', () => {
  const lines: string[] = [];
  let dir: ReturnType<typeof temporary>;
  const runtimes: Runtime[] = [];
  const make = (budget: SpendBudget, transport: typeof fetch, overrides: Record<string, string> = {}) => {
    const cfg = loadConfig({ ...environment, CONVERSATION_DB_FILE: dir.file, ...overrides });
    const r = createConversationRuntime(cfg, links, transport, budget)!;
    runtimes.push(r);
    return r;
  };
  beforeEach(() => { dir = temporary(); metrics.reset(); setLogSink((_, l) => lines.push(l)); });
  afterEach(() => { runtimes.splice(0).forEach(r => r.stop()); dir.clean(); setLogSink(); lines.length = 0; vi.clearAllMocks(); });

  it('tokens reportados pelo Gemini substituem a reserva (sem cobrança dupla) e geram métricas de tokens e custo', async () => {
    const budget = new SpendBudget();
    const transport = vi.fn<typeof fetch>(async (_u, init) => reply(init));
    const runtime = make(budget, transport);
    expect((await send(runtime, 1)).status).toBe('SUCCEEDED');
    expect(budget.summary().global).toMatchObject({ calls: 2, tokens: REPORTED });
    expect((await send(runtime, 2)).status).toBe('SUCCEEDED');
    expect(budget.summary().global).toMatchObject({ calls: 4, tokens: 2 * REPORTED });
    expect(metrics.counter('model_tokens_total', { kind: 'input' })).toBe(3200);
    expect(metrics.counter('model_tokens_total', { kind: 'output' })).toBe(160);
    expect(metrics.counter('model_tokens_total', { kind: 'reserved_unreported' })).toBe(0);
    expect(metrics.counter('model_cost_micro_usd_total')).toBe(2 * COST);
    expect(metrics.counter('model_calls_total', { outcome: 'OK' })).toBe(4);
    expect(transport).toHaveBeenCalledTimes(4);
  });

  it('LIMIT_EXCEEDED por conversa antes de chamar o Gemini; estado preservado e retomado na janela seguinte', async () => {
    let t = 1_000_000;
    const budget = new SpendBudget({ maxCallsPerConversation: 2, windowMs: 60_000 }, () => t);
    const transport = vi.fn<typeof fetch>(async (_u, init) => reply(init));
    const runtime = make(budget, transport);
    expect((await send(runtime, 1)).status).toBe('SUCCEEDED');
    const denied = await send(runtime, 2);
    expect(denied).toMatchObject({ status: 'FAILED', error: { code: 'LIMIT_EXCEEDED' } });
    expect(transport).toHaveBeenCalledTimes(2);
    expect(runtime.store.snapshot(principal).version).toBe(1);
    expect(metrics.counter('agent_budget_exceeded_total', { kind: 'CONVERSATION_CALLS' })).toBe(1);
    t += 60_000;
    // O evento recusado não avançou a versão: o próximo parte da versão 1 preservada.
    expect((await send(runtime, 3, principal, 2, 1)).status).toBe('SUCCEEDED');
    expect(runtime.store.snapshot(principal).version).toBe(2);
    expect(transport).toHaveBeenCalledTimes(4);
  });

  it('limite global vale entre conversas', async () => {
    const budget = new SpendBudget({ maxCallsGlobal: 2 });
    const transport = vi.fn<typeof fetch>(async (_u, init) => reply(init));
    const runtime = make(budget, transport);
    const other = { ...principal, organizerId: '222222222', conversationId: '222222222' };
    expect((await send(runtime, 1)).status).toBe('SUCCEEDED');
    expect(await send(runtime, 1, other)).toMatchObject({ status: 'FAILED', error: { code: 'LIMIT_EXCEEDED' } });
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('Gemini recusa antes da rede (limite próprio do adaptador) ⇒ reserva OPS-02 devolvida, nada preso', async () => {
    const budget = new SpendBudget();
    const transport = vi.fn<typeof fetch>(async (_u, init) => reply(init));
    const runtime = make(budget, transport, { CONVERSATION_MODEL_MAX_REQUESTS: '2' });
    expect((await send(runtime, 1)).status).toBe('SUCCEEDED');
    const second = await send(runtime, 2);
    expect(second.status).toBe('FAILED');
    expect(transport).toHaveBeenCalledTimes(2);
    expect(budget.summary().global).toMatchObject({ calls: 3, tokens: REPORTED });
    expect(runtime.store.snapshot(principal).version).toBe(1);
  });

  it('timeout sem uso reportado mantém só a reserva (conservador); relato tardio não cobra de novo', async () => {
    const budget = new SpendBudget();
    let release!: () => void;
    const late = new Promise<void>(r => { release = r; });
    // A rede pendente respeita o abort; uma resposta liberada depois não cobra novamente.
    const transport = vi.fn<typeof fetch>(async (_u, init) => {
      await Promise.race([late, new Promise<never>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      })]);
      return reply(init);
    });
    const runtime = make(budget, transport, { CONVERSATION_MODEL_TIMEOUT_MS: '1000' });
    const op = await send(runtime, 1, principal, 10);
    expect(op).toMatchObject({ status: 'FAILED' });
    const tokensAfterTimeout = budget.summary().global.tokens;
    expect(budget.summary().global.calls).toBe(1);
    expect(tokensAfterTimeout).toBeGreaterThan(REPORTED); // reserva = estimativa + maxOutputTokens
    release(); await new Promise(r => setTimeout(r, 30));
    expect(budget.summary().global.tokens).toBe(tokensAfterTimeout);
    expect(metrics.counter('model_tokens_total', { kind: 'reserved_unreported' })).toBe(tokensAfterTimeout);
  }, 10_000);

  it('concorrência: duas conversas simultâneas com teto global de 1 chamada ⇒ exatamente uma chega ao Gemini', async () => {
    const budget = new SpendBudget({ maxCallsGlobal: 1 });
    const transport = vi.fn<typeof fetch>(async (_u, init) => reply(init));
    const runtime = make(budget, transport);
    const other = { ...principal, organizerId: '222222222', conversationId: '222222222' };
    const results = await Promise.all([send(runtime, 1), send(runtime, 1, other)]);
    expect(results.map(r => r.status)).toEqual(['FAILED', 'FAILED']); // uma chamada não cobre roteador + planejador
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('reinício: orçamento novo zera (não é limite persistente), conversa continua do SQLite', async () => {
    const transport = vi.fn<typeof fetch>(async (_u, init) => reply(init));
    const first = make(new SpendBudget({ maxCallsPerConversation: 2 }), transport);
    expect((await send(first, 1)).status).toBe('SUCCEEDED');
    first.stop(); runtimes.splice(0);
    const fresh = new SpendBudget({ maxCallsPerConversation: 2 });
    const second = make(fresh, transport);
    expect(fresh.summary().global.calls).toBe(0);
    expect((await send(second, 2)).status).toBe('SUCCEEDED');
    expect(second.store.snapshot(principal).version).toBe(2);
  });

  it('status mostra o orçamento da montagem, correlationId e compra desligada; logs sem chave nem texto do usuário', async () => {
    const budget = new SpendBudget();
    const env = setup({ conversationRuntime: { dbFile: dir.file, botId: principal.botId }, conversationModel: loadConfig(environment).conversationModel! });
    const transport = vi.fn<typeof fetch>(async (_u, init) => reply(init));
    const runtime = createConversationRuntime(env.cfg, env.links, transport, budget)!;
    runtimes.push(runtime);
    const app = createApp({ config: env.cfg, links: env.links, conversations: runtime, budget });
    const headers = { authorization: `Bearer ${BOT_TOKEN}`, 'x-telegram-user-id': ORG_A, 'x-telegram-chat-id': ORG_A, 'content-type': 'application/json' };
    const base = `/api/bot/v1/conversations/${ORG_A}`;
    const message = event(); message.conversationId = ORG_A; message.source.conversationId = ORG_A;
    message.input = { kind: 'TEXT', text: 'Somos Ana, alérgica a amendoim' };
    const accepted = await app.request(`${base}/events`, { method: 'POST', headers, body: JSON.stringify(message) });
    expect(accepted.status).toBe(202);
    expect(accepted.headers.get('x-correlation-id')).toMatch(/^[A-Za-z0-9_-]{16}$/);
    const { operationId } = await accepted.json();
    for (let i = 0; i < 80; i++) {
      runtime.tick(); await flush();
      const op = await (await app.request(`${base}/operations/${operationId}`, { headers })).json();
      if (!['ACCEPTED', 'RUNNING'].includes(op.status)) { expect(op.status).toBe('SUCCEEDED'); break; }
      await new Promise(r => setTimeout(r, 2));
    }
    const st = await (await app.request('/api/ops/status', { headers })).json();
    expect(st.conversation.budget.global).toMatchObject({ calls: 2, tokens: REPORTED });
    expect(st.purchase).toMatchObject({ capable: false, submission: 'DISABLED' });
    for (const call of transport.mock.calls) expect(String(call[0])).toMatch(/^https:\/\/generativelanguage\.googleapis\.com\//);
    const all = lines.map(line => {
      const record = JSON.parse(line);
      // Correlação aleatória pode conter "Ana" por acaso; só o campo cid é excluído da busca de conteúdo.
      if (record.cid !== undefined) expect(record.cid).toMatch(/^[A-Za-z0-9_-]{16}$/);
      delete record.cid;
      return JSON.stringify(record);
    }).join('\n');
    expect(all).not.toContain(KEY);
    expect(all).not.toMatch(/Ana|amendoim/);
    expect(all).toContain('turns.operation_finished');
  });
});
