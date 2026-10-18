// Adaptadores exclusivos do ensaio sintético; não importam OAuth, MCP, banco ou runtime do bot.
import { generateText, Output, jsonSchema } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createGroq } from '@ai-sdk/groq';
import { EvaluationDecisionSchema, SYSTEM_PROMPT, evaluationWireSchema, type EvaluationCase, type EvaluationDecision } from './evaluation-contract.js';

export const EVALUATION_MODELS = {
  google: { id: 'gemini-3.8-flash', envKey: 'GEMINI_API_KEY', origin: 'https://generativelanguage.googleapis.com', path: '/v1beta/models/gemini-3.8-flash:generateContent' },
  groq: { id: 'openai/gpt-oss-120b', envKey: 'GROQ_API_KEY', origin: 'https://api.groq.com', path: '/openai/v1/chat/completions' },
} as const;
export type EvaluationProvider = keyof typeof EVALUATION_MODELS;
export const EVALUATION_LIMITS = Object.freeze({ timeoutMs: 5000, modelP95Ms: 4000, maxOutputTokens: 1500,
  maxRequestBytes: 24_000, maxCallsPerModel: 96, maxTokensPerModel: 160_000, maxEstimatedInputTokens: 2000,
  maxModelCallsPerTurn: 1, maxModelCallsPerPurchase: 12, minimumIntervalMs: 30_000 });
export type FailureCode = 'FREE_TIER_NOT_CONFIRMED' | 'KEY_MISSING' | 'QUOTA' | 'AUTH' | 'TIMEOUT' | 'UNAVAILABLE' | 'INVALID_OUTPUT' | 'INPUT_LIMIT' | 'PROVIDER_CONFIGURATION' | 'CANCELLED';
export class EvaluationFailure extends Error {
  constructor(readonly code: FailureCode, readonly detail?: 'ORIGIN' | 'PATH' | 'QUERY' | 'METHOD' | 'BODY' | 'TOOLS' | `HTTP_${number}`) { super(code); }
}
export interface Invocation {
  output: unknown;
  inputTokens: number | null; outputTokens: number | null; reasoningTokens: number | null;
  resolvedModel: string; finishReason: string;
}
export type Invoker = (test: EvaluationCase, signal: AbortSignal) => Promise<Invocation>;

export function evaluationPrompt(test: EvaluationCase) {
  return JSON.stringify({ state: test.state, history: test.history, text: test.text, externalData: test.externalData });
}
const number = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

export function createEvaluationInvoker(provider: EvaluationProvider, env: NodeJS.ProcessEnv, fetchImpl: typeof fetch = fetch): Invoker {
  if (env.AI_EVAL_FREE_TIER_CONFIRMED !== 'true') throw new EvaluationFailure('FREE_TIER_NOT_CONFIRMED');
  const entry = EVALUATION_MODELS[provider];
  const key = env[entry.envKey];
  if (!key || /\s/.test(key)) throw new EvaluationFailure('KEY_MISSING');
  const guardedFetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== entry.origin) throw new EvaluationFailure('PROVIDER_CONFIGURATION','ORIGIN');
    if (url.pathname !== entry.path) throw new EvaluationFailure('PROVIDER_CONFIGURATION','PATH');
    if (url.search) throw new EvaluationFailure('PROVIDER_CONFIGURATION','QUERY');
    if (init?.method !== 'POST') throw new EvaluationFailure('PROVIDER_CONFIGURATION','METHOD');
    if (typeof init.body !== 'string' || Buffer.byteLength(init.body) > EVALUATION_LIMITS.maxRequestBytes) throw new EvaluationFailure('INPUT_LIMIT','BODY');
    const request = JSON.parse(init.body) as Record<string, unknown>;
    if (request.tools || request.stream === true) throw new EvaluationFailure('PROVIDER_CONFIGURATION','TOOLS');
    // GPT-OSS não aceita reasoning_format; a API Groq permite omitir o raciocínio da resposta.
    if (provider === 'groq') init = { ...init, body: JSON.stringify({ ...request, include_reasoning: false }) };
    const response = await fetchImpl(input, { ...init, redirect: 'error' });
    if (response.status === 429) throw new EvaluationFailure('QUOTA');
    if (response.status === 401 || response.status === 403) throw new EvaluationFailure('AUTH');
    if (response.status >= 500) throw new EvaluationFailure('UNAVAILABLE');
    if (!response.ok) throw new EvaluationFailure('PROVIDER_CONFIGURATION',`HTTP_${response.status}`);
    return response;
  };
  const model = provider === 'google'
    ? createGoogleGenerativeAI({ apiKey: key, fetch: guardedFetch })(entry.id)
    : createGroq({ apiKey: key, fetch: guardedFetch })(entry.id);
  return async (test, signal) => {
    try {
      const result = await generateText({ model, system: SYSTEM_PROMPT, prompt: evaluationPrompt(test),
        output: Output.object({ name: 'groupPurchaseProposal', schema: jsonSchema<EvaluationDecision>(evaluationWireSchema(), {
          validate: value => {
            const parsed = EvaluationDecisionSchema.safeParse(value);
            return parsed.success ? { success: true, value: parsed.data } : { success: false, error: parsed.error };
          },
        }) }),
        temperature: 0, maxOutputTokens: EVALUATION_LIMITS.maxOutputTokens, maxRetries: 0,
        abortSignal: signal, timeout: EVALUATION_LIMITS.timeoutMs,
        telemetry: { isEnabled: false, recordInputs: false, recordOutputs: false },
        providerOptions: provider === 'google'
          ? { google: { thinkingConfig: { thinkingLevel: 'low', includeThoughts: false } } }
          : { groq: { reasoningEffort: 'low', structuredOutputs: true, strictJsonSchema: true } },
      });
      return { output: result.output, inputTokens: number(result.totalUsage.inputTokens), outputTokens: number(result.totalUsage.outputTokens),
        reasoningTokens: number(result.totalUsage.outputTokenDetails.reasoningTokens),
        resolvedModel: /^[a-zA-Z0-9/_.:-]{1,160}$/.test(result.response.modelId) ? result.response.modelId : entry.id,
        finishReason: result.finishReason };
    } catch (error) {
      let cause: unknown = error;
      for (let depth = 0; cause && typeof cause === 'object' && depth < 8; depth++) {
        if (cause instanceof EvaluationFailure) throw cause;
        cause = 'cause' in cause ? cause.cause : undefined;
      }
      // Nunca propaga corpo de resposta, texto do modelo, headers ou mensagem do SDK.
      if (signal.aborted) throw new EvaluationFailure('TIMEOUT');
      const name = error instanceof Error ? error.name : '';
      if (/Timeout|Abort/.test(name)) throw new EvaluationFailure('TIMEOUT');
      if (/NoObjectGenerated|TypeValidation|JSONParse|NoOutputGenerated/.test(name)) throw new EvaluationFailure('INVALID_OUTPUT');
      throw new EvaluationFailure('UNAVAILABLE');
    }
  };
}
