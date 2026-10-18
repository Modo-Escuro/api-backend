// AI-02: processador conversacional instalado na RUN-01 (TurnProcessor).
// Fluxo: vínculo autenticado → contexto mínimo → modelo (com prazo) → schema estrito → política do servidor
// (operações validadas por previewDomain) → snapshot montado pelo servidor → commit atômico pela DATA-01/RUN-01.
//
// Garantias:
//  - linkId vem do vínculo do organizador autenticado (OPS-01), nunca do modelo.
//  - Modelo indisponível, lento ou com saída inválida ⇒ ContractError('UNAVAILABLE'): a operação falha, o estado e a
//    versão ficam intactos e o bot pode reenviar (próximo passo recuperável). Nada de sucesso fictício.
//  - Nenhuma ferramenta MCP, carrinho, aprovação ou escrita externa é exposta ao modelo (D8).
//  - Logs: só códigos; nunca mensagem, nomes, restrições ou saída do modelo.
import { ContractError } from '../contracts/guards.js';
import type { TurnContext, TurnProcessor, TurnResult } from '../turns/runtime.js';
import { AgentProposalSchema, type ConversationModel } from './model.js';
import { buildModelInput, missingQuestions, planActions } from './policy.js';
import { renderSnapshot } from './render.js';

export interface AgentOptions {
  model: ConversationModel;
  /** linkId do vínculo confirmado do organizador (null sem vínculo). Lança se o armazenamento estiver indisponível. */
  linkOf(organizerId: string): Promise<string | null>;
  /** Prazo da chamada ao modelo (padrão 20 s; sempre abaixo do prazo da operação). */
  timeoutMs?: number;
  /** Teto de tokens de saída repassado ao provedor (padrão 1024). */
  maxOutputTokens?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_TIMEOUT_MS = 60_000;

function fail(code: string): never {
  console.error('[agente] turno não processado:', code); // sem conteúdo do turno
  throw new ContractError('UNAVAILABLE');
}

/**
 * Corre `work` contra o sinal do turno + prazo. Dependência que ignore o sinal (provedor, consulta de vínculo) não
 * segura o turno: a corrida termina no prazo e o código distingue prazo de cancelamento/perda de lease.
 */
async function withDeadline<T>(signal: AbortSignal, turn: AbortSignal, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error(turn.aborted ? 'TURN_ABORTED' : 'TIMEOUT'));
    if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([work(signal), aborted]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}
const reason = (e: unknown, prefix: string) =>
  e instanceof Error && (e.message === 'TIMEOUT' || e.message === 'TURN_ABORTED') ? `${prefix}_${e.message}` : `${prefix}_FAILED`;

export function createAgentProcessor(opts: AgentOptions): TurnProcessor {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputTokens = opts.maxOutputTokens ?? 1024;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) throw new Error('timeoutMs do agente inválido.');
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1) throw new Error('maxOutputTokens do agente inválido.');
  return async (ctx: TurnContext): Promise<TurnResult> => {
    if (ctx.event.input.kind !== 'TEXT') throw new ContractError('ACTION_UNAVAILABLE');
    // Um único orçamento de tempo para o turno inteiro (vínculo + modelo), sempre abaixo do prazo da operação.
    const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(timeoutMs)]);
    let linkId: string | null;
    try {
      linkId = await withDeadline(signal, ctx.signal, () => opts.linkOf(ctx.principal.organizerId));
    } catch (e) {
      fail(reason(e, 'LINK_LOOKUP'));
    }
    const input = buildModelInput(ctx.purchase, ctx.snapshot.phase, ctx.event.input.text);
    let raw: unknown;
    try {
      raw = await withDeadline(signal, ctx.signal, (s) => opts.model.propose({ input, signal: s, maxOutputTokens }));
    } catch (e) {
      fail(reason(e, 'MODEL'));
    }
    const parsed = AgentProposalSchema.safeParse(raw);
    if (!parsed.success) fail('MODEL_OUTPUT_INVALID');

    const plan = planActions(ctx.purchase, parsed.data, (change) => ctx.previewDomain(change), linkId);
    const pending = [...plan.notes, ...missingQuestions(plan.state)];
    const snapshot = renderSnapshot(ctx.snapshot, plan.state, plan.applied, pending);
    return {
      snapshot,
      completeness: plan.notes.length ? 'PARTIAL' : 'COMPLETE',
      paths: ['PHASE'],
      cause: 'USER',
      domain: { ops: plan.ops, ...(linkId ? { linkId } : {}) },
    };
  };
}
