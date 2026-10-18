// AI-01: regressões da validação com Gemini real (18/10/2026). Rede, OAuth e MCP sintéticos.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/server/config';
import { createConversationRuntime } from '../../src/server/conversation-runtime';
import { GEMINI_BOUNDS, GEMINI_MODEL, createGeminiModel, type GeminiUsage } from '../../src/server/agent/gemini-model';
import { demoInput } from '../../src/server/agent/demo-corpus';
import type { Operation } from '../../src/server/contracts/conversation';
import { ORG_A, ORG_B, connectAndConfirm, setup } from '../helpers/fakes';
import { event, flush, principal, temporary } from '../turns/helpers';
import { geminiReply } from '../helpers/gemini';

const request = () => ({ input: demoInput(), signal: new AbortController().signal, maxOutputTokens: 2048, budgetScope: 's' });
/** Resposta no formato real observado quando o raciocínio esgota o teto: MAX_TOKENS, JSON cortado, thoughtsTokenCount. */
const truncatedByThinking = () => Response.json({
  candidates: [{ content: { role: 'model', parts: [{ text: '{\n  "actions": [\n    {\n      "action": "ADD_' }] }, finishReason: 'MAX_TOKENS' }],
  modelVersion: GEMINI_MODEL, usageMetadata: { promptTokenCount: 797, candidatesTokenCount: 18, thoughtsTokenCount: 767, totalTokenCount: 1582 } });
const price = (input: number, output: number) => Math.ceil(input * 0.75 + output * 3.75);

describe('AI-01: adaptador Gemini — truncamento, uso e versão', () => {
  it('padrões comportam o raciocínio observado (até ~1.500 tokens) e a cauda de latência', () => {
    expect(GEMINI_BOUNDS.maxOutputTokens.default).toBeGreaterThanOrEqual(2048);
    expect(GEMINI_BOUNDS.timeoutMs.default).toBeGreaterThanOrEqual(15_000);
    const cfg = loadConfig({ CONVERSATION_RUNTIME_ENABLED: 'true', BOT_TELEGRAM_ID: principal.botId, CONVERSATION_DB_FILE: '.conversations/test.sqlite',
      BOT_API_TOKEN: 'synthetic-token-xxxxxxxxxxxxxxxxxxxxxx', ALLOWED_ORGANIZER_IDS: principal.organizerId, CONVERSATION_MODEL_ENABLED: 'true',
      CONVERSATION_MODEL_PROVIDER: 'google', CONVERSATION_MODEL: GEMINI_MODEL, GEMINI_API_KEY: 'synthetic-key', CONVERSATION_MODEL_MAX_REQUESTS: '3' });
    expect(cfg.conversationModel).toMatchObject({ maxOutputTokens: 2048, timeoutMs: 15_000 });
  });

  it('raciocínio que esgota o teto vira INVALID_OUTPUT:FINISH_LENGTH:PARSE e cobra só os tokens reportados', async () => {
    const usage: GeminiUsage[] = [];
    const model = createGeminiModel({ apiKey: 'synthetic-key', fetch: vi.fn<typeof fetch>(async () => truncatedByThinking()), maxRequests: 5, onUsage: (u) => usage.push(u) });
    const err = await model.propose(request()).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'INVALID_OUTPUT', detail: 'FINISH_LENGTH:PARSE' });
    expect(usage).toEqual([{ inputTokens: 797, outputTokens: 785, chargedMicroUsd: price(797, 785), modelVersion: GEMINI_MODEL }]);
    expect(JSON.stringify(err)).not.toContain('ADD_');
  });

  it('JSON fora do schema vira :SCHEMA e também libera a reserva', async () => {
    const usage: GeminiUsage[] = [];
    const model = createGeminiModel({ apiKey: 'synthetic-key', fetch: vi.fn<typeof fetch>(async () => geminiReply({ actions: [{ action: 'SUBMIT_ORDER' }] })),
      maxRequests: 5, onUsage: (u) => usage.push(u) });
    await expect(model.propose(request())).rejects.toMatchObject({ code: 'INVALID_OUTPUT', detail: 'FINISH_STOP:SCHEMA' });
    expect(usage[0]!.chargedMicroUsd).toBe(price(800, 40));
  });

  it('modelVersion do provedor é registrado só em formato seguro', async () => {
    const seen: (string | null)[] = [];
    const reply = (v: unknown) => vi.fn<typeof fetch>(async () => {
      const r = await geminiReply({ actions: [] }).json() as Record<string, unknown>;
      return Response.json({ ...r, modelVersion: v });
    });
    for (const v of ['gemini-3.8-flash-001', 'x\n<script>', 42]) {
      await createGeminiModel({ apiKey: 'synthetic-key', fetch: reply(v), maxRequests: 1, onUsage: (u) => seen.push(u.modelVersion) }).propose(request());
    }
    expect(seen).toEqual(['gemini-3.8-flash-001', null, null]);
  });
});

