// Pipeline read-only de avaliação (F2/F3/F4 integradas).
//   localização → searchOffers (paginado) → normalize → getItem (limitado, paralelo, com cache)
//   → normalize → constraints/configuration/pricing/eligibility → classificação (ELIGIBLE/BLOCKED/
//   NEEDS_VERIFICATION) → ranking dos ELEGIBLE (domínio puro, sem chamadas MCP novas)
// Somente tools de leitura. Toda chamada MCP tem timeout e há um prazo total por requisição.

import { NormalizationError, normalizeItemDetail, normalizeSearchOffers, type NormalizedItemDetail, type NormalizedListingItem } from '../domain/normalize.js';
import { requirementOf, serverFiltersFor, type RestrictionKey } from '../domain/constraints.js';
import { evaluateCandidate, type Budget, type EligibilityResult } from '../domain/eligibility.js';
import { classifyBlockers, rankCandidates, type EligibilityCategory, type RankingResult, type UserPreferences } from '../domain/ranking.js';
import { McpToolError } from '../mcp/errors.js';
import type { CallOptions } from '../mcp/tools.js';
import type { Address, ItemRestriction, LatLng, ListAddressesResult, SearchOffersArgs, SearchRefinements } from '../mcp/types.js';
import { val } from '../domain/fields.js';
import { centsToBrl } from '../domain/money.js';
import type { CandidateLimits } from '../domain/limits.js';

// ---------------- dependências (injetáveis para testes) ----------------

export interface EvaluateDeps {
  listAddresses(): Promise<ListAddressesResult>;
  /** Payload cru de searchOffers (já sem erro inline). */
  searchOffers(args: SearchOffersArgs, opts: CallOptions): Promise<unknown>;
  /** Payload cru de getItem (já sem erro inline). */
  getItem(args: { itemId: string; merchantId: string; userLocation: LatLng }, opts: CallOptions): Promise<unknown>;
  now?(): number;
}

// ---------------- entrada ----------------

export interface EvaluateLimits {
  /** Páginas de searchOffers (default 2). */
  maxPages: number;
  /** pageSize de searchOffers (default 20; máx. do MCP: 25). */
  pageSize: number;
  /** Candidatos únicos considerados (default 40). */
  maxCandidates: number;
  /** Candidatos detalhados via getItem (default 10). */
  maxDetails: number;
  /** getItem simultâneos (default 4). */
  concurrency: number;
  /** Prazo total da requisição (ms, default 25000). */
  deadlineMs: number;
}

export const DEFAULT_LIMITS: EvaluateLimits = {
  maxPages: 2,
  pageSize: 20,
  maxCandidates: 40,
  maxDetails: 10,
  concurrency: 4,
  deadlineMs: 25_000,
};

export interface EvaluateRequest {
  query: string;
  /** Um dos dois; se nenhum, usa o único endereço salvo. addressId precisa vir de listAddresses. */
  addressId?: string;
  userLocation?: LatLng;
  restrictions: RestrictionKey[];
  budget?: Budget;
  quantity?: number;
  merchantType?: SearchOffersArgs['merchantType'];
  /** Repassados ao searchOffers (contexto: distância, tempo, avaliação, promoção, ordenação). */
  refinements?: Pick<SearchRefinements, 'maxDistanceKm' | 'maxDeliveryTimeMinutes' | 'minRating' | 'onlyWithPromotion' | 'maxDeliveryFee' | 'sort'>;
  /** Prioridade declarada D9 e preferências flexíveis; nunca alteram elegibilidade. */
  preferences?: UserPreferences;
  /** Alvos flexíveis: não são filtros MCP nem bloqueiam elegibilidade. Frete em centavos. */
  softLimits?: CandidateLimits;
  limits?: Partial<EvaluateLimits>;
}

export class EvaluateInputError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

// ---------------- saída (interna; a view formata para a API) ----------------

export type DetailOutcome =
  | { status: 'DETAILED'; detail: NormalizedItemDetail; cached: boolean }
  | { status: 'SKIPPED_CLOSED' | 'SKIPPED_LIMIT' | 'SKIPPED_DEADLINE' }
  | { status: 'FAILED'; error: { message: string; code: string | null; retryable: boolean | null; kind: string; agentInstruction?: string | null } };

