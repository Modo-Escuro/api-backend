// Integração do pipeline /api/evaluate com respostas REAIS salvas (fixtures/), sem rede.
// Endereço e erros de getItem são sintéticos (rotulados) — fixtures não guardam dados pessoais.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { McpToolError } from '../../src/server/mcp/errors';
import type { SearchOffersArgs } from '../../src/server/mcp/types';
import { ItemCache, runEvaluation, type EvaluateDeps } from '../../src/server/services/evaluate';
import { evaluateView } from '../../src/server/services/evaluate-view';

const fx = (n: string) => JSON.parse(readFileSync(`fixtures/${n}`, 'utf8'));
const ITEMS = new Map<string, unknown>(
  [...fx('getItem-samples.json'), ...fx('getItem-pricing-audit.json')].map((i: { itemId: string }) => [i.itemId, i]),
);
// Endereço SINTÉTICO (teste).
const ADDRESS = { addressId: 'addr-test-1', alias: 'Casa', coordinates: { latitude: -1.5, longitude: -2.5 } };

interface Fake extends EvaluateDeps {
  searchCalls: SearchOffersArgs[];
  getItemCalls: string[];
}

function fake(opts: { pages?: unknown[]; getItemError?: (id: string, n: number) => Error | null; addresses?: unknown[]; now?: () => number } = {}): Fake {
  // Default: a página real de pizza marcada como última (sem nextPageToken).
  const pages = opts.pages ?? [{ ...fx('searchOffers-pizza.json'), hasMore: false, nextPageToken: undefined }];
  const searchCalls: SearchOffersArgs[] = [];
  const getItemCalls: string[] = [];
  return {
    searchCalls,
    getItemCalls,
    now: opts.now,
    listAddresses: async () => ({ results: (opts.addresses ?? [ADDRESS]) as never }),
    searchOffers: async (args) => {
      searchCalls.push(structuredClone(args));
      const p = pages[searchCalls.length - 1];
      if (p instanceof Error) throw p;
      if (!p) throw new Error('sem página');
      return structuredClone(p);
    },
    getItem: async ({ itemId }) => {
      getItemCalls.push(itemId);
      const n = getItemCalls.filter((x) => x === itemId).length;
      const err = opts.getItemError?.(itemId, n);
      if (err) throw err;
      const it = ITEMS.get(itemId);
      // SINTÉTICO: item sem fixture é tratado como indisponível.
      if (!it) throw new McpToolError('getItem', [{ message: 'item indisponível (sintético: sem fixture)' }]);
      return structuredClone(it);
    },
  };
}

const VEGAN = { kind: 'DIETARY', code: 'VEGAN' } as const;
const byName = (list: ReturnType<typeof evaluateView>['eligible'], name: string) => list.find((c) => c.item.name === name);

