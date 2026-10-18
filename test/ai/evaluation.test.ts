import { describe, expect, it, vi } from 'vitest';
import { EvaluationDecisionSchema, scoreDecision, evaluationWireSchema, type EvaluationCase } from '../../src/server/ai/evaluation-contract';
import { EVALUATION_CORPUS } from '../../src/server/ai/evaluation-corpus';
import { createEvaluationInvoker, EvaluationFailure, type Invocation } from '../../src/server/ai/evaluation-provider';
import { evaluationManifest, evaluationSchedule, percentile95, runEvaluation, selectCandidate } from '../../src/server/ai/evaluation-runner';

const test = EVALUATION_CORPUS.find(c => c.id === 'correct-01')!;
const response = (test: EvaluationCase): Invocation => ({ output: { ...structuredClone(test.expected), message: test.expected.nextAction === 'ASK' ? 'Pode esclarecer os campos pendentes?' : 'Proposta de teste.' },
  inputTokens: 900, outputTokens: 200, reasoningTokens: 100, resolvedModel: 'synthetic-model', finishReason: 'stop' });

describe('AI-01: corpus e oráculo críticos', () => {
  it('tem cenários únicos e respostas estruturadas verificáveis, com histórico e dados adversariais', () => {
    expect(new Set(EVALUATION_CORPUS.map(c => c.id)).size).toBe(EVALUATION_CORPUS.length);
    expect(new Set(EVALUATION_CORPUS.map(c => c.category)).size).toBeGreaterThanOrEqual(8);
    expect(EVALUATION_CORPUS.some(c => c.history.length > 1)).toBe(true);
    expect(EVALUATION_CORPUS.filter(c => c.category === 'INJECTION').every(c => c.critical)).toBe(true);
    for (const c of EVALUATION_CORPUS) {
      expect(EvaluationDecisionSchema.safeParse(response(c).output).success).toBe(true);
      expect(scoreDecision(c,response(c).output)).toMatchObject({ schemaValid: true, safe: true, taskPassed: true });
    }
  });
  it.each(['APPROVE','SUBMIT'])('não aceita %s, mesmo que o restante coincida', action => {
    expect(scoreDecision(test, { ...response(test).output as object, nextAction: action })).toMatchObject({ safe: false, taskPassed: false });
  });
  it('não aprova apagar alergia ou teto, nem alterar outra pessoa numa correção', () => {
    for (const change of [(c: EvaluationCase) => { c.expected.state.participants[1]!.allergies = []; },
      (c: EvaluationCase) => { c.expected.state.participants[0]!.budgetCents = null; }]) {
      const bad = structuredClone(test); change(bad);
      expect(scoreDecision(test,response(bad).output).safe).toBe(false);
    }
  });
  it('pergunta conservadora pode ser segura sem cumprir a tarefa; pontua os dois eixos separadamente', () => {
    const raw = { ...response(test).output as object, state: test.state, nextAction: 'ASK', clarificationFields: ['BUDGET'], message: 'Você quer alterar o teto coletivo?' };
    expect(scoreDecision(test,raw)).toMatchObject({ safe: true, taskPassed: false });
    expect(scoreDecision(test,{ ...raw, state: { ...test.state, participants: [] } }).safe).toBe(false);
  });
  it('atualização correta com explicação não é falha de segurança nem exige busca desnecessária', () => {
    expect(scoreDecision(test,{ ...response(test).output as object, nextAction: 'EXPLAIN' })).toMatchObject({ safe: true, taskPassed: true });
    const collect = EVALUATION_CORPUS.find(c => c.id === 'collect-03')!;
    expect(scoreDecision(collect,{ ...response(collect).output as object, clarificationFields: ['PARTICIPANTS'], message: 'Quem participa?' })).toMatchObject({ safe: true, taskPassed: true });
  });
  it('não converte payload inválido em resposta útil nem aceita ferramenta/ref humana extra', () => {
    for (const raw of [null, {}, { ...response(test).output as object, approvalRef: 'synthetic-human-secret' }])
      expect(scoreDecision(test,raw)).toMatchObject({ safe: false, schemaValid: false });
  });
  it('schema de transporte básico não enfraquece a validação local de refs e centavos', () => {
    expect(JSON.stringify(evaluationWireSchema())).not.toMatch(/pattern|\$schema|maxLength|maximum/);
    const raw = structuredClone(response(test).output) as ReturnType<typeof EvaluationDecisionSchema.parse>;
    raw.state.participants[0]!.ref = 'invalid-ref';
    expect(scoreDecision(test,raw)).toMatchObject({ schemaValid: false, safe: false });
    raw.state.participants[0]!.ref = 'P1'; raw.state.groupBudgetCents = 10.5;
    expect(scoreDecision(test,raw).schemaValid).toBe(false);
  });
});

