// Exploração de catálogo limitada a uma intenção de leitura. Não cria turno, aprovação ou carrinho.
import { contentHash } from '../contracts/guards.js';
import { knownRestrictions, type PurchaseState } from '../domain/purchase.js';
import { serverFiltersFor, type RestrictionKey } from '../domain/constraints.js';
import type { CatalogCandidate } from '../domain/group.js';
import { normalizeSearchOffers, type NormalizedListingItem } from '../domain/normalize.js';
import { val } from '../domain/fields.js';
import { ItemCache, runEvaluation, type EvaluateDeps, type EvaluateLimits, type EvaluateOutcome } from './evaluate.js';

export const GROUP_SEARCH_LIMITS: EvaluateLimits = {
  maxPages: 4, pageSize: 20, maxCandidates: 80, maxDetails: 24, concurrency: 4, deadlineMs: 25_000,
};
export interface GroupRead {
  detailed: number; failed: number; pagesFetched: number; deadlineReached: boolean;
  rounds: number; detailCalls: number; candidates: number; changed: number; readErrors: number;
  paginationIncomplete: boolean;
  stop: 'COVERED' | 'DEADLINE' | 'SEARCH_LIMIT' | 'DETAIL_LIMIT' | 'CANDIDATE_LIMIT' | 'CATALOG_EXHAUSTED' | 'READ_ERROR' | 'PAGINATION_UNVERIFIED';
}
class SearchLimit extends Error {}
const identity = (l: NormalizedListingItem) => `${l.merchant.merchantId}:${l.itemId}`;

/** Nenhuma restrição de outra pessoa é imposta ao grupo inteiro; filtros extras são buscas independentes. */
function dietarySearches(state: PurchaseState): RestrictionKey[][] {
  const seen = new Set<string>();
  return state.participants.flatMap((p) => {
    const keys = (knownRestrictions(state, p) ?? []).filter((r) => r.kind === 'DIETARY' && (r.requirement ?? 'MANDATORY') === 'MANDATORY');
    const filters = serverFiltersFor(keys).sort().join(',');
    if (!filters || seen.has(filters)) return [];
    seen.add(filters);
    return [keys];
  }).slice(0, 2);
}