describe('runEvaluation + view (fixtures reais)', () => {
  it('restrição obrigatória vira filtro server-side e é avaliada item a item', async () => {
    const deps = fake({ pages: [fx('searchOffers-hamburguer-vegan.json')] });
    const v = evaluateView(await runEvaluation({ query: 'hamburguer', restrictions: [VEGAN] }, deps));
    expect(deps.searchCalls[0]).toMatchObject({ query: 'hamburguer', resultKind: 'ITEM', refinements: { itemRestrictions: ['VEGAN'] } });
    expect(deps.searchCalls[0]!.userLocation).toEqual(ADDRESS.coordinates);
    expect(v.location).toEqual({ source: 'ADDRESS_SINGLE', addressId: 'addr-test-1', alias: 'Casa' });

    const brooks = byName(v.eligible, 'Vegano Brooks')!;
    expect(brooks.restrictions[0]).toMatchObject({ status: 'PASS', source: 'SERVER_FILTER', coversOptions: false });
    expect(brooks.restrictions[0]!.blockedOptions).toEqual([expect.objectContaining({ name: 'Nuggets de frango' })]);
    expect(brooks.pricing.minimumConfigurable).toMatchObject({ status: 'ESTIMATED', itemsAndDeliverySubtotal: 4290, estimatedTotal: null });
    expect(brooks.pricing.confirmedTotal).toBeNull();

    // Conflito filtro × descrição ("muçarela", "maionese") ⇒ UNKNOWN ⇒ bloqueado (obrigatória)
    const maria = byName(v.blocked, 'Maria salada Veg')!;
    expect(maria.restrictions[0]).toMatchObject({ status: 'UNKNOWN', source: 'CONFLICT' });
    expect(maria.blockers.map((b) => b.code)).toEqual(['RESTRICTION_UNVERIFIED']);

    // Sem getItem (sem fixture) ⇒ bloqueado com motivo e erro preservados
    const failed = v.blocked.filter((c) => c.detail.status === 'FAILED');
    expect(failed.length).toBeGreaterThan(0);
    expect(failed[0]!.detail.error).toMatchObject({ kind: 'MCP_TOOL_ERROR' });
    expect(failed[0]!.blockers.map((b) => b.code)).toContain('NOT_DETAILED');
    expect(v.summary.eligible + v.summary.blocked).toBe(v.summary.candidates);
  });

  it('preferência não vira filtro server-side (não pode excluir itens)', async () => {
    const deps = fake();
    const v = evaluateView(await runEvaluation({ query: 'pizza', restrictions: [{ ...VEGAN, requirement: 'PREFERENCE' }] }, deps));
    expect(deps.searchCalls[0]!.refinements).toBeUndefined();
    expect(v.serverFilters).toEqual([]);
  });

  it('pizza com teto 100: faixa 65–143 preservada, orçamento não verificável ⇒ bloqueada', async () => {
    const v = evaluateView(await runEvaluation({ query: 'pizza', restrictions: [], budget: { maxItemPrice: 10000 } }, fake()));
    const pizza = v.blocked.find((c) => c.item.name === 'Promoção pizza grande')!;
    expect(pizza.pricing.minimumConfigurable).toMatchObject({ status: 'UNCERTAIN', unitTotal: null, flags: ['AMBIGUOUS_OPTION_PRICING'] });
    expect(pizza.pricing.minimumConfigurable!.interpretations.map((i) => i.id)).toEqual(['BASE_PLUS_OPTIONS', 'OPTIONS_ARE_PRICE']);
    expect(pizza.blockers.map((b) => b.code)).toEqual(['ITEM_BUDGET_UNVERIFIED']);
    expect(pizza.listingPrice).toEqual({ unitPrice: 7800, promotionalUnitPrice: 7800, definitive: false });
    expect(v.summary.blockerCounts.ITEM_BUDGET_UNVERIFIED).toBeGreaterThan(0);
  });

  it('paginação: segue nextPageToken, remove duplicados, respeita maxPages', async () => {
    const p1 = fx('searchOffers-pizza.json');
    const deps = fake({ pages: [p1, p1, fx('searchOffers-acai.json')] });
    const v = evaluateView(await runEvaluation({ query: 'pizza', restrictions: [], limits: { maxPages: 2 } }, deps));
    expect(deps.searchCalls).toHaveLength(2);
    expect(deps.searchCalls[1]!.nextPageToken).toBe(p1.nextPageToken);
    expect(v.search).toMatchObject({ pagesFetched: 2, duplicatesRemoved: 5, candidates: 5 });
  });

  it('para quando hasMore=false e limita maxCandidates', async () => {
    const last = { ...fx('searchOffers-acai.json'), hasMore: false };
    const deps = fake({ pages: [last, fx('searchOffers-pizza.json')] });
    const v = evaluateView(await runEvaluation({ query: 'açaí', restrictions: [], limits: { maxCandidates: 7, maxDetails: 3 } }, deps));
    expect(deps.searchCalls).toHaveLength(1);
    expect(v.search.candidates).toBe(7);
    expect(v.details).toMatchObject({ requested: 3, skippedLimit: 4 });
    expect(deps.getItemCalls).toHaveLength(3);
    expect(v.blocked.filter((c) => c.detail.status === 'SKIPPED_LIMIT')).toHaveLength(4);
  });

  it('erro na página 2 ⇒ resultado parcial com pageErrors', async () => {
    const err = new McpToolError('searchOffers', [{ message: 'falha sintética', code: 'X', retryable: true }]);
    const v = evaluateView(await runEvaluation({ query: 'pizza', restrictions: [] }, fake({ pages: [fx('searchOffers-pizza.json'), err] })));
    expect(v.search.pagesFetched).toBe(1);
    expect(v.search.pageErrors).toEqual([{ page: 2, message: 'falha sintética', code: 'X', retryable: true }]);
  });

  it('loja fechada não é detalhada', async () => {
    const page = fx('searchOffers-pizza.json');
    page.results[0].merchant.isOpen = false;
    const deps = fake({ pages: [page] });
    const v = evaluateView(await runEvaluation({ query: 'pizza', restrictions: [] }, deps));
    expect(deps.getItemCalls).not.toContain(page.results[0].itemId);
    const closed = v.blocked.find((c) => c.itemId === page.results[0].itemId)!;
    expect(closed.detail.status).toBe('SKIPPED_CLOSED');
    expect(closed.blockers.map((b) => b.code)).toEqual(['MERCHANT_CLOSED', 'NOT_DETAILED']);
  });

  it('retry só para erro declarado retryable', async () => {
    const pizzaId = '45a7249f-52b5-4d83-ab89-0424f13f88de';
    const flaky = fake({ getItemError: (id, n) => (id === pizzaId && n === 1 ? new McpToolError('getItem', [{ message: 'tente de novo', retryable: true }]) : null) });
    const v1 = evaluateView(await runEvaluation({ query: 'pizza', restrictions: [] }, flaky));
    expect(flaky.getItemCalls.filter((x) => x === pizzaId)).toHaveLength(2);
    expect(v1.eligible.find((c) => c.itemId === pizzaId)?.detail.status).toBe('DETAILED');

    const hard = fake({ getItemError: (id) => (id === pizzaId ? new McpToolError('getItem', [{ message: 'não', retryable: false }]) : null) });
    const v2 = evaluateView(await runEvaluation({ query: 'pizza', restrictions: [] }, hard));
    expect(hard.getItemCalls.filter((x) => x === pizzaId)).toHaveLength(1);
    expect(v2.blocked.find((c) => c.itemId === pizzaId)!.detail.error).toMatchObject({ retryable: false });
  });

  it('prazo total: getItem restantes não são chamados após o deadline', async () => {
    let t = 0;
    const deps = fake({ now: () => t });
    const orig = deps.getItem;
    deps.getItem = async (a, o) => {
      t += 3_000; // cada getItem "leva" 3 s
      return orig(a, o);
    };
    const v = evaluateView(await runEvaluation({ query: 'pizza', restrictions: [], limits: { deadlineMs: 5_000, concurrency: 1 } }, deps));
    expect(v.deadlineReached).toBe(true);
    expect(v.details.skippedDeadline).toBeGreaterThan(0);
    expect(v.blocked.some((c) => c.detail.status === 'SKIPPED_DEADLINE')).toBe(true);
  });

  it('cache de getItem entre requisições', async () => {
    const cache = new ItemCache();
    const last = { ...fx('searchOffers-pizza.json'), hasMore: false };
    const deps = fake({ pages: [last, last] });
    const first = await runEvaluation({ query: 'pizza', restrictions: [] }, deps, cache);
    const n = deps.getItemCalls.length;
    const second = await runEvaluation({ query: 'pizza', restrictions: [] }, deps, cache);
    // Sucessos vêm do cache; falhas não são cacheadas e são tentadas de novo.
    expect(first.details.detailed).toBeGreaterThan(0);
    expect(second.details.fromCache).toBe(first.details.detailed);
    expect(deps.getItemCalls.length - n).toBe(first.details.failed);
  });

  it('campos ausentes aparecem em missingFields (não viram zero/vazio)', async () => {
    const page = fx('searchOffers-pizza.json');
    delete page.results[0].merchant.reviewRating;
    const v = evaluateView(await runEvaluation({ query: 'pizza', restrictions: [] }, fake({ pages: [page] })));
    const c = [...v.eligible, ...v.blocked].find((x) => x.itemId === page.results[0].itemId)!;
    expect(c.merchant.rating).toBeNull();
    expect(c.missingFields['merchant.rating']).toBe('ABSENT');
    expect(c.item.ingredientsAndAllergens).toBe('NOT_PROVIDED_BY_IFOOD');
  });
});
