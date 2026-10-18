// GRP-01: geração de propostas a partir de leituras MCP (searchOffers/getItem via runEvaluation). Só leitura (D8).
// A busca NÃO aplica a união das restrições do grupo como filtro: cada pessoa é avaliada depois, com as próprias
// restrições (domain/group.ts). IDs, preços e lojas vêm só das respostas MCP.
import { composeProposals, type GroupLimits, type GroupResult, type PlanRanker } from '../domain/group.js';
import type { PurchaseState } from '../domain/purchase.js';
import { ItemCache, runEvaluation, type EvaluateDeps, type EvaluateLimits } from './evaluate.js';

export interface ProposalRequest {
  /** Termo de busca (ex.: "pizza"); dado do usuário, usado só como consulta de leitura. */
  query: string;
}

export interface ProposalsOutcome {
  result: GroupResult;
  /** Resumo da leitura (sem dados pessoais). */
  read: { detailed: number; failed: number; pagesFetched: number; deadlineReached: boolean };
}

export async function generateProposals(
  state: PurchaseState, req: ProposalRequest, deps: EvaluateDeps,
  opts: { seed: string; ranker?: PlanRanker; groupLimits?: Partial<GroupLimits>; evaluateLimits?: Partial<EvaluateLimits>; cache?: ItemCache; signal?: AbortSignal },
): Promise<ProposalsOutcome> {
  const outcome = await runEvaluation({
    query: req.query,
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(state.address.state === 'DECLARED' ? { addressId: state.address.value.addressId } : {}),
    restrictions: [], // sem filtro por união: a matriz por pessoa decide
    limits: { maxDetails: 12, ...opts.evaluateLimits },
  }, deps, opts.cache ?? new ItemCache());
  const candidates = outcome.candidates.flatMap((c) => c.detail.status === 'DETAILED'
    ? [{ listing: c.listing, detail: c.detail.detail, serverFilters: c.serverFilters }] : []);
  // Proveniência: o endereço efetivamente usado pela leitura (declarado ou o único salvo) vai junto da proposta.
  const result = composeProposals(state, candidates, { seed: opts.seed, addressId: outcome.location.addressId,
    ...(opts.ranker ? { ranker: opts.ranker } : {}), ...(opts.groupLimits ? { limits: opts.groupLimits } : {}) });
  return {
    result,
    read: { detailed: outcome.details.detailed, failed: outcome.details.failed, pagesFetched: outcome.search.pagesFetched, deadlineReached: outcome.deadlineReached },
  };
}

/**
 * Provedor de propostas para o agente (AI-02): roda a leitura MCP pelo vínculo confirmado e operacional do
 * organizador autenticado (OPS-01), com o cache de getItem do vínculo. Nenhuma escrita é possível por este caminho.
 */
export function linkedProposalProvider(
  links: { withOperational: <T>(organizerId: string, op: 'OFFERS_EVALUATE', fn: (ctx: { linkId: string; deps: EvaluateDeps; cache: ItemCache }) => Promise<T>) => Promise<T> },
  opts: { ranker?: PlanRanker; groupLimits?: Partial<GroupLimits>; evaluateLimits?: Partial<EvaluateLimits>;
    addressFor?: (organizerId: string, ctx: { linkId: string; deps: EvaluateDeps; cache: ItemCache }) => Promise<string> } = {},
) {
  // Devolve o linkId realmente usado: o processador descarta o resultado se o vínculo mudou durante a busca.
  return (organizerId: string, state: PurchaseState, query: string, signal?: AbortSignal): Promise<GroupResult & { linkId: string }> =>
    links.withOperational(organizerId, 'OFFERS_EVALUATE', async (ctx) => {
      const addressId = opts.addressFor ? await opts.addressFor(organizerId, ctx) : undefined;
      const addressed = addressId ? { ...state, address: { state: 'DECLARED' as const, value: { addressId }, origin: { eventId: 'human-address-selection' } } } : state;
      const outcome = await generateProposals(addressed, { query }, ctx.deps, { seed: organizerId, cache: ctx.cache, ...opts, ...(signal ? { signal } : {}) });
      if (opts.addressFor && await opts.addressFor(organizerId, ctx) !== addressId)
        throw new Error('Endereço autorizado mudou durante a busca.');
      return { ...outcome.result,
        linkId: ctx.linkId, ...(addressId ? { addressId } : {}) };
    });
}