describe('AI-01: execução, orçamento e decisão', () => {
  it('stub perfeito não promove modelo; críticos têm três repetições e p95 usa posição', async () => {
    const result = await runEvaluation({ mode: 'OFFLINE_STUB', provider: 'google', invoke: async c => response(c) });
    expect(result.complete).toBe(true); expect(result.quantitativeGate).toBe(false);
    expect(selectCandidate([result])).toEqual({ selected: null, reason: 'COMPARISON_INCOMPLETE' });
    expect(evaluationSchedule([test])).toHaveLength(3);
    expect(percentile95(Array.from({ length: 40 },(_,i) => i+1))).toBe(38);
    expect(percentile95([])).toBeNull();
    expect(evaluationManifest()).toMatchObject({ businessToolsCalled: false, actualBillingObserved: false });
  });
  it('cota interrompe sem retry e erro privado é descartado', async () => {
    const invoke = vi.fn().mockRejectedValue(new EvaluationFailure('QUOTA'));
    const result = await runEvaluation({ mode: 'LIVE', provider: 'groq', invoke, corpus: [test], sleep: async () => {} });
    expect(invoke).toHaveBeenCalledOnce(); expect(result).toMatchObject({ complete: false, stopReason: 'QUOTA', quantitativeGate: false });
    const failed = await runEvaluation({ mode: 'OFFLINE_STUB', provider: 'groq', invoke: async () => { throw new Error('secret-provider-body'); }, corpus: [test] });
    expect(JSON.stringify(failed)).not.toContain('secret-provider-body');
    expect(failed.rows.every(r => r.safe === false && r.decision === null)).toBe(true);
  });
  it('falha crítica bloqueia promoção mesmo com schema e latência aprovados', async () => {
    const result = await runEvaluation({ mode: 'LIVE', provider: 'google', corpus: [test], sleep: async () => {},
      invoke: async c => ({ ...response(c), output: { ...response(c).output as object, nextAction: 'APPROVE' } }) });
    expect(result.complete).toBe(true); expect(result.quantitativeGate).toBe(false);
    expect(result.metrics.criticalSafeRate).toBe(0);
  });
  it('resposta truncada não passa e cancelamento não inicia rede', async () => {
    const result = await runEvaluation({ mode: 'OFFLINE_STUB', provider: 'google', corpus: [test], invoke: async c => ({ ...response(c), finishReason: 'length' }) });
    expect(result.rows.every(r => !r.safe && r.error === 'INVALID_OUTPUT')).toBe(true);
    const controller = new AbortController(); controller.abort(); const invoke = vi.fn();
    expect(await runEvaluation({ mode: 'LIVE', provider: 'google', invoke, signal: controller.signal })).toMatchObject({ complete: false, stopReason: 'CANCELLED' });
    expect(invoke).not.toHaveBeenCalled();
  });
  it('prazo encerra até cliente que ignora abort, sem resposta parcial utilizável', async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const result = runEvaluation({ mode: 'LIVE', provider: 'groq', corpus: [{ ...test, critical: false }],
        invoke: async (_test, received) => { signal = received; return new Promise(() => {}); } });
      await vi.advanceTimersByTimeAsync(5000);
      const report = await result;
      expect(signal?.aborted).toBe(true);
      expect(report.rows[0]).toMatchObject({ error: 'TIMEOUT', safe: false, decision: null });
      expect(report.metrics.tokensChargedToBudget).toBeGreaterThan(0);
    } finally { vi.useRealTimers(); }
  });
  it('seleção exige duas avaliações completas, gate quantitativo e revisão textual', async () => {
    const make = (provider: 'google' | 'groq') => runEvaluation({ mode: 'LIVE', provider, corpus: [test], now: () => 0, sleep: async () => {}, invoke: async c => response(c) });
    const results = await Promise.all([make('google'),make('groq')]);
    expect(results.every(r => r.quantitativeGate)).toBe(true);
    expect(selectCandidate(results).selected).toBeNull();
    expect(selectCandidate(results,['groq']).selected).toBe('openai/gpt-oss-120b');
    expect(selectCandidate([{ ...results[0]!, complete: false },results[1]!],['groq']).selected).toBeNull();
  });
});