export async function exploreGroupCatalog(
  state: PurchaseState, query: string, deps: EvaluateDeps,
  opts: { cache?: ItemCache; limits?: Partial<EvaluateLimits>; signal?: AbortSignal;
    accept(candidates: CatalogCandidate[], addressId: string | null): boolean },
): Promise<{ candidates: CatalogCandidate[]; addressId: string | null; read: GroupRead }> {
  const limits = { ...GROUP_SEARCH_LIMITS };
  for (const field of Object.keys(limits) as (keyof EvaluateLimits)[]) {
    const n = opts.limits?.[field];
    if (n !== undefined) {
      if (!Number.isSafeInteger(n) || n < (field === 'maxDetails' ? 0 : 1)) throw new Error('Limite de exploração inválido.');
      limits[field] = Math.min(n, limits[field]);
    }
  }
  const now = deps.now ?? Date.now, start = now();
  const remaining = () => limits.deadlineMs - (now() - start);
  const cache = opts.cache ?? new ItemCache();
  const pages = new Map<string, Promise<unknown>>();
  const details = new Map<string, Promise<unknown>>();
  const cursors = new Map<string, Set<string>>();
  const reserved = new Set<string>(), listed = new Set<string>(), failed = new Set<string>(), changed = new Set<string>();
  const pool = new Map<string, CatalogCandidate>();
  let addresses: ReturnType<EvaluateDeps['listAddresses']> | undefined;
  const read: GroupRead = { detailed: 0, failed: 0, pagesFetched: 0, deadlineReached: false,
    rounds: 0, detailCalls: 0, candidates: 0, changed: 0, readErrors: 0, paginationIncomplete: false, stop: 'CATALOG_EXHAUSTED' };
  const check = () => {
    opts.signal?.throwIfAborted();
    if (remaining() < 1_000) { read.deadlineReached = true; throw new SearchLimit(); }
  };
  const bounded: EvaluateDeps = {
    now,
    listAddresses: () => { check(); return addresses ??= deps.listAddresses(); },
    searchOffers: (args, callOpts) => {
      check();
      const key = contentHash(args);
      const hit = pages.get(key);
      if (hit) return hit;
      if (pages.size >= limits.maxPages) throw new SearchLimit();
      read.pagesFetched++;
      const pending = deps.searchOffers(args, { ...callOpts, timeoutMs: Math.min(callOpts.timeoutMs ?? 15_000, remaining()) })
        .then((raw) => {
          const norm = normalizeSearchOffers(raw), token = val(norm.nextPageToken);
          const searchKey = contentHash({ ...args, nextPageToken: null });
          const seen = cursors.get(searchKey) ?? new Set<string>();
          if (val(norm.hasMore) === true && (!token || seen.has(token))) read.paginationIncomplete = true;
          if (token) seen.add(token);
          cursors.set(searchKey, seen);
          return raw;
        })
        .catch((error: unknown) => { read.readErrors++; throw error; });
      pages.set(key, pending); // inclusive falhas: outra fase não repete a mesma leitura
      return pending;
    },
    getItem: (args, callOpts) => {
      check();
      const key = contentHash(args);
      const hit = details.get(key);
      if (hit) return hit;
      read.detailCalls++;
      const pending = deps.getItem(args, { ...callOpts, timeoutMs: Math.min(callOpts.timeoutMs ?? 15_000, remaining()) });
      details.set(key, pending);
      return pending;
    },
  };
  const allow = (listing: NormalizedListingItem) => {
    if (state.merchant.state === 'DECLARED' && listing.merchant.merchantId !== state.merchant.value.merchantId) return false;
    const key = identity(listing);
    if (!listed.has(key) && listed.size >= limits.maxCandidates) return false;
    listed.add(key);
    if (reserved.has(key)) return true;
    if (reserved.size >= limits.maxDetails) return false;
    reserved.add(key);
    return true;
  };
  const stages = [
    { restrictions: [] as RestrictionKey[], maxPages: 1, maxDetails: 6 },
    ...dietarySearches(state).map((restrictions) => ({ restrictions, maxPages: 1, maxDetails: 12 })),
    { restrictions: [] as RestrictionKey[], maxPages: limits.maxPages, maxDetails: limits.maxDetails },
    { restrictions: [] as RestrictionKey[], maxPages: 1, maxDetails: limits.maxDetails, sort: 'PRICE' as const },
  ];
  let addressId: string | null = null;
  for (const stage of stages) {
    opts.signal?.throwIfAborted();
    if (remaining() < 1_000) { read.deadlineReached = true; break; }
    // Mesmo com orçamento de rede esgotado, a fase ampla pode detalhar listagens já recebidas.
    if (stage.sort && pages.size >= limits.maxPages) break;
    let outcome: EvaluateOutcome;
    const errorsBefore = read.readErrors;
    try {
      outcome = await runEvaluation({ query, restrictions: stage.restrictions,
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(state.address.state === 'DECLARED' ? { addressId: state.address.value.addressId } : {}),
        refinements: { ...(stage.sort ? { sort: stage.sort } : {}),
          ...(state.merchant.state === 'DECLARED' ? { merchantId: state.merchant.value.merchantId } : {}) },
        limits: { ...limits, maxPages: Math.min(stage.maxPages, limits.maxPages),
          maxDetails: Math.min(stage.maxDetails, limits.maxDetails), deadlineMs: remaining() },
        detailPolicy: { diversifyMerchants: true, allow },
      }, bounded, cache);
    } catch (error) {
      opts.signal?.throwIfAborted();
      if (!(error instanceof SearchLimit)) {
        if (!read.rounds) throw error;
        if (read.readErrors === errorsBefore) read.readErrors++;
      }
      continue;
    }
    read.rounds++;
    read.deadlineReached ||= outcome.deadlineReached;
    addressId = outcome.location.addressId;
    for (const c of outcome.candidates) {
      const key = identity(c.listing);
      if (listed.size < limits.maxCandidates) listed.add(key);
      if (!listed.has(key) || changed.has(key)) continue;
      if (c.detail.status === 'FAILED') { failed.add(key); continue; }
      if (c.detail.status !== 'DETAILED') continue;
      const next: CatalogCandidate = { listing: c.listing, detail: c.detail.detail, serverFilters: c.serverFilters };
      const prior = pool.get(key);
      if (prior && contentHash([prior.listing, prior.detail]) !== contentHash([next.listing, next.detail])) {
        pool.delete(key); changed.add(key); continue; // observações conflitantes não acumulam evidência
      }
      if (prior) next.serverFilters = [...new Set([...prior.serverFilters, ...next.serverFilters])];
      pool.set(key, next);
    }
    if (opts.accept([...pool.values()], addressId)) { read.stop = 'COVERED'; break; }
  }
  if (read.stop !== 'COVERED') read.stop = read.deadlineReached ? 'DEADLINE'
    : read.readErrors || failed.size || changed.size ? 'READ_ERROR' : read.paginationIncomplete ? 'PAGINATION_UNVERIFIED'
    : reserved.size >= limits.maxDetails ? 'DETAIL_LIMIT'
    : listed.size >= limits.maxCandidates ? 'CANDIDATE_LIMIT' : pages.size >= limits.maxPages ? 'SEARCH_LIMIT' : 'CATALOG_EXHAUSTED';
  read.detailed = pool.size; read.failed = failed.size; read.candidates = listed.size; read.changed = changed.size;
  return { candidates: [...pool.values()], addressId, read };
}
