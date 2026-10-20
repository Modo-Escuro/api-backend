// Regressões do transporte compartilhado AI-01. Provedor inteiramente sintético.
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createGeminiJsonModel, GEMINI_MODEL, type GeminiOptions, type GeminiUsage } from '../../src/server/ai/gemini';
import { loadConfig } from '../../src/server/config';
import { createConversationRuntime } from '../../src/server/conversation-runtime';
import { geminiReply } from '../helpers/gemini';
import { event, principal, temporary } from '../turns/helpers';

const schema = z.object({ message: z.string() }).strict();
const model = (options: Partial<GeminiOptions> = {}) => createGeminiJsonModel({ apiKey: 'synthetic-key', maxRequests: 100, ...options }, {
  prompt: 'Retorne uma mensagem JSON.', schema, project: (input: { message: string }) => ({ message: input.message }),
});
const request = (scope = 'private-scope') => ({ input: { message: 'Quero pizza.' }, signal: new AbortController().signal, maxOutputTokens: 2048, budgetScope: scope });
const ok = () => vi.fn<typeof fetch>(async () => geminiReply({ message: 'Certo.' }));

describe('Gemini: transporte, limites e isolamento', () => {
  it('endpoint fixo, sem tools/segredos/metadados extras; sem redirect nem retry', async () => {
    const transport = vi.fn<typeof fetch>(async (url, init) => {
      expect(String(url)).toBe(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`);
      const body = JSON.parse(String(init?.body));
      expect(body.tools).toBeUndefined();
      expect(body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'low', includeThoughts: false });
      expect(String(init?.body)).not.toMatch(/private-scope|synthetic-key|PRIVATE_EXTRA/);
      expect(init?.redirect).toBe('error');
      return geminiReply({ message: 'Certo.' });
    });
    const req = request(); Object.assign(req.input, { secret: 'PRIVATE_EXTRA' });
    expect(await model({ fetch: transport }).propose(req)).toEqual({ message: 'Certo.' });
    expect(transport).toHaveBeenCalledOnce();
  });

  it('limites por processo/conversa e concorrência são aplicados antes da rede', async () => {
    const transport = ok();
    const m = model({ fetch: transport, maxRequests: 3, maxRequestsPerConversation: 2 });
    await m.propose(request('A')); await m.propose(request('A'));
    await expect(m.propose(request('A'))).rejects.toThrow('BUDGET');
    const concurrent = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => m.propose(request(`B${i}`))));
    expect(concurrent.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(transport).toHaveBeenCalledTimes(3);
  });

  it.each([{ maxRequests: 0 }, { maxRequests: 100001 }, { maxRequestsPerConversation: 0 }, { timeoutMs: 999 }, { budgetMicroUsd: 0 }])('configuração inválida falha fechada: %j', bad => {
    expect(() => model(bad)).toThrow('CONFIGURATION');
  });

  it('chave, gasto, entrada grande e cancelamento são recusados antes da rede', async () => {
    const transport = ok();
    expect(() => model({ apiKey: 'bad key' })).toThrow('KEY_MISSING');
    await expect(model({ fetch: transport, budgetMicroUsd: 1 }).propose(request())).rejects.toThrow('BUDGET');
    await expect(model({ fetch: transport }).propose({ ...request(), input: { message: 'x'.repeat(9000) } })).rejects.toThrow('INPUT_LIMIT');
    await expect(model({ fetch: transport }).propose({ ...request(), signal: AbortSignal.abort() })).rejects.toThrow('TIMEOUT');
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([401, 403, 429, 503])('HTTP %s não repete e não expõe corpo privado', async status => {
    const transport = vi.fn<typeof fetch>(async () => new Response('PRIVATE_RESPONSE synthetic-key', { status }));
    const error = await model({ fetch: transport }).propose(request()).catch(e => e);
    expect(error.code).toBe(status === 429 ? 'QUOTA' : status === 503 ? 'UNAVAILABLE' : 'AUTH');
    expect(JSON.stringify(error)).not.toMatch(/PRIVATE_RESPONSE|synthetic-key/);
    expect(transport).toHaveBeenCalledOnce();
  });

  it('truncamento por raciocínio cobra uso reportado e não divulga o JSON cortado', async () => {
    const usage: GeminiUsage[] = [];
    const transport = vi.fn<typeof fetch>(async () => Response.json({
      candidates: [{ content: { role: 'model', parts: [{ text: '{"message":"PRIVATE_CUT' }] }, finishReason: 'MAX_TOKENS' }],
      modelVersion: GEMINI_MODEL, usageMetadata: { promptTokenCount: 797, candidatesTokenCount: 18, thoughtsTokenCount: 767, totalTokenCount: 1582 },
    }));
    const error = await model({ fetch: transport, onUsage: u => usage.push(u) }).propose(request()).catch(e => e);
    expect(error).toMatchObject({ code: 'INVALID_OUTPUT', detail: 'FINISH_LENGTH:PARSE' });
    expect(usage).toEqual([{ inputTokens: 797, outputTokens: 785, chargedMicroUsd: Math.ceil(797 * .75 + 785 * 3.75), modelVersion: GEMINI_MODEL }]);
    expect(JSON.stringify(error)).not.toContain('PRIVATE_CUT');
  });

  it('schema inválido e campo de confirmação humano são rejeitados; reserva é ajustada pelo uso', async () => {
    const usage: GeminiUsage[] = [];
    await expect(model({ fetch: async () => geminiReply({ message: 'Certo.', humanConfirmed: true }), onUsage: u => usage.push(u) }).propose(request()))
      .rejects.toMatchObject({ code: 'INVALID_OUTPUT', detail: 'FINISH_STOP:SCHEMA' });
    expect(usage[0]?.chargedMicroUsd).toBe(750);
  });

  it('modelVersion só aceita formato seguro', async () => {
    const seen: (string | null)[] = [];
    for (const version of ['gemini-3.8-flash-001', 'x\n<script>', 42]) {
      await model({ fetch: async () => Response.json({ ...await geminiReply({ message: 'Certo.' }).json(), modelVersion: version }),
        onUsage: u => seen.push(u.modelVersion) }).propose(request());
    }
    expect(seen).toEqual(['gemini-3.8-flash-001', null, null]);
  });

  it('resposta maior que 64 KiB é interrompida sem ler todo o corpo', async () => {
    let served = 0;
    const transport: typeof fetch = async () => new Response(new ReadableStream<Uint8Array>({ pull(c) {
      served += 16384; c.enqueue(new Uint8Array(16384).fill(97));
    } }), { headers: { 'content-type': 'application/json' } });
    await expect(model({ fetch: transport }).propose(request())).rejects.toThrow('INVALID_OUTPUT');
    expect(served).toBeLessThan(256 * 1024);
  });

  it('falha de rede não expõe exceção do provedor', async () => {
    const error = await model({ fetch: async () => { throw new TypeError('synthetic-key PRIVATE_NETWORK'); } }).propose(request()).catch(e => e);
    expect(error.code).toBe('UNAVAILABLE');
    expect(JSON.stringify(error)).not.toMatch(/synthetic-key|PRIVATE_NETWORK/);
  });
});

describe('montagem única do assistente', () => {
  it('opt-in continua separado; chave incidental não instala processador', () => {
    const status = vi.fn(), withOperational = vi.fn();
    expect(createConversationRuntime(loadConfig({ GEMINI_API_KEY: 'synthetic-key' }), { status, withOperational })).toBeUndefined();
    const dir = temporary();
    const runtime = createConversationRuntime(loadConfig({ CONVERSATION_RUNTIME_ENABLED: 'true', CONVERSATION_DB_FILE: dir.file, BOT_TELEGRAM_ID: principal.botId }), { status, withOperational })!;
    try { expect(() => runtime.accept(principal, event())).toThrow(); }
    finally { runtime.stop(); dir.clean(); }
    expect(status).not.toHaveBeenCalled();
  });
  it.each([{ IFOOD_CART_ENABLED: 'true' }, { DEV_GLOBAL_SESSION: 'true' }, { CONVERSATION_AGENT_MODE: 'structured' }, { CONVERSATION_ACCOUNT_GROUPS_ENABLED: 'true' }])('não reativa interface retirada: %j', env => {
    expect(() => loadConfig(env)).toThrow(/retirad/);
  });
});
