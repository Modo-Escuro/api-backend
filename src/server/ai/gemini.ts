// AI-01: transporte único de provedor (Gemini, escolhido no ensaio do PR #35 — Maylon), compartilhado pelo roteador
// de audiência e pelo assistente. Não executa ferramentas, aprovações nem
// escritas: devolve só JSON estruturado; o servidor valida cada contrato depois da resposta.
//
// Limites (consolidação #35 + #36): chamadas por processo, por conversa e reserva de gasto vêm da configuração
// (CONVERSATION_MODEL_*), com tetos de segurança — nada de teto fixo que trave a demo depois de N mensagens. São
// contadores locais do processo: reinício zera (OPS-02 decide persistência/alertas). Não substituem o limite de
// cobrança no console do provedor.
import { generateText, JSONParseError, NoObjectGeneratedError, Output, jsonSchema, type LanguageModelUsage } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { z } from 'zod';
import type { JsonConversationModel, JsonModelRequest } from './types.js';
export type { JsonConversationModel, JsonModelRequest } from './types.js';

export const GEMINI_MODEL = 'gemini-3.8-flash';
const ENDPOINT = { origin: 'https://generativelanguage.googleapis.com', path: `/v1beta/models/${GEMINI_MODEL}:generateContent` };
/** Preço de referência usado só para a reserva local (USD por milhão de tokens), conforme o ensaio do #35. */
const PRICE_MICRO_USD_PER_TOKEN = { input: 0.75, output: 3.75 };

/** Tetos de segurança aceitos pela configuração (o valor efetivo vem do ambiente). */
export const GEMINI_BOUNDS = Object.freeze({
  // O raciocínio do Gemini conta no teto de saída e é bimodal: ~0 ou ~700–1.500 tokens no ensaio de 18/10/2026
  // (thinkingLevel `minimal` é recusado e `thinkingBudget` é ignorado neste modelo). Com 800, ~1/3 das mensagens de
  // coleta truncavam (FINISH_LENGTH). Latência observada até ~10 s (e >12 s em 2 de 13 chamadas encadeadas).
  timeoutMs: { min: 1_000, max: 20_000, default: 15_000 },
  maxOutputTokens: { min: 256, max: 4_096, default: 2_048 },
  maxRequests: { min: 1, max: 100_000 },
  maxRequestsPerConversation: { min: 1, max: 1_000, default: 200 },
  budgetMicroUsd: { min: 1, max: 50_000_000, default: 2_000_000 },
  maxPromptBytes: 8_000,
  maxRequestBytes: 24_000,
  /** Teto do corpo de resposta lido (sucesso ou erro); acima disso a resposta é descartada. */
  maxResponseBytes: 64 * 1024,
});

/** Lê o corpo com teto de bytes (não confia em Content-Length) e devolve uma Response equivalente já em memória. */
async function boundedResponse(response: Response, max: number): Promise<Response> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) { await response.body?.cancel().catch(() => undefined); throw new GeminiFailure('INVALID_OUTPUT', 'RESPONSE_TOO_LARGE'); }
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) { await reader.cancel().catch(() => undefined); throw new GeminiFailure('INVALID_OUTPUT', 'RESPONSE_TOO_LARGE'); }
      chunks.push(value);
    }
  }
  return new Response(total ? Buffer.concat(chunks) : null, { status: response.status, statusText: response.statusText, headers: response.headers });
}

/** Subconjunto de transporte do schema; a validação Zod completa acontece depois da resposta. */
export function geminiWireSchema(schema: z.ZodType): Record<string, unknown> {
  const project = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(project);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).flatMap(([key, child]) => key === 'const' ? [['enum', [child]]] :
      !['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'anyOf', 'oneOf'].includes(key) ? [] :
        [[key, key === 'properties' && child && typeof child === 'object'
          ? Object.fromEntries(Object.entries(child).map(([name, schema]) => [name, project(schema)])) : project(child)]]));
  };
  return project(z.toJSONSchema(schema)) as Record<string, unknown>;
}

