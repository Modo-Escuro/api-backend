// GRP-01: geração de propostas a partir de leituras MCP (searchOffers/getItem via runEvaluation). Só leitura (D8).
// A busca NÃO aplica a união das restrições do grupo como filtro: cada pessoa é avaliada depois, com as próprias
// restrições (domain/group.ts). IDs, preços e lojas vêm só das respostas MCP.
import { composeProposals, type GroupLimits, type GroupResult, type PlanRanker } from '../domain/group.js';
import type { PurchaseState } from '../domain/purchase.js';
import { ItemCache, type EvaluateDeps, type EvaluateLimits } from './evaluate.js';
import { exploreGroupCatalog, type GroupRead } from './group-search.js';
import { val } from '../domain/fields.js';

export interface ProposalRequest {
  /** Termo de busca (ex.: "pizza"); dado do usuário, usado só como consulta de leitura. */
  query: string;
}

export interface ProposalsOutcome {
  result: GroupResult;
  /** Resumo da leitura (sem dados pessoais). */
  read: GroupRead;
}

export async function generateProposals(
  state: PurchaseState, req: ProposalRequest, deps: EvaluateDeps,
  opts: { seed: string; ranker?: PlanRanker; groupLimits?: Partial<GroupLimits>; evaluateLimits?: Partial<EvaluateLimits>; cache?: ItemCache; signal?: AbortSignal },
): Promise<ProposalsOutcome> {
  const compose = (candidates: Parameters<typeof composeProposals>[1], addressId: string | null) =>
    composeProposals(state, candidates, { seed: opts.seed, addressId,
      ...(opts.ranker ? { ranker: opts.ranker } : {}), ...(opts.groupLimits ? { limits: opts.groupLimits } : {}) });
  const outcome = await exploreGroupCatalog(state, req.query, deps, {
    cache: opts.cache, limits: opts.evaluateLimits, signal: opts.signal,
    accept: (candidates, addressId) => compose(candidates, addressId).proposals.some((p) =>
      p.coverage.length === state.participants.length && p.coverage.every((c) => c.status === 'COVERED')),
  });
  const result = compose(outcome.candidates, outcome.addressId);
  const r = outcome.read;
  const stopText: Record<GroupRead['stop'], string> = {
    COVERED: 'Há proposta com cobertura alimentar de todos; total completo ainda depende do carrinho.',
    DEADLINE: 'Prazo de leitura atingido; a busca ficou parcial.',
    SEARCH_LIMIT: 'Limite de consultas atingido; pode haver outras páginas ou lojas.',
    DETAIL_LIMIT: 'Limite de itens detalhados atingido; pode haver outras opções no catálogo.',
    CANDIDATE_LIMIT: 'Limite de candidatos considerados atingido; pode haver outras opções no catálogo.',
    CATALOG_EXHAUSTED: 'As consultas tentadas não trouxeram mais opções verificáveis; isso não esgota todo o catálogo iFood.',
    READ_ERROR: 'Parte da leitura falhou; não foi interpretada como catálogo vazio.',
    PAGINATION_UNVERIFIED: 'O catálogo indicou outras páginas, mas o cursor ausente ou repetido impediu continuar; a busca ficou incompleta.',
  };
  result.explanation.splice(1, 0, `Exploração: ${r.pagesFetched} consulta(s), ${r.detailed} itens detalhados, ${r.failed} falha(s). ${stopText[r.stop]}`);
  if (r.changed) result.explanation.push('Itens com observações divergentes durante a busca foram bloqueados; peça nova busca para revalidar.');
  if (result.diagnosis.participants.length) {
    const text = (s: string, max: number) => [...s.replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, ' ').trim()].slice(0, max).join('');
    const informative = outcome.candidates.filter((c) => result.matrix.some((cell) =>
      cell.itemId === c.listing.itemId && cell.merchantId === c.listing.merchant.merchantId && cell.status === 'NEEDS_VERIFICATION'));
    for (const c of informative.slice(0, 3)) {
      const affected = result.matrix.filter((cell) => cell.itemId === c.listing.itemId && cell.merchantId === c.listing.merchant.merchantId && cell.status === 'NEEDS_VERIFICATION');
      const names = affected.slice(0, 2).map((cell) => text(state.participants.find((p) => p.participantId === cell.participantId)!.displayName, 24)).join(', ')
        + (affected.length > 2 ? ' e outras pessoas' : '');
      const name = text(val(c.detail.itemName) ?? val(c.listing.itemName) ?? 'Item sem nome', 48);
      const merchant = text(val(c.listing.merchant.name) ?? 'loja sem nome', 32);
      result.explanation.push(`Só informação, não é recomendação: “${name}” (${merchant}). Segurança não verificada para ${names}; item bloqueado para essas pessoas.`);
    }
  }
  return { result, read: r };
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
