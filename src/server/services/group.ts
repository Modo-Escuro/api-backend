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
  opts: { seed: string; ranker?: PlanRanker; groupLimits?: Partial<GroupLimits>; evaluateLimits?: Partial<EvaluateLimits>; cache?: ItemCache },
): Promise<ProposalsOutcome> {
  const outcome = await runEvaluation({
    query: req.query,
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
  opts: { ranker?: PlanRanker; groupLimits?: Partial<GroupLimits>; evaluateLimits?: Partial<EvaluateLimits> } = {},
) {
  // Devolve o linkId realmente usado: o processador descarta o resultado se o vínculo mudou durante a busca.
  return (organizerId: string, state: PurchaseState, query: string): Promise<GroupResult & { linkId: string }> =>
    links.withOperational(organizerId, 'OFFERS_EVALUATE', async (ctx) =>
      ({ ...(await generateProposals(state, { query }, ctx.deps, { seed: organizerId, cache: ctx.cache, ...opts })).result, linkId: ctx.linkId }));
}