export interface EvaluatedCandidate {
  listing: NormalizedListingItem;
  serverFilters: ItemRestriction[];
  page: number;
  detail: DetailOutcome;
  evaluation: EligibilityResult;
  /** ELIGIBLE | BLOCKED | NEEDS_VERIFICATION — derivada dos blockers (domain/ranking.ts). */
  category: EligibilityCategory;
}

export interface EvaluateOutcome {
  query: string;
  interpretedQuery: string | null;
  location: { source: 'ADDRESS_SINGLE' | 'ADDRESS_ID' | 'REQUEST'; addressId: string | null; alias: string | null };
  serverFilters: ItemRestriction[];
  search: {
    pagesFetched: number;
    hasMore: boolean | null;
    candidates: number;
    duplicatesRemoved: number;
    normalizationSkipped: { page: number; index: number; reason: string }[];
    pageErrors: { page: number; message: string; code: string | null; retryable: boolean | null }[];
  };
  details: { requested: number; detailed: number; fromCache: number; failed: number; skippedLimit: number; skippedClosed: number; skippedDeadline: number };
  candidates: EvaluatedCandidate[];
  /** Ranking dos candidatos ELIGIBLE (pesos, notas e no máximo 4 recomendações). */
  ranking: RankingResult;
  limits: EvaluateLimits;
  durationMs: number;
  deadlineReached: boolean;
}

// ---------------- helpers ----------------

async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}

function errorInfo(e: unknown) {
  if (e instanceof McpToolError) {
    return {
      kind: 'MCP_TOOL_ERROR',
      message: e.message,
      code: e.code ?? null,
      retryable: e.errors.some((x) => x.retryable !== undefined) ? e.retryable : null,
      agentInstruction: e.errors.find((x) => x.agentInstruction)?.agentInstruction ?? null,
    };
  }
  if (e instanceof NormalizationError) return { kind: 'NORMALIZATION_ERROR', message: e.message, code: null, retryable: false };
  const msg = e instanceof Error ? e.message : String(e);
  // Timeout do SDK MCP (McpError -32001) ou abort.
  const timeout = /timed? ?out|timeout|aborted/i.test(msg);
  return { kind: timeout ? 'TIMEOUT' : 'TRANSPORT_ERROR', message: msg, code: null, retryable: timeout ? true : null };
}

/** Cache de getItem (TTL ~60s, requirements §4). Chave inclui a localização arredondada (~100 m). */
export class ItemCache {
  private map = new Map<string, { at: number; value: unknown }>();
  constructor(
    private ttlMs = 60_000,
    private max = 500,
  ) {}
  key(a: { itemId: string; merchantId: string; userLocation: LatLng }) {
    return `${a.merchantId}:${a.itemId}:${a.userLocation.latitude.toFixed(3)},${a.userLocation.longitude.toFixed(3)}`;
  }
  get(k: string, now: number): unknown | undefined {
    const e = this.map.get(k);
    if (!e) return undefined;
    if (now - e.at > this.ttlMs) {
      this.map.delete(k);
      return undefined;
    }
    return e.value;
  }
  set(k: string, value: unknown, now: number) {
    if (this.map.size >= this.max) this.map.delete(this.map.keys().next().value!);
    this.map.set(k, { at: now, value });
  }
}

const MIN_CALL_MS = 1_000;

// ---------------- pipeline ----------------