export type GeminiFailureCode = 'KEY_MISSING' | 'BUDGET' | 'INPUT_LIMIT' | 'TIMEOUT' | 'QUOTA' | 'AUTH' | 'UNAVAILABLE' | 'INVALID_OUTPUT' | 'CONFIGURATION';
/** Falha com código fixo; `detail` só carrega termos de uma allowlist estática, nunca texto do provedor. */
export class GeminiFailure extends Error {
  constructor(readonly code: GeminiFailureCode, readonly detail?: string) { super(code); }
}
export interface GeminiUsage {
  inputTokens: number | null; outputTokens: number | null; chargedMicroUsd: number;
  /** `modelVersion` devolvido pelo provedor (o ID configurado é alias). Só formato seguro; senão null. */
  modelVersion: string | null;
}
const SAFE_MODEL_VERSION = /^[a-z0-9][a-z0-9.-]{0,63}$/;
export interface GeminiOptions {
  apiKey: string;
  /** Chamadas por processo (obrigatório; sem default para não esconder o limite). */
  maxRequests: number;
  maxRequestsPerConversation?: number;
  budgetMicroUsd?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
  onUsage?(usage: GeminiUsage): void;
  /** Montagens alternativas no mesmo processo compartilham os tetos de chamadas e gasto. */
  accounting?: { calls: number; charged: number; scopes: Map<string, number> };
}

const inRange = (v: number, b: { min: number; max: number }) => Number.isSafeInteger(v) && v >= b.min && v <= b.max;

