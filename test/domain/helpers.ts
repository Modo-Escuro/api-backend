import { readFileSync } from 'node:fs';
import { normalizeItemDetail, normalizeSearchOffers, type NormalizedListingItem } from '../../src/server/domain/normalize';

export const fx = (name: string) => JSON.parse(readFileSync(`fixtures/${name}`, 'utf8'));

/** Respostas reais de getItem (fixtures/getItem-samples.json) por nome. */
export function rawItem(name: string): Record<string, unknown> {
  const all = [...fx('getItem-samples.json'), ...fx('getItem-pricing-audit.json')] as Record<string, unknown>[];
  const it = all.find((i) => i.itemName === name);
  if (!it) throw new Error(`fixture sem item ${name}`);
  return structuredClone(it);
}
export const item = (name: string) => normalizeItemDetail(rawItem(name));

/** Item da listagem real correspondente (mesmo itemId). */
export function listingFor(itemId: string): NormalizedListingItem {
  for (const f of ['searchOffers-pizza.json', 'searchOffers-hamburguer-vegan.json', 'searchOffers-acai.json', 'searchOffers-lanche-glutenfree.json']) {
    const hit = normalizeSearchOffers(fx(f)).items.find((i) => i.itemId === itemId);
    if (hit) return hit;
  }
  throw new Error(`sem listagem para ${itemId}`);
}

export function optionId(detail: ReturnType<typeof item>, optionName: string): string {
  for (const g of detail.optionGroups.state === 'PRESENT' ? detail.optionGroups.value : [])
    for (const o of g.options) if (o.name.state === 'PRESENT' && o.name.value === optionName) return o.optionId;
  throw new Error(`opção ${optionName} não encontrada`);
}
