// AI-01: adaptador Gemini (origem #35, Maylon) consolidado com limites configuráveis (#36, kujojorin). Rede sintética.
import { describe, expect, it, vi } from 'vitest';
import { AgentProposalSchema } from '../../src/server/agent/model';
import { DEMO_CORPUS, demoInput, scoreDemo } from '../../src/server/agent/demo-corpus';
import { GEMINI_MODEL, createGeminiModel, geminiWireSchema } from '../../src/server/agent/gemini-model';
import { createAgentProcessor } from '../../src/server/agent/processor';
import { TurnRuntime } from '../../src/server/turns/runtime';
import { TurnStore } from '../../src/server/turns/store';
import { event, flush, principal, temporary } from '../turns/helpers';
import { geminiReply } from '../helpers/gemini';

const URL_OK = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const request = (scope = 'private-local-scope') => ({ input: demoInput(), signal: new AbortController().signal, maxOutputTokens: 800, budgetScope: scope });
const ok = () => vi.fn<typeof globalThis.fetch>(async () => geminiReply({ actions: [{ action: 'SET_PRIORITY', value: 'SPEED' }] }));

describe('AI-01: Gemini no contrato de ações AI-02', () => {
  it('corpus curto consistente (inclui GRP-01); alteração perigosa nunca pontua', () => {
    expect(DEMO_CORPUS).toHaveLength(18);
    for (const c of DEMO_CORPUS) for (const p of c.expected) {
      expect(AgentProposalSchema.safeParse(p).success).toBe(true);
      expect(scoreDemo(c, p)).toBe(true);
    }
    const c = DEMO_CORPUS.find((x) => x.id === 'preserve-allergy')!;
    expect(scoreDemo(c, { actions: [{ action: 'SET_NO_RESTRICTIONS', participant: { name: 'P2' } }] })).toBe(false);
    expect(JSON.stringify(geminiWireSchema())).toContain('SUGGEST_PROPOSALS');
  });

  it('endpoint fixo, sem tools, sem segredos/metadados no corpo; thinking baixo; sem redirect', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      expect(String(url)).toBe(URL_OK);
      const body = JSON.parse(String(init?.body));
      expect(body.tools).toBeUndefined();
      expect(body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'low', includeThoughts: false });
      expect(String(init?.body)).not.toMatch(/private-local-scope|synthetic-key|PRIVATE_EXTRA/);
      expect(init?.redirect).toBe('error');
      return geminiReply({ actions: [{ action: 'SET_PRIORITY', value: 'SPEED' }] });
    });
    const model = createGeminiModel({ apiKey: 'synthetic-key', fetch, maxRequests: 5 });
    const req = request();
    Object.assign(req.input, { secret: 'PRIVATE_EXTRA' });
    expect(await model.propose(req)).toEqual({ actions: [{ action: 'SET_PRIORITY', value: 'SPEED' }] });
  });

  it('limites vêm da configuração: por processo e por conversa (sem teto fixo 20/12)', async () => {
    const fetch = ok();
    const model = createGeminiModel({ apiKey: 'synthetic-key', fetch, maxRequests: 30, maxRequestsPerConversation: 25 });
    for (let i = 0; i < 25; i++) await model.propose(request('conversa-A'));
    await expect(model.propose(request('conversa-A'))).rejects.toThrow('BUDGET'); // 26ª na mesma conversa
    for (let i = 0; i < 5; i++) await model.propose(request('conversa-B'));
    await expect(model.propose(request('conversa-C'))).rejects.toThrow('BUDGET'); // 31ª no processo
    expect(fetch).toHaveBeenCalledTimes(30);
  });

  it('configuração fora dos tetos de segurança falha fechada', () => {
    for (const bad of [{ maxRequests: 0 }, { maxRequests: 100_001 }, { maxRequests: 1.5 }, { maxRequestsPerConversation: 0 },
      { budgetMicroUsd: 0 }, { budgetMicroUsd: 50_000_001 }, { timeoutMs: 999 }]) {
      expect(() => createGeminiModel({ apiKey: 'synthetic-key', maxRequests: 10, ...bad })).toThrow('CONFIGURATION');
    }
    expect(() => createGeminiModel({ apiKey: 'bad key', maxRequests: 10 })).toThrow('KEY_MISSING');
  });

  it('reserva de gasto, entrada grande, cancelamento, saída inválida e campos humanos falham fechados', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => geminiReply({ actions: [], humanConfirmed: true }));
    await expect(createGeminiModel({ apiKey: 'synthetic-key', fetch, maxRequests: 5, budgetMicroUsd: 1 }).propose(request())).rejects.toThrow('BUDGET');
    expect(fetch).not.toHaveBeenCalled();
    const huge = request();
    huge.input.message = 'x'.repeat(9000);
    await expect(createGeminiModel({ apiKey: 'synthetic-key', fetch, maxRequests: 5 }).propose(huge)).rejects.toThrow('INPUT_LIMIT');
    const abort = new AbortController();
    abort.abort();
    await expect(createGeminiModel({ apiKey: 'synthetic-key', fetch, maxRequests: 5 }).propose({ ...request(), signal: abort.signal })).rejects.toThrow('TIMEOUT');
    await expect(createGeminiModel({ apiKey: 'synthetic-key', fetch, maxRequests: 5 }).propose(request())).rejects.toThrow('INVALID_OUTPUT');
  });

  it('resposta truncada (MAX_TOKENS) e ação fora de allowedActions viram INVALID_OUTPUT', async () => {
    const truncated = vi.fn<typeof globalThis.fetch>(async () => geminiReply({ actions: [] }, 'MAX_TOKENS'));
    await expect(createGeminiModel({ apiKey: 'synthetic-key', fetch: truncated, maxRequests: 5 }).propose(request())).rejects.toThrow('INVALID_OUTPUT');
    const notAllowed = vi.fn<typeof globalThis.fetch>(async () => geminiReply({ actions: [{ action: 'CLOSE_PURCHASE' }] }));
    const req = request();
    req.input.allowedActions = req.input.allowedActions.filter((a) => a !== 'CLOSE_PURCHASE');
    await expect(createGeminiModel({ apiKey: 'synthetic-key', fetch: notAllowed, maxRequests: 5 }).propose(req)).rejects.toThrow('INVALID_OUTPUT');
  });

  it.each([401, 403, 429, 503])('HTTP %s sem retry nem detalhes privados', async (status) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response('PRIVATE_RESPONSE synthetic-key', { status }));
    const err = await createGeminiModel({ apiKey: 'synthetic-key', fetch, maxRequests: 5 }).propose(request()).catch((e: Error) => e);
    expect((err as Error).message).toBe(status === 429 ? 'QUOTA' : status === 503 ? 'UNAVAILABLE' : 'AUTH');
    expect(JSON.stringify(err)).not.toMatch(/PRIVATE_RESPONSE|synthetic-key/);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('proposta real passa por AI-02/RUN-01/DATA-01; cota preserva o estado e depois recupera; nada privado no log', async () => {
    const dir = temporary();
    const store = new TurnStore(dir.file);
    let down = false;
    const fetch = vi.fn<typeof globalThis.fetch>(async () => down ? new Response('PRIVATE_QUOTA_BODY', { status: 429 })
      : geminiReply({ actions: [{ action: 'ADD_PARTICIPANT', name: 'P1' }] }));
    const processor = createAgentProcessor({ model: createGeminiModel({ apiKey: 'synthetic-key', fetch, maxRequests: 10 }), linkOf: async () => null, timeoutMs: 10_000, maxOutputTokens: 800 });
    const runtime = new TurnRuntime(store, { processor });
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const send = async (n: number, version: number) => {
      const accepted = runtime.accept(principal, event(n, version));
      for (let i = 0; i < 80; i++) {
        runtime.tick(); await flush();
        const op = store.operation(principal, accepted.operation.operationId);
        if (!['ACCEPTED', 'RUNNING'].includes(op.status)) return op;
        await new Promise((r) => setTimeout(r, 5));
      }
      throw new Error('operação não terminou');
    };
    try {
      expect(await send(1, 0)).toMatchObject({ status: 'SUCCEEDED', resultVersion: 1, snapshot: { phase: 'COLLECTING', humanApproval: null } });
      const before = structuredClone(store.snapshot(principal));
      down = true;
      expect(await send(2, 1)).toMatchObject({ status: 'FAILED', error: { code: 'UNAVAILABLE' } });
      expect(store.snapshot(principal)).toEqual(before);
      down = false;
      expect(await send(3, 1)).toMatchObject({ status: 'SUCCEEDED', resultVersion: 2 });
      expect(String(err.mock.calls)).not.toMatch(/PRIVATE_QUOTA|synthetic-key|900001|111111111/);
    } finally { runtime.stop(); dir.clean(); err.mockRestore(); }
  });

  it('auditoria: resposta acima de 64 KB é descartada sem ler o corpo inteiro', async () => {
    let served = 0;
    const big = () => new ReadableStream<Uint8Array>({ pull(c) { if (served > 20 * 1024 * 1024) { c.close(); return; } const chunk = new Uint8Array(16 * 1024).fill(97); served += chunk.byteLength; c.enqueue(chunk); } });
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(big(), { status: 200, headers: { 'content-type': 'application/json' } }));
    await expect(createGeminiModel({ apiKey: 'synthetic-key', fetch, maxRequests: 5 }).propose(request())).rejects.toThrow('INVALID_OUTPUT');
    expect(served).toBeLessThan(256 * 1024);
    const errBody = vi.fn<typeof globalThis.fetch>(async () => new Response('x'.repeat(70 * 1024), { status: 400 }));
    await expect(createGeminiModel({ apiKey: 'synthetic-key', fetch: errBody, maxRequests: 5 }).propose(request())).rejects.toThrow('INVALID_OUTPUT');
  });

  it('auditoria: falha de rede vira UNAVAILABLE, sem detalhes', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => { throw new TypeError('fetch failed synthetic-key'); });
    const err = await createGeminiModel({ apiKey: 'synthetic-key', fetch, maxRequests: 5 }).propose(request()).catch((e: Error) => e);
    expect((err as Error).message).toBe('UNAVAILABLE');
    expect(JSON.stringify(err)).not.toContain('synthetic-key');
  });

  it('auditoria: limites valem sob concorrência (checagem e reserva síncronas)', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => { await new Promise((r) => setTimeout(r, 5)); return geminiReply({ actions: [] }); });
    const model = createGeminiModel({ apiKey: 'synthetic-key', fetch, maxRequests: 3, maxRequestsPerConversation: 1000 });
    const results = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => model.propose(request(`c${i}`))));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    expect(fetch).toHaveBeenCalledTimes(3);
    const perConv = createGeminiModel({ apiKey: 'synthetic-key', fetch: vi.fn<typeof globalThis.fetch>(async () => geminiReply({ actions: [] })), maxRequests: 100, maxRequestsPerConversation: 2 });
    const same = await Promise.allSettled(Array.from({ length: 6 }, () => perConv.propose(request('mesma'))));
    expect(same.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
  });
});