describe('AI-01: falhas do modelo e do iFood no runtime montado', () => {
  const cleanup: (() => void)[] = [];
  afterEach(() => { cleanup.splice(0).forEach((f) => f()); vi.restoreAllMocks(); });

  async function world(transport: typeof fetch, overrides: Record<string, string> = {}) {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const dir = temporary();
    const model = loadConfig({ CONVERSATION_RUNTIME_ENABLED: 'true', BOT_TELEGRAM_ID: principal.botId, CONVERSATION_DB_FILE: dir.file,
      BOT_API_TOKEN: 'synthetic-token-xxxxxxxxxxxxxxxxxxxxxx', ALLOWED_ORGANIZER_IDS: `${ORG_A},${ORG_B}`, CONVERSATION_MODEL_ENABLED: 'true',
      CONVERSATION_MODEL_PROVIDER: 'google', CONVERSATION_MODEL: GEMINI_MODEL, GEMINI_API_KEY: 'synthetic-key', CONVERSATION_MODEL_MAX_REQUESTS: '50', ...overrides }).conversationModel!;
    const env = setup({ conversationRuntime: { dbFile: dir.file, botId: principal.botId }, conversationModel: model });
    await connectAndConfirm(env, ORG_A);
    await connectAndConfirm(env, ORG_B);
    const runtime = createConversationRuntime(env.cfg, env.links, transport)!;
    cleanup.push(() => { runtime.stop(); dir.clean(); });
    const p = (org: string) => ({ organizerId: org, botId: principal.botId, conversationId: org });
    const wait = async (org: string, operationId: string): Promise<Operation> => {
      for (let i = 0; i < 400; i++) {
        runtime.tick(); await flush();
        const op = runtime.store.operation(p(org), operationId);
        if (!['ACCEPTED', 'RUNNING'].includes(op.status)) return op;
        await new Promise((r) => setTimeout(r, 5));
      }
      throw new Error('operação não terminou');
    };
    let n = 0;
    const accept = (text: string, version: number, org = ORG_A) => {
      const e = event(++n, version); e.conversationId = org; e.source = { ...e.source, conversationId: org }; e.input = { kind: 'TEXT', text };
      return runtime.accept(p(org), e).operation.operationId;
    };
    const send = async (text: string, version: number, org = ORG_A) => wait(org, accept(text, version, org));
    const snapshot = (org = ORG_A) => { try { return runtime.store.snapshot(p(org)); } catch { return null; } };
    return { env, runtime, send, accept, wait, snapshot };
  }
  const people = [{ action: 'ADD_PARTICIPANT', name: 'Ana' }, { action: 'ADD_RESTRICTION', participant: { name: 'Ana' }, restriction: { kind: 'ALLERGY', code: 'PEANUT' } }];

  it('texto não-JSON do modelo: FAILED/UNAVAILABLE, estado intacto; reenvio na mesma versão recupera', async () => {
    let broken = true;
    const transport = vi.fn<typeof fetch>(async () => broken
      ? Response.json({ candidates: [{ content: { role: 'model', parts: [{ text: 'Claro! Vou adicionar a Ana.' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } })
      : geminiReply({ actions: people }));
    const w = await world(transport);
    expect(await w.send('Somos Ana, alérgica a amendoim', 0)).toMatchObject({ status: 'FAILED', error: { code: 'UNAVAILABLE' } });
    expect(w.snapshot()).toMatchObject({ version: 0 });
    expect(JSON.stringify(w.snapshot())).not.toContain('Ana');
    broken = false;
    expect(await w.send('Somos Ana, alérgica a amendoim', 0)).toMatchObject({ status: 'SUCCEEDED', resultVersion: 1 });
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('modelo que não responde: prazo encerra o turno, sem retry e sem alterar estado', async () => {
    const transport = vi.fn<typeof fetch>((_u, init) => new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))));
    const w = await world(transport, { CONVERSATION_MODEL_TIMEOUT_MS: '1000' });
    expect(await w.send('Somos Ana', 0)).toMatchObject({ status: 'FAILED', error: { code: 'UNAVAILABLE' } });
    expect(transport).toHaveBeenCalledOnce();
    expect(w.snapshot()).toMatchObject({ version: 0 });
    expect(JSON.stringify(w.snapshot())).not.toContain('Ana');
  });

  it('iFood fora (rede) com o serviço de vínculos real: coleta segue; sugestão avisa e preserva; depois recupera', async () => {
    // Bia sem restrição: com a única pessoa alérgica e itens sem alérgenos informados, nenhuma proposta seria viável.
    const outputs: unknown[] = [[...people, { action: 'ADD_PARTICIPANT', name: 'Bia' }, { action: 'SET_NO_RESTRICTIONS', participant: { name: 'Bia' } }],
      [{ action: 'SUGGEST_PROPOSALS', query: 'pizza' }], [{ action: 'SUGGEST_PROPOSALS', query: 'pizza' }]];
    const w = await world(vi.fn<typeof fetch>(async () => geminiReply({ actions: outputs.shift() })));
    w.env.mcp.failure = 'network';
    expect(await w.send('Somos Ana, alérgica a amendoim, e Bia sem restrição', 0)).toMatchObject({ status: 'SUCCEEDED', resultVersion: 1 });
    const down = await w.send('Sugere pizza', 1);
    expect(down.status).toBe('SUCCEEDED');
    expect(down.snapshot!.blocks.some((b) => b.kind === 'PROPOSAL')).toBe(false);
    expect(down.snapshot!.pending.join(' ')).toMatch(/Não consegui buscar opções agora|conexão com o iFood/);
    expect(JSON.stringify(down.snapshot!.blocks)).toContain('amendoim');
    w.env.mcp.failure = 'none';
    const up = await w.send('Sugere pizza', down.resultVersion!);
    expect(up.snapshot!.phase).toBe('PROPOSALS_READY');
    expect(w.env.mcp.used.every((u) => ['listAddresses', 'searchOffers', 'getItem'].includes(u.op))).toBe(true);
  });

  it('resposta MCP malformada na busca: turno conclui com aviso, sem propostas nem exceção crua', async () => {
    const outputs: unknown[] = [people, [{ action: 'SUGGEST_PROPOSALS', query: 'pizza' }]];
    const w = await world(vi.fn<typeof fetch>(async () => geminiReply({ actions: outputs.shift() })));
    w.env.mcp.searchPages = [{ offers: 'não é lista', hasMore: 'talvez' }];
    await w.send('Somos Ana, alérgica a amendoim', 0);
    const op = await w.send('Sugere pizza', 1);
    expect(op.status).toBe('SUCCEEDED');
    expect(op.snapshot!.blocks.some((b) => b.kind === 'PROPOSAL')).toBe(false);
    expect(op.snapshot!.pending.length).toBeGreaterThan(0);
    expect(JSON.stringify(op.snapshot)).not.toMatch(/não é lista|talvez|TypeError/);
  });

  it('concorrência: dois eventos na mesma versão aplicam no máximo um; conversas diferentes ficam isoladas', async () => {
    const transport = vi.fn<typeof fetch>(async () => { await new Promise((r) => setTimeout(r, 10)); return geminiReply({ actions: [{ action: 'ADD_PARTICIPANT', name: 'Ana' }] }); });
    const w = await world(transport);
    const mcpBefore = w.env.mcp.used.length;
    const a1 = w.accept('Somos Ana', 0);
    const a2 = w.accept('Somos Ana de novo', 0);
    const b1 = w.accept('Somos Ana', 0, ORG_B);
    const [r1, r2, rb] = await Promise.all([w.wait(ORG_A, a1), w.wait(ORG_A, a2), w.wait(ORG_B, b1)]);
    expect([r1.status, r2.status].filter((s) => s === 'SUCCEEDED')).toHaveLength(1);
    expect(w.snapshot()!.version).toBe(1);
    expect(rb).toMatchObject({ status: 'SUCCEEDED', resultVersion: 1 });
    const group = (org: string) => w.snapshot(org)!.blocks.find((b) => b.kind === 'GROUP');
    expect(group(ORG_A)).toMatchObject({ participants: [expect.objectContaining({ displayName: 'Ana' })] });
    expect(group(ORG_B)).toMatchObject({ participants: [expect.objectContaining({ displayName: 'Ana' })] });
    expect(w.env.mcp.used).toHaveLength(mcpBefore); // coleta não toca o MCP
  });
});

describe('AI-01 auditoria F1: modelo sozinho não libera restrição pendente', () => {
  const ctx = (n: number) => ({ seed: 'f1', eventId: `f1-${n}`, maxParticipants: 20 });
  it('SET_NO_RESTRICTIONS sem frase explícita do usuário vira pergunta; UNCLEAR e pergunta pendente são preservados', async () => {
    const { nextPurchase } = await import('../../src/server/domain/purchase');
    const { planActions } = await import('../../src/server/agent/policy');
    let state = nextPurchase(null, { ops: [{ op: 'ADD_PARTICIPANT', displayName: 'Ana' }] }, ctx(0)).state!;
    const ana = state.participants[0]!.participantId;
    state = nextPurchase(state, { ops: [{ op: 'MARK_UNCLEAR', target: ana, field: 'RESTRICTIONS', question: 'Ana tem alguma alergia?' }] }, ctx(1)).state!;
    const proposal = { actions: [{ action: 'SET_NO_RESTRICTIONS' as const, participant: { name: 'Ana' } }] };
    const preview = (n: number) => (change: Parameters<typeof nextPurchase>[1]) => nextPurchase(state, change, ctx(n)).state;
    const attack = planActions(state, proposal, preview(2), null, 'a Ana tem alergia a gergelim, acho');
    expect(attack.state!.participants[0]!.restrictions.state).toBe('UNCLEAR');
    expect(attack.state!.clarifications.some((c) => c.target === ana && c.field === 'RESTRICTIONS')).toBe(true);
    expect(attack.ops.some((o) => o.op === 'SET_RESTRICTIONS')).toBe(false);
    const explicit = planActions(state, proposal, preview(3), null, 'Confirmo: a Ana não tem nenhuma alergia.');
    expect(explicit.state!.participants[0]!.restrictions.state).toBe('NONE');
  });
});