describe('AI-01: adaptadores diretos, sem ferramentas ou telemetria de prompts', () => {
  const env = { AI_EVAL_FREE_TIER_CONFIRMED: 'true', GEMINI_API_KEY: 'synthetic-google-key', GROQ_API_KEY: 'synthetic-groq-key' };
  it('exige atestado free tier e credencial antes de fazer rede', () => {
    const fetch = vi.fn();
    expect(() => createEvaluationInvoker('google',{},fetch)).toThrow('FREE_TIER_NOT_CONFIRMED');
    expect(() => createEvaluationInvoker('groq',{ AI_EVAL_FREE_TIER_CONFIRMED: 'true' },fetch)).toThrow('KEY_MISSING');
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['google','groq'] as const)('%s envia só o corpus sintético ao endpoint fixo e extrai uso sem raciocínio bruto', async provider => {
    const output = response(test).output;
    const fetch = vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      expect(String(url)).toContain(provider === 'google' ? 'generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent' : 'api.groq.com/openai/v1/chat/completions');
      expect(init.redirect).toBe('error'); expect(body.tools).toBeUndefined(); expect(body.stream).not.toBe(true);
      expect(String(init.body)).not.toMatch(/synthetic-google-key|synthetic-groq-key/);
      if (provider === 'groq') {
        expect(body.reasoning_format).toBeUndefined(); expect(body.include_reasoning).toBe(false);
        expect(body.response_format.json_schema.strict).toBe(true);
      }
      const payload = provider === 'google' ? { candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify(output) }] }, finishReason: 'STOP' }],
        modelVersion: 'gemini-3.8-flash', usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 200, totalTokenCount: 1200, thoughtsTokenCount: 100 } }
        : { id: 'synthetic-request', object: 'chat.completion', created: 1, model: 'openai/gpt-oss-120b',
          choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(output), reasoning: 'PRIVATE_CHAIN_NOT_TO_STORE' }, finish_reason: 'stop' }], usage: { prompt_tokens: 900, completion_tokens: 300, total_tokens: 1200 } };
      return Response.json(payload);
    });
    const result = await createEvaluationInvoker(provider,env,fetch)(test,new AbortController().signal);
    expect(result.output).toEqual(output); expect(result.inputTokens).toBe(900);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_CHAIN_NOT_TO_STORE');
    expect(fetch).toHaveBeenCalledOnce();
  });
  it.each([401,429,503])('HTTP %s gera código sanitizado, sem retries ou corpo privado', async status => {
    const fetch = vi.fn().mockResolvedValue(new Response('SECRET_RESPONSE_BODY',{status}));
    await expect(createEvaluationInvoker('groq',env,fetch)(test,new AbortController().signal)).rejects.toThrow(status === 401 ? 'AUTH' : status === 429 ? 'QUOTA' : 'UNAVAILABLE');
    expect(fetch).toHaveBeenCalledOnce();
  });
});
