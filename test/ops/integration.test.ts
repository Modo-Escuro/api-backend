// OPS-02 ponta a ponta offline: agente determinístico + RUN-01/DATA-01 em SQLite real + rotas HTTP reais.
// Sem MCP real, sem modelo real, sem compra. Valores sensíveis são sintéticos.
import { readdirSync, readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/server/app';
import { DeterministicModel } from '../../src/server/agent/mock-model';
import type { ConversationModel, ModelRequest } from '../../src/server/agent/model';
import { createAgentProcessor } from '../../src/server/agent/processor';
import { loadConfig } from '../../src/server/config';
import type { ConversationEvent } from '../../src/server/contracts/conversation';
import { SpendBudget } from '../../src/server/ops/budget';
import { setLogSink } from '../../src/server/ops/log';
import { metrics } from '../../src/server/ops/metrics';
import { TurnRuntime } from '../../src/server/turns/runtime';
import { TurnStore } from '../../src/server/turns/store';
import { flush, principal, temporary } from '../turns/helpers';
import { SENSITIVE } from './sensitive';

const TOKEN = 'synthetic-only-ops02-xxxxxxxxxxxxxxxxxxxx';
const ORG = principal.organizerId;
const base = `/api/bot/v1/conversations/${ORG}`;
const headers = (org = ORG) => ({ authorization: `Bearer ${TOKEN}`, 'x-telegram-user-id': org,
  'x-telegram-chat-id': org, 'content-type': 'application/json' });
const PRIVATE_TEXT = `Somos Ana e Bia. Ana é alérgica a amendoim. Teto de R$ 180. Entregar na ${SENSITIVE[7]}, ` +
  `email ${SENSITIVE[0]}, telefone ${SENSITIVE[1]}, cartão ${SENSITIVE[5]}, cpf ${SENSITIVE[3]}.`;

function msg(n: number, text: string, expectedVersion: number, org = ORG): ConversationEvent {
  return { contractVersion: '1.0', eventId: `tg-update-${n}`, conversationId: org, expectedVersion,
    source: { channel: 'TELEGRAM', botId: principal.botId, conversationId: org, kind: 'MESSAGE', messageId: String(n) },
    input: { kind: 'TEXT', text } };
}

/** Modelo determinístico que reporta uso, como um provedor real faria. */
class UsageModel implements ConversationModel {
  readonly id = 'usage';
  private inner = new DeterministicModel();
  async propose(r: ModelRequest) {
    r.reportUsage?.({ inputTokens: 100, outputTokens: 50 });
    return this.inner.propose(r);
  }
}

describe('OPS-02 integrado (offline)', () => {
  const cleanup: (() => void)[] = [];
  const lines: string[] = [];
  let consoleText: string[];
  beforeEach(() => {
    metrics.reset();
    setLogSink((_, line) => lines.push(line));
    consoleText = [];
    for (const m of ['log', 'warn', 'error', 'info'] as const) {
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => { consoleText.push(args.map(String).join(' ')); });
    }
  });
  afterEach(() => { cleanup.splice(0).forEach((f) => f()); setLogSink(); lines.length = 0; vi.restoreAllMocks(); });

  function env(opts: { budget?: SpendBudget; extraEnv?: Record<string, string>; model?: ConversationModel } = {}) {
    const dir = temporary();
    const config = loadConfig({ BOT_API_TOKEN: TOKEN, ALLOWED_ORGANIZER_IDS: `${ORG},222222222`, IFOOD_LINKS_DIR: dir.dir,
      CONVERSATION_RUNTIME_ENABLED: 'true', BOT_TELEGRAM_ID: principal.botId, CONVERSATION_DB_FILE: dir.file, ...opts.extraEnv });
    const store = new TurnStore(dir.file);
    const processor = createAgentProcessor({ model: opts.model ?? new UsageModel(), linkOf: async () => null, timeoutMs: 2_000, budget: opts.budget });
    const runtime = new TurnRuntime(store, { processor });
    const app = createApp(undefined, { config, conversations: runtime, budget: opts.budget });
    cleanup.push(() => { try { runtime.stop(); } catch { /* já parado */ } dir.clean(); });
    let n = 0;
    const send = async (text: string, org = ORG) => {
      const snap = await app.request(`/api/bot/v1/conversations/${org}`, { headers: headers(org) });
      const version = snap.status === 200 ? (await snap.json()).version : 0;
      const r = await app.request(`/api/bot/v1/conversations/${org}/events`, { method: 'POST', headers: headers(org), body: JSON.stringify(msg(++n, text, version, org)) });
      if (r.status !== 202) return { status: r.status, body: await r.json() };
      const op = await r.json();
      for (let i = 0; i < 50; i++) {
        runtime.tick(); await flush();
        const g = await app.request(`/api/bot/v1/conversations/${org}/operations/${op.operationId}`, { headers: headers(org) });
        const body = await g.json();
        if (!['ACCEPTED', 'RUNNING'].includes(body.status)) return { status: g.status, body };
        await new Promise((res) => setTimeout(res, 5));
      }
      throw new Error('operação não terminou');
    };
    return { app, store, runtime, send, dir, config };
  }

  it('logs e métricas de um fluxo com mensagem privada não contêm texto, PII, identidade nem credencial', async () => {
    const e = env();
    const r = await e.send(PRIVATE_TEXT);
    expect(r.body).toMatchObject({ status: 'SUCCEEDED' });
    const status = await e.app.request('/api/ops/status', { headers: headers() });
    const everything = [...lines, ...consoleText, JSON.stringify(await status.json())].join('\n');
    expect(lines.some((l) => JSON.parse(l).event === 'http.request')).toBe(true);
    expect(lines.some((l) => JSON.parse(l).event === 'turns.operation_finished')).toBe(true);
    for (const forbidden of [...SENSITIVE.slice(0, 8), 'Ana', 'amendoim', TOKEN, ORG, e.dir.dir, 'tg-update-1']) {
      expect(everything).not.toContain(forbidden);
    }
    expect(metrics.counter('model_tokens_total', { kind: 'input' })).toBe(100);
    expect(metrics.counter('turn_operations_total', { outcome: 'SUCCEEDED' })).toBe(1);
    // Correlação opaca ecoada ao bot e presente na linha de log.
    const res = await e.app.request('/api/health');
    const cid = res.headers.get('x-correlation-id')!;
    expect(cid).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(lines.some((l) => JSON.parse(l).cid === cid)).toBe(true);
  });

  it('estouro do orçamento é parada clara (LIMIT_EXCEEDED) e o estado continua recuperável', async () => {
    let t = 0;
    const budget = new SpendBudget({ maxCallsPerConversation: 1, windowMs: 60_000 }, () => t);
    const e = env({ budget });
    expect((await e.send('Somos Ana e Bia.')).body).toMatchObject({ status: 'SUCCEEDED', resultVersion: 1 });
    const before = e.store.snapshot(principal);
    const denied = await e.send('Adiciona Caio.');
    expect(denied.body).toMatchObject({ status: 'FAILED', error: { code: 'LIMIT_EXCEEDED' } });
    expect(e.store.snapshot(principal)).toEqual(before); // versão e conteúdo intactos
    expect(metrics.counter('agent_budget_exceeded_total', { kind: 'CONVERSATION_CALLS' })).toBe(1);
    expect(lines.some((l) => JSON.parse(l).event === 'agent.budget_exceeded')).toBe(true);
    // Outra conversa não é afetada; após a janela, a mesma conversa retoma da versão preservada.
    expect((await e.send('Somos Davi.', '222222222')).body).toMatchObject({ status: 'SUCCEEDED' });
    t = 60_000;
    expect((await e.send('Adiciona Caio.')).body).toMatchObject({ status: 'SUCCEEDED', resultVersion: 2 });
  });

  it('status separa HTTP, sessão operacional, conversa e capacidade de compra; flags isoladas não habilitam envio', async () => {
    const e = env({ extraEnv: { IFOOD_CART_ENABLED: 'true', IFOOD_SUBMIT_ENABLED: 'true' } });
    expect((await e.app.request('/api/ops/status')).status).toBe(401);
    const r = await e.app.request('/api/ops/status', { headers: headers() });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.http).toEqual({ ok: true });
    expect(body.sessions).toEqual({ confirmed: 0, operational: 0, unavailable: 0, reconnectRequired: 0, unverified: 0 });
    expect(body.conversation).toMatchObject({ enabled: true, rollout: { mode: 'ALL_AUTHORIZED' },
      runtime: { accepting: true, processorInstalled: true, storage: 'OK', resultUnknown: 0 } });
    expect(body.purchase).toEqual({ capable: false, cartPreparation: 'LEGACY_FLAG_ON', submission: 'DISABLED',
      submitFlagIgnored: true, reason: 'DEC01_D8_READ_ONLY' });
    expect(['PRIVATE', 'UNVERIFIED_PLATFORM']).toContain(body.conversation.storagePermissions.state);
    // Health HTTP continua 200 mesmo com runtime parado; o status operacional mostra a diferença.
    e.runtime.stop();
    expect((await e.app.request('/api/health')).status).toBe(200);
    const after = await (await e.app.request('/api/ops/status', { headers: headers() })).json();
    expect(after.conversation.runtime).toMatchObject({ accepting: false, healthy: false, storage: 'CLOSED' });
  });

  it('liberação gradual por organizador: fora da lista recebe UNAVAILABLE sem revelar a lista', async () => {
    const e = env({ extraEnv: { CONVERSATION_ORGANIZER_IDS: ORG } });
    expect((await e.send('Somos Ana.')).body).toMatchObject({ status: 'SUCCEEDED' });
    const other = await e.app.request('/api/bot/v1/conversations/222222222', { headers: headers('222222222') });
    expect(other.status).toBe(503);
    expect(await other.json()).toMatchObject({ error: { code: 'UNAVAILABLE' } });
    // Organizador fora de ALLOWED_ORGANIZER_IDS continua barrado pela autenticação (rollout só restringe).
    const e2 = env({ extraEnv: { CONVERSATION_ORGANIZER_IDS: '333333333' } });
    expect((await e2.app.request('/api/bot/v1/conversations/333333333', { headers: headers('333333333') })).status).toBe(403);
  });

  it('rollback (desligar a conversa) não apaga vínculos, compra nem resultado desconhecido', async () => {
    const e = env();
    expect((await e.send('Somos Ana e Bia.')).body).toMatchObject({ status: 'SUCCEEDED' });
    // Resultado desconhecido sintético (primitiva defensiva da RUN-01; nenhuma escrita externa ocorre).
    e.store.accept(principal, msg(90, 'sintético', 1));
    const job = e.store.claim('ops02-test')!;
    e.store.beginExternalEffect(job, () => {});
    e.store.fail(job, 'INTERNAL');
    const linksBefore = readdirSync(e.dir.dir).filter((f) => !f.startsWith('turns.sqlite')).map((f) => [f, readFileSync(`${e.dir.dir}/${f}`)]);
    const snapshot = e.store.snapshot(principal);
    e.runtime.stop();

    // Rollback: mesma config sem a flag de conversa ⇒ rotas v1 indisponíveis, nada é migrado ou apagado.
    const rolled = createApp(undefined, { config: { ...e.config, conversationRuntime: undefined } });
    expect((await rolled.request(base, { headers: headers() })).status).toBe(503);
    expect(readdirSync(e.dir.dir).filter((f) => !f.startsWith('turns.sqlite')).map((f) => [f, readFileSync(`${e.dir.dir}/${f}`)])).toEqual(linksBefore);

    // Reativar: o mesmo banco reabre com compra, versão e RESULT_UNKNOWN preservados.
    const reopened = new TurnStore(e.dir.file);
    try {
      expect(reopened.snapshot(principal)).toEqual(snapshot);
      expect(reopened.operation(principal, job.operation.operationId)).toMatchObject({ status: 'RESULT_UNKNOWN' });
      expect(reopened.stats()).toMatchObject({ resultUnknown: 1, activePurchases: 1 });
    } finally { reopened.close(); }
  });

  it('erro interno devolve mensagem fixa com correlação; a exceção não chega ao log nem à resposta', async () => {
    const e = env();
    e.app.get('/api/ops-test-boom', () => { throw new Error(`falha com ${SENSITIVE[7]} e ${SENSITIVE[0]}`); });
    const r = await e.app.request('/api/ops-test-boom');
    expect(r.status).toBe(500);
    const body = await r.json();
    expect(body).toEqual({ error: { kind: 'INTERNAL', message: 'Erro interno', correlationId: r.headers.get('x-correlation-id') } });
    const text = [...lines, ...consoleText].join('\n');
    expect(text).not.toContain('Flores');
    expect(text).not.toContain('example.com');
    expect(lines.some((l) => JSON.parse(l).event === 'http.unhandled_error')).toBe(true);
  });
});