export async function runEvaluation(req: EvaluateRequest, deps: EvaluateDeps, cache = new ItemCache()): Promise<EvaluateOutcome> {
  const now = deps.now ?? Date.now;
  const t0 = now();
  const limits: EvaluateLimits = { ...DEFAULT_LIMITS, ...req.limits };
  limits.pageSize = Math.min(limits.pageSize, 25);
  const remaining = () => limits.deadlineMs - (now() - t0);
  const callOpts = (): CallOptions => ({ timeoutMs: Math.min(15_000, remaining()) });
  let deadlineReached = false;

  const query = req.query.trim();
  if (!query) throw new EvaluateInputError('`query` deve ter texto descritivo (qualificadores vão em refinements/budget)', 'QUERY_REQUIRED');
  for (const r of req.restrictions) requirementOf(r); // valida alergia≠preferência

  // ---- localização
  let userLocation: LatLng;
  let location: EvaluateOutcome['location'];
  if (req.userLocation && !req.addressId) {
    userLocation = req.userLocation;
    location = { source: 'REQUEST', addressId: null, alias: null };
  } else {
    const { results } = await deps.listAddresses();
    const addresses: Address[] = results ?? [];
    let addr: Address | undefined;
    if (req.addressId) {
      addr = addresses.find((a) => a.addressId === req.addressId);
      if (!addr) throw new EvaluateInputError('addressId não pertence à lista retornada por listAddresses', 'ADDRESS_NOT_FOUND');
    } else if (addresses.length === 1) addr = addresses[0];
    else if (addresses.length === 0) throw new EvaluateInputError('Nenhum endereço salvo na conta iFood — informe userLocation', 'NO_ADDRESS');
    else throw new EvaluateInputError(`${addresses.length} endereços salvos — informe addressId`, 'ADDRESS_AMBIGUOUS');
    if (!addr!.coordinates) throw new EvaluateInputError('Endereço sem coordinates no iFood', 'ADDRESS_WITHOUT_COORDINATES');
    userLocation = addr!.coordinates;
    location = { source: req.addressId ? 'ADDRESS_ID' : 'ADDRESS_SINGLE', addressId: addr!.addressId, alias: addr!.alias ?? null };
  }

  // ---- busca (apenas restrições OBRIGATÓRIAS viram filtro server-side; preferência não pode excluir itens)
  const mandatory = req.restrictions.filter((r) => requirementOf(r) === 'MANDATORY');
  const serverFilters = serverFiltersFor(mandatory);
  const refinements: SearchRefinements = { ...req.refinements };
  if (req.refinements?.maxDeliveryFee !== undefined) refinements.maxDeliveryFee = centsToBrl(req.refinements.maxDeliveryFee);
  if (serverFilters.length) refinements.itemRestrictions = serverFilters;

  const seen = new Set<string>();
  const listings: { listing: NormalizedListingItem; page: number }[] = [];
  const search: EvaluateOutcome['search'] = { pagesFetched: 0, hasMore: null, candidates: 0, duplicatesRemoved: 0, normalizationSkipped: [], pageErrors: [] };
  let interpretedQuery: string | null = null;
  let token: string | undefined;
  for (let page = 1; page <= limits.maxPages; page++) {
    if (remaining() < MIN_CALL_MS) {
      deadlineReached = true;
      break;
    }
    const args: SearchOffersArgs = {
      query,
      userLocation,
      resultKind: 'ITEM',
      pageSize: limits.pageSize,
      ...(req.merchantType ? { merchantType: req.merchantType } : {}),
      ...(Object.keys(refinements).length ? { refinements } : {}),
      ...(token ? { nextPageToken: token } : {}),
    };
    let raw: unknown;
    try {
      raw = await deps.searchOffers(args, callOpts());
    } catch (e) {
      if (page === 1) throw e; // sem nenhuma página não há o que avaliar
      const info = errorInfo(e);
      search.pageErrors.push({ page, message: info.message, code: info.code, retryable: info.retryable });
      break;
    }
    const norm = normalizeSearchOffers(raw);
    search.pagesFetched = page;
    interpretedQuery ??= val(norm.interpretedQuery) ?? null;
    for (const s of norm.skipped) search.normalizationSkipped.push({ page, ...s });
    for (const l of norm.items) {
      if (seen.has(l.itemId)) {
        search.duplicatesRemoved++;
        continue;
      }
      seen.add(l.itemId);
      if (listings.length < limits.maxCandidates) listings.push({ listing: l, page });
    }
    search.hasMore = val(norm.hasMore) ?? null;
    token = val(norm.nextPageToken);
    if (!token || search.hasMore === false || listings.length >= limits.maxCandidates) break;
  }
  search.candidates = listings.length;

  // ---- detalhamento: loja fechada não é detalhada; demais na ordem da busca até maxDetails
  const outcomes: DetailOutcome[] = listings.map(() => ({ status: 'SKIPPED_LIMIT' }));
  const toDetail: number[] = [];
  listings.forEach(({ listing }, i) => {
    if (val(listing.merchant.isOpen) === false) outcomes[i] = { status: 'SKIPPED_CLOSED' };
    else if (toDetail.length < limits.maxDetails) toDetail.push(i);
  });

  await mapLimit(toDetail, limits.concurrency, async (i) => {
    const { listing } = listings[i]!;
    const args = { itemId: listing.itemId, merchantId: listing.merchant.merchantId, userLocation };
    const key = cache.key(args);
    const hit = cache.get(key, now());
    let raw = hit;
    if (raw === undefined) {
      for (let attempt = 1; attempt <= 2; attempt++) {
        if (remaining() < MIN_CALL_MS) {
          deadlineReached = true;
          outcomes[i] = { status: 'SKIPPED_DEADLINE' };
          return;
        }
        try {
          raw = await deps.getItem(args, callOpts());
          cache.set(key, raw, now());
          break;
        } catch (e) {
          const info = errorInfo(e);
          // Retry só quando o erro se declara retryable (CLAUDE.md regra 7 / requirements §4).
          if (attempt === 1 && info.retryable === true && info.kind === 'MCP_TOOL_ERROR') continue;
          outcomes[i] = { status: 'FAILED', error: info };
          return;
        }
      }
    }
    try {
      outcomes[i] = { status: 'DETAILED', detail: normalizeItemDetail(raw), cached: hit !== undefined };
    } catch (e) {
      outcomes[i] = { status: 'FAILED', error: errorInfo(e) };
    }
  });

  // ---- avaliação determinística (domain/*)
  const constraints = { restrictions: req.restrictions, budget: req.budget,
    mandatoryLimits: req.refinements, preferredLimits: req.softLimits };
  const candidates: EvaluatedCandidate[] = listings.map(({ listing, page }, i) => {
    const outcome = outcomes[i]!;
    let detail: NormalizedItemDetail | null = outcome.status === 'DETAILED' ? outcome.detail : null;
    // getItem que voltou com IDs diferentes não é aceito (nunca misturar itens).
    if (detail && (detail.itemId !== listing.itemId || detail.merchantId !== listing.merchant.merchantId)) {
      outcomes[i] = { status: 'FAILED', error: { kind: 'ID_MISMATCH', message: 'getItem retornou IDs diferentes da listagem', code: null, retryable: false } };
      detail = null;
    }
    const evaluation = evaluateCandidate({ listing, detail, serverFilters, quantity: req.quantity }, constraints);
    return { listing, serverFilters, page, detail: outcomes[i]!, evaluation, category: classifyBlockers(evaluation.blockers) };
  });

  // ---- ranking (F4): só ELEGIBLE, dados já coletados — nenhuma chamada MCP nova, nenhuma escrita.
  const rankable = candidates
    .filter((c) => c.category === 'ELIGIBLE')
    .map((c) => ({ evaluation: c.evaluation, listing: c.listing, detail: c.detail.status === 'DETAILED' ? c.detail.detail : null }));
  // Separa alvos flexíveis de limites rígidos, já validados na elegibilidade (DOM-01).
  const ranking = rankCandidates(rankable, req.preferences, req.softLimits, constraints);

  const count = (s: DetailOutcome['status']) => outcomes.filter((o) => o.status === s).length;
  return {
    query,
    interpretedQuery,
    location,
    serverFilters,
    search,
    details: {
      requested: toDetail.length,
      detailed: count('DETAILED'),
      fromCache: outcomes.filter((o) => o.status === 'DETAILED' && o.cached).length,
      failed: count('FAILED'),
      skippedLimit: count('SKIPPED_LIMIT'),
      skippedClosed: count('SKIPPED_CLOSED'),
      skippedDeadline: count('SKIPPED_DEADLINE'),
    },
    candidates,
    ranking,
    limits,
    durationMs: now() - t0,
    deadlineReached,
  };
}
