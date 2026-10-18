// Duplas das integrações do pipeline /api/evaluate: fixtures REAIS de respostas do MCP + fakes de rede.
// Endereço e "item sem fixture" são SINTÉTICOS (fixtures nunca guardam dados pessoais).
import { readFileSync } from 'node:fs';
import { McpToolError } from '../../src/server/mcp/errors';
import type { SearchOffersArgs } from '../../src/server/mcp/types';
import type { EvaluateDeps } from '../../src/server/services/evaluate';

export const fx = (n: string) => JSON.parse(readFileSync(`fixtures/${n}`, 'utf8'));
export const ITEMS = new Map<string, unknown>(
  [...fx('getItem-samples.json'), ...fx('getItem-pricing-audit.json')].map((i: { itemId: string }) => [i.itemId, i]),
);
export const ADDRESS = { addressId: 'addr-test-1', alias: 'Casa', coordinates: { latitude: -1.5, longitude: -2.5 } };

export interface Fake extends EvaluateDeps {
  searchCalls: SearchOffersArgs[];
  getItemCalls: string[];
}

export function fake(opts: { pages?: unknown[]; getItemError?: (id: string, n: number) => Error | null; addresses?: unknown[]; now?: () => number } = {}): Fake {
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