/** Transporte único para roteamento sem fatos e planejamento de consultas do assistente. */
export function createGeminiJsonModel<Input, Result>(options: GeminiOptions, spec: {
  prompt: string;
  schema: z.ZodType<Result>;
  project(input: Input): unknown;
  check?(result: Result, input: Input): boolean;
  maxPromptBytes?: number;
  maxRequestBytes?: number;
}): JsonConversationModel<Input, Result> {
  if (!options.apiKey || /\s/.test(options.apiKey)) throw new GeminiFailure('KEY_MISSING');
  const maxRequests = options.maxRequests;
  const perConversation = options.maxRequestsPerConversation ?? GEMINI_BOUNDS.maxRequestsPerConversation.default;
  const budget = options.budgetMicroUsd ?? GEMINI_BOUNDS.budgetMicroUsd.default;
  const timeoutMs = options.timeoutMs ?? GEMINI_BOUNDS.timeoutMs.default;
  if (!inRange(maxRequests, GEMINI_BOUNDS.maxRequests) || !inRange(perConversation, GEMINI_BOUNDS.maxRequestsPerConversation) ||
      !inRange(budget, GEMINI_BOUNDS.budgetMicroUsd) || !inRange(timeoutMs, GEMINI_BOUNDS.timeoutMs)) throw new GeminiFailure('CONFIGURATION');
  const accounting = options.accounting ?? { calls: 0, charged: 0, scopes: new Map<string, number>() };
  const { scopes } = accounting;
  const maxPromptBytes = spec.maxPromptBytes ?? GEMINI_BOUNDS.maxPromptBytes;
  const maxRequestBytes = spec.maxRequestBytes ?? GEMINI_BOUNDS.maxRequestBytes;
  if (!Number.isSafeInteger(maxPromptBytes) || maxPromptBytes < 1 || maxPromptBytes > 32_000 || !Number.isSafeInteger(maxRequestBytes) || maxRequestBytes < 1 || maxRequestBytes > 64_000) throw new GeminiFailure('CONFIGURATION');
  // OPS-02: chamada recusada antes da rede não consome o provedor ⇒ reporta uso zero, sem reserva presa no orçamento.
  // Depois do envio, só uso reportado pelo provedor ajusta a reserva; timeout/falha sem uso mantém a reserva (conservador).
  const propose = async (request: JsonModelRequest<Input>): Promise<Result> => {
    const call = { fetched: false };
    try { return await proposeOnce(request, call); } catch (error) {
      if (!call.fetched) request.reportUsage?.({ inputTokens: 0, outputTokens: 0, costMicroUsd: 0 });
      throw error;
    }
  };
  return { id: GEMINI_MODEL, propose };
  async function proposeOnce(request: JsonModelRequest<Input>, call: { fetched: boolean }): Promise<Result> {
    const scope = request.budgetScope ?? 'unscoped'; // chave local opaca; jamais enviada ao provedor
    if (request.signal.aborted) throw new GeminiFailure('TIMEOUT');
    if (accounting.calls >= maxRequests || (scopes.get(scope) ?? 0) >= perConversation) throw new GeminiFailure('BUDGET');
    const input = request.input;
    // Allowlist defensiva: só os campos do contexto mínimo; nada de metadados locais ou campos extras.
    const prompt = JSON.stringify(spec.project(input));
    if (Buffer.byteLength(prompt) > maxPromptBytes) throw new GeminiFailure('INPUT_LIMIT');
    const maxOutputTokens = Math.min(request.maxOutputTokens, GEMINI_BOUNDS.maxOutputTokens.max);
    if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1) throw new GeminiFailure('CONFIGURATION');
    let reserve = 0;
    let fetched = false;
    let modelVersion: string | null = null;
    const guardedFetch: typeof fetch = async (url, init) => {
      const target = new URL(url instanceof Request ? url.url : String(url));
      if (target.origin !== ENDPOINT.origin || target.pathname !== ENDPOINT.path || target.search || init?.method !== 'POST' || typeof init.body !== 'string') {
        throw new GeminiFailure('CONFIGURATION');
      }
      const body = JSON.parse(init.body) as Record<string, unknown>;
      if (Buffer.byteLength(init.body) > maxRequestBytes || body.tools || body.stream === true || fetched) throw new GeminiFailure('INPUT_LIMIT');
      // Reserva deliberadamente alta (um token por byte + folga), não é tokenizer nem fatura.
      reserve = Math.ceil((Buffer.byteLength(init.body) + 4096) * PRICE_MICRO_USD_PER_TOKEN.input + maxOutputTokens * PRICE_MICRO_USD_PER_TOKEN.output);
      if (accounting.charged + reserve > budget || accounting.calls >= maxRequests || (scopes.get(scope) ?? 0) >= perConversation) throw new GeminiFailure('BUDGET');
      fetched = true;
      call.fetched = true;
      accounting.charged += reserve;
      accounting.calls++;
      scopes.set(scope, (scopes.get(scope) ?? 0) + 1);
      let raw: Response;
      try {
        raw = await (options.fetch ?? fetch)(url, { ...init, redirect: 'error' });
      } catch (e) {
        if (request.signal.aborted || (e instanceof Error && /Timeout|Abort/.test(e.name))) throw new GeminiFailure('TIMEOUT');
        throw new GeminiFailure('UNAVAILABLE'); // rede/DNS/redirect recusado; sem detalhes
      }
      const response = await boundedResponse(raw, GEMINI_BOUNDS.maxResponseBytes);
      if (response.status === 429) throw new GeminiFailure('QUOTA');
      if ([401, 403].includes(response.status)) throw new GeminiFailure('AUTH');
      if (response.status >= 500) throw new GeminiFailure('UNAVAILABLE');
      if (response.ok) {
        try {
          const v = (await response.clone().json() as { modelVersion?: unknown }).modelVersion;
          modelVersion = typeof v === 'string' && SAFE_MODEL_VERSION.test(v) ? v : null;
        } catch { /* corpo inválido: o SDK reporta INVALID_OUTPUT */ }
      }
      if (!response.ok) {
        const message = (await response.text()).toLowerCase();
        const terms = ['billing', 'model', 'schema', 'thinking', 'enum', 'additionalproperties', 'required', 'anyof', 'oneof', 'unsupported',
          'not found', 'tokens', 'invalid', 'json', 'format', 'permission'].filter((term) => message.includes(term));
        throw new GeminiFailure('CONFIGURATION', `HTTP_${response.status}:${terms.join(',')}`);
      }
      return response;
    };
    // Troca a reserva pelo custo dos tokens reportados (uma vez por chamada, também quando a saída é inválida).
    let settled = false;
    const settle = (usage: LanguageModelUsage | undefined) => {
      if (settled || !fetched) return;
      settled = true;
      const known = !!usage && Number.isSafeInteger(usage.inputTokens) && Number.isSafeInteger(usage.outputTokens) && usage.inputTokens! >= 0 && usage.outputTokens! >= 0;
      if (known) {
        const cost = Math.ceil(usage.inputTokens! * PRICE_MICRO_USD_PER_TOKEN.input + usage.outputTokens! * PRICE_MICRO_USD_PER_TOKEN.output);
        accounting.charged += cost - reserve;
        // Tokens reportados pelo provedor; custo pelo preço de referência (não é fatura).
        request.reportUsage?.({ inputTokens: usage.inputTokens!, outputTokens: usage.outputTokens!, costMicroUsd: cost });
      }
      options.onUsage?.({ inputTokens: known ? usage.inputTokens! : null, outputTokens: known ? usage.outputTokens! : null, chargedMicroUsd: accounting.charged, modelVersion });
    };
    const finish = (reason: unknown) => `FINISH_${String(reason).toUpperCase().replace(/[^A-Z_]/g, '_').slice(0, 24)}`;
    try {
      const model = createGoogleGenerativeAI({ apiKey: options.apiKey, fetch: guardedFetch })(GEMINI_MODEL);
      const result = await generateText({ model,
        system: spec.prompt, prompt, output: Output.object({ schema: jsonSchema<Result>(geminiWireSchema(spec.schema), {
          validate: (raw) => { const p = spec.schema.safeParse(raw); return p.success ? { success: true, value: p.data } : { success: false, error: p.error }; },
        }) }), maxOutputTokens, maxRetries: 0, abortSignal: request.signal, timeout: timeoutMs,
        telemetry: { isEnabled: false, recordInputs: false, recordOutputs: false },
        providerOptions: { google: { thinkingConfig: { thinkingLevel: 'low', includeThoughts: false } } },
      });
      settle(result.totalUsage);
      if (result.finishReason !== 'stop') throw new GeminiFailure('INVALID_OUTPUT', finish(result.finishReason));
      const proposal = spec.schema.parse(result.output);
      if (spec.check && !spec.check(proposal, input)) throw new GeminiFailure('INVALID_OUTPUT');
      return proposal;
    } catch (error) {
      if (NoObjectGeneratedError.isInstance(error)) {
        // Resposta recebida mas sem objeto válido: só o motivo de término e PARSE/SCHEMA, nunca o texto gerado.
        settle(error.usage);
        throw new GeminiFailure('INVALID_OUTPUT', `${finish(error.finishReason)}:${JSONParseError.isInstance(error.cause) ? 'PARSE' : 'SCHEMA'}`);
      }
      settle(undefined);
      let cause: unknown = error;
      for (let n = 0; cause && typeof cause === 'object' && n < 8; n++) {
        if (cause instanceof GeminiFailure) throw cause;
        cause = 'cause' in cause ? cause.cause : undefined;
      }
      if (request.signal.aborted || (error instanceof Error && /Timeout|Abort/.test(error.name))) throw new GeminiFailure('TIMEOUT');
      throw new GeminiFailure('INVALID_OUTPUT'); // nunca expor corpo, headers ou mensagem do SDK
    }
  }
}
