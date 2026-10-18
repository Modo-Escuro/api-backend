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
import { createHash } from 'node:crypto';
import { ContractError } from '../contracts/guards.js';
import { evaluatePlan, planCoverage, type GroupResult } from '../domain/group.js';
import { DomainError, type PurchaseState } from '../domain/purchase.js';
import { conversationKey, type SpendBudget } from '../ops/budget.js';
import { log } from '../ops/log.js';
import { metrics } from '../ops/metrics.js';
import type { TurnContext, TurnProcessor, TurnResult } from '../turns/runtime.js';
import { scopeKey } from '../turns/store.js';
import { AgentProposalSchema, type ConversationModel } from './model.js';
import { buildModelInput, missingQuestions, planActions } from './policy.js';
import { renderSnapshot, SNAPSHOT_BUDGET_BYTES } from './render.js';
import { AddressError } from '../services/delivery-addresses.js';
import { shortReply } from './short-reply.js';
import { resolveConversationAction } from './conversation-actions.js';

export interface AgentOptions {
  model: ConversationModel;
  /** linkId do vínculo confirmado do organizador (null sem vínculo). Lança se o armazenamento estiver indisponível. */
  linkOf(organizerId: string): Promise<string | null>;
  /** Prazo da chamada ao modelo (padrão 20 s; sempre abaixo do prazo da operação). */
  timeoutMs?: number;
  /** Teto de tokens de saída repassado ao provedor (padrão 1024). */
  maxOutputTokens?: number;
  /**
   * GRP-01: composição de propostas por leitura MCP (ex.: `linkedProposalProvider`). Ausente ⇒ sugestões
   * indisponíveis (pendência), sem afetar o resto do turno.
   */
  proposals?(organizerId: string, state: PurchaseState, query: string, signal: AbortSignal): Promise<GroupResult & { linkId?: string; addressId?: string }>;
  /** Prazo da busca de propostas (padrão 30 s). */
  proposalsTimeoutMs?: number;
  /** OPS-02: orçamento por conversa/global. Estouro ⇒ LIMIT_EXCEEDED antes de chamar o modelo. */
  budget?: SpendBudget;
  /** Relógio para medir duração (testes). */
  now?: () => number;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_TIMEOUT_MS = 60_000;

function fail(code: string): never {
  log('error', 'agent.turn_failed', { component: 'agent', code }); // sem conteúdo do turno
  metrics.inc('agent_turns_total', { outcome: 'FAILED', code });
  throw new ContractError('UNAVAILABLE');
}

/** Estimativa conservadora da entrada (≈ 1 token a cada 3 bytes do JSON enviado). */
const estimateInputTokens = (input: unknown) => Math.ceil(Buffer.byteLength(JSON.stringify(input)) / 3);
const count = (n: unknown) => (typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : null);

/**
 * Corre `work` contra o sinal do turno + prazo. Dependência que ignore o sinal (provedor, consulta de vínculo) não
 * segura o turno: a corrida termina no prazo e o código distingue prazo de cancelamento/perda de lease.
 */
class StaleLinkError extends Error {}

/** Chave local de limite por conversa: hash opaco (nunca IDs Telegram em claro, mesmo que um adaptador a serialize). */
const scopeHash = (p: TurnContext['principal']) =>
  createHash('sha256').update(JSON.stringify(['AI-01-scope', p.botId, p.organizerId, p.conversationId])).digest('base64url').slice(0, 24);

/** Mensagem específica por causa (sem dados pessoais); nada de "deu erro" genérico quando a causa é conhecida. */
function proposalFailureText(e: unknown): string {
  if (e instanceof StaleLinkError) return 'A conexão com a conta iFood mudou durante a busca; peça as sugestões de novo.';
  if (e instanceof DomainError) return 'A compra mudou enquanto eu buscava; peça as sugestões de novo.';
  const code = typeof e === 'object' && e !== null && 'code' in e ? String((e as { code: unknown }).code) : '';
  if (code === 'ADDRESS_AMBIGUOUS') return 'Há mais de um endereço salvo no iFood e nenhum foi escolhido para esta compra; não busquei para não usar o endereço errado.';
  if (code === 'ADDRESS_NOT_FOUND') return 'O endereço escolhido não está mais na conta iFood; escolha outro antes de pedir sugestões.';
  if (code === 'IFOOD_LINK_REQUIRED') return 'Conecte e confirme uma conta iFood antes de pedir sugestões.';
  if (code === 'IFOOD_RECONNECT_REQUIRED') return 'A conexão com o iFood precisa ser refeita antes de pedir sugestões.';
  return 'Não consegui buscar opções agora; seus dados foram mantidos. Tente de novo em instantes.';
}

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
  const now = opts.now ?? Date.now;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) throw new Error('timeoutMs do agente inválido.');
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1) throw new Error('maxOutputTokens do agente inválido.');
  return async (ctx: TurnContext): Promise<TurnResult> => {
    // Um único orçamento de tempo para o turno inteiro (vínculo + modelo), sempre abaixo do prazo da operação.
    const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(timeoutMs)]);
    let linkId: string | null;
    try {
      linkId = await withDeadline(signal, ctx.signal, () => opts.linkOf(ctx.principal.organizerId));
    } catch (e) {
      fail(reason(e, 'LINK_LOOKUP'));
    }
    const code = ctx.event.input.kind === 'ACTION' ? resolveConversationAction(ctx.event, ctx.snapshot, ctx.purchase, linkId, now()) : null;
    const message = ctx.event.input.kind === 'TEXT' ? ctx.event.input.text
      : code?.startsWith('choose') ? `Quero a opção ${code.slice(6)}` : code === 'none' ? 'Não tenho restrições' : code === 'more' ? 'Ver outras' : code === 'clear' ? 'Esvaziar sacola' : code === 'review' ? 'Revisar carrinho' : 'Mudar busca';
    const direct = code === 'review' ? { proposal: { actions: [{ action: 'REQUEST_ORDER' as const }] }, policyMessage: message } : shortReply(ctx.purchase, ctx.snapshot, message);
    const input = buildModelInput(ctx.purchase, ctx.snapshot.phase, message, ctx.snapshot);
    const reservedTokens = estimateInputTokens(input) + maxOutputTokens;
    const reserved = direct ? undefined : opts.budget?.reserve(conversationKey(scopeKey(ctx.principal)), reservedTokens);
    if (reserved && !reserved.ok) {
      // Parada clara antes do provedor: nada é gravado, o snapshot e a compra continuam na versão atual.
      log('warn', 'agent.budget_exceeded', { component: 'agent', kind: reserved.denial, reservedTokens });
      metrics.inc('agent_budget_exceeded_total', { kind: reserved.denial });
      metrics.inc('agent_turns_total', { outcome: 'FAILED', code: 'LIMIT_EXCEEDED' });
      throw new ContractError('LIMIT_EXCEEDED');
    }
    let usage: { inputTokens: number | null; outputTokens: number | null; costMicroUsd: number | null } | null = null;
    let settledUsage = false;
    // Relato tardio (depois do prazo do turno, quando a reserva já foi fechada) é ignorado: nada é cobrado duas vezes.
    const reportUsage = (u: { inputTokens?: number; outputTokens?: number; costMicroUsd?: number }) => {
      if (settledUsage) return;
      usage = { inputTokens: count(u?.inputTokens), outputTokens: count(u?.outputTokens), costMicroUsd: count(u?.costMicroUsd) };
    };
    let raw: unknown;
    const t0 = now();
    try {
      raw = direct ? direct.proposal : await withDeadline(signal, ctx.signal, (s) => opts.model.propose({ input, signal: s, maxOutputTokens, reportUsage,
        budgetScope: scopeHash(ctx.principal) }));
      if (!direct) metrics.inc('model_calls_total', { outcome: 'OK' });
    } catch (e) {
      metrics.inc('model_calls_total', { outcome: reason(e, 'MODEL') });
      fail(reason(e, 'MODEL'));
    } finally {
      if (!direct) metrics.observe('model_call_duration_ms', {}, now() - t0);
      settledUsage = true;
      const u = usage as { inputTokens: number | null; outputTokens: number | null; costMicroUsd: number | null } | null;
      const used = u && u.inputTokens !== null && u.outputTokens !== null ? u.inputTokens + u.outputTokens : null;
      if (reserved?.ok) reserved.reservation.settle(used);
      if (u?.inputTokens != null) metrics.inc('model_tokens_total', { kind: 'input' }, u.inputTokens);
      if (u?.outputTokens != null) metrics.inc('model_tokens_total', { kind: 'output' }, u.outputTokens);
      if (!direct && used === null) metrics.inc('model_tokens_total', { kind: 'reserved_unreported' }, reservedTokens);
      if (u?.costMicroUsd != null && u.costMicroUsd > 0) metrics.inc('model_cost_micro_usd_total', {}, u.costMicroUsd);
    }
    const parsed = AgentProposalSchema.safeParse(raw);
    if (!parsed.success) fail('MODEL_OUTPUT_INVALID');

    // Só propostas exibidas no último snapshot podem ser escolhidas (nada de escolha às cegas).
    const visible = new Set(ctx.snapshot.blocks.flatMap((b) => (b.kind === 'PROPOSAL' ? [b.proposalRef] : [])));
    const human = direct?.human;
    const plan = human
      ? { ops: [...human.ops], state: human.ops.length ? ctx.previewDomain({ ops: human.ops, ...(linkId ? { linkId } : {}) }) : ctx.purchase,
          applied: human.ops.length ? [human.note] : [], notes: human.ops.length ? [] : [human.note], suggest: null as string | null }
      : planActions(ctx.purchase, parsed.data, (change) => ctx.previewDomain(change), linkId, direct?.policyMessage ?? message, visible);
    if (direct && 'note' in direct && direct.note) plan.applied.push(direct.note);
    if (plan.suggest !== null) {
      plan.ops.push({ op: 'SET_SEARCH_QUERY', query: plan.suggest });
      plan.state = ctx.previewDomain({ ops: plan.ops, ...(linkId ? { linkId } : {}) });
    } else if (!direct?.note && plan.ops.length && plan.state?.searchQuery && !plan.state.bag && !plan.state.proposals?.length
      && !plan.notes.length && !missingQuestions(plan.state).length) {
      plan.suggest = plan.state.searchQuery;
    }
    const extraNotes: string[] = [];
    if (plan.suggest !== null) {
      const state = plan.state;
      if (!state || !state.participants.length) extraNotes.push('Diga quem vai participar antes de pedir sugestões.');
      else if (!opts.proposals) extraNotes.push('Sugestões de itens ainda não estão disponíveis nesta etapa.');
      else {
        try {
          const proposalSignal = AbortSignal.any([ctx.signal, AbortSignal.timeout(opts.proposalsTimeoutMs ?? 30_000)]);
          const result = await withDeadline(proposalSignal, ctx.signal, (s) => opts.proposals!(ctx.principal.organizerId, state, plan.suggest!, s));
          if (result.linkId !== undefined && result.linkId !== linkId) throw new StaleLinkError();
          const addressOps = result.addressId ? [{ op: 'SET_ADDRESS' as const, addressId: result.addressId }] : [];
          const op = { op: 'SET_PROPOSALS' as const, proposals: result.proposals.map((p) => p.proposal) };
          plan.state = ctx.previewDomain({ ops: [...plan.ops, ...addressOps, op], ...(linkId ? { linkId } : {}) });
          plan.ops.push(...addressOps, op);
          const fullCoverage = result.proposals.some((p) => p.coverage.every((c) => c.status === 'COVERED'));
          plan.applied.push(result.proposals.length
            ? fullCoverage ? `Encontrei ${result.proposals.length} proposta(s) para "${plan.suggest}".`
              : `Encontrei ${result.proposals.length} proposta(s) parcial(is) para "${plan.suggest}"; ainda não há uma que atenda todo o grupo.`
            : `Não consegui montar uma proposta verificável para "${plan.suggest}". Os motivos e próximos passos estão abaixo.`);
          extraNotes.push(...result.explanation);
        } catch (e) {
          extraNotes.push(e instanceof AddressError && e.code === 'ADDRESS_REQUIRED'
            ? 'Confirme seu endereço pelo botão Endereços iFood antes das sugestões. Podemos continuar organizando participantes, restrições e orçamento.'
            : proposalFailureText(e));
          log('error', 'agent.proposals_unavailable', { component: 'agent', code: reason(e, 'PROPOSALS') });
          metrics.inc('agent_proposals_total', { outcome: reason(e, 'PROPOSALS') });
        }
      }
    }
    const render = () => {
      const final = plan.state;
      const views = {
        proposals: final?.proposals?.map((p) => evaluatePlan(final, p, planCoverage(final, p))) ?? [],
        bag: final?.bag ? evaluatePlan(final, final.bag, planCoverage(final, final.bag)) : null,
      };
      // Avisos da busca primeiro (o de "busca limitada" nunca pode ser cortado pelo limite de pendências).
      const pending = [...extraNotes, ...plan.notes, ...missingQuestions(plan.state)];
      return renderSnapshot(ctx.snapshot, plan.state, plan.applied, pending, views);
    };
    let snapshot = render();
    // A revisão do carrinho nunca é cortada. Se ela não couber no limite de resposta, a escolha não é gravada
    // (carrinho sem revisão visível não existe) e o usuário recebe o motivo.
    if (Buffer.byteLength(JSON.stringify(snapshot)) > SNAPSHOT_BUDGET_BYTES && plan.ops.some((o) => o.op === 'SELECT_PROPOSAL')) {
      const kept = plan.ops.filter((o) => o.op !== 'SELECT_PROPOSAL');
      plan.ops.splice(0, plan.ops.length, ...kept);
      plan.state = kept.length ? ctx.previewDomain({ ops: kept, ...(linkId ? { linkId } : {}) }) : ctx.purchase;
      plan.applied = plan.applied.filter((t) => !t.includes('colocada no carrinho simulado'));
      extraNotes.unshift('O grupo é grande demais para mostrar a revisão do carrinho; a escolha não foi registrada. Reduza o grupo ou as condições e tente de novo.');
      snapshot = render();
    }
    metrics.inc('agent_turns_total', { outcome: 'OK' });
    return {
      clearGroup: Boolean(human?.ops.some(op => op.op === 'END')),
      conversationActions: true,
      snapshot,
      completeness: plan.notes.length ? 'PARTIAL' : 'COMPLETE',
      paths: ['PHASE'],
      cause: 'USER',
      domain: { ops: plan.ops, ...(linkId ? { linkId } : {}) },
    };
  };
}
