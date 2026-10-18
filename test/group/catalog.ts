// Catálogo SINTÉTICO no formato observado das respostas MCP (searchOffers/getItem), passando pela normalização real.
// Só para testes de composição (GRP-01); IDs fictícios em formato UUID, nenhum dado de conta real.
import type { CatalogCandidate } from '../../src/server/domain/group';
import { normalizeItemDetail, normalizeListingItem } from '../../src/server/domain/normalize';
import type { ItemRestriction } from '../../src/server/mcp/types';

export const M1 = '11111111-1111-4111-8111-111111111111';
export const M2 = '22222222-2222-4222-8222-222222222222';
let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

export interface ItemSpec {
  name: string;
  description?: string;
  /** BRL (formato do MCP); null = preço ausente. */
  price: number | null;
  merchantId?: string;
  fee?: number | null;
  minimumOrder?: number;
  etaMax?: number;
  filters?: ItemRestriction[];
  itemId?: string;
}

export function candidate(spec: ItemSpec): CatalogCandidate {
  const itemId = spec.itemId ?? uuid();
  const merchantId = spec.merchantId ?? M1;
  const delivery = spec.fee === null
    ? { deliveryMethodId: 'DEFAULT', deliveryMethodMode: 'DELIVERY', estimatedMinutes: { max: spec.etaMax ?? 40, min: 30 } }
    : { deliveryMethodId: 'DEFAULT', deliveryMethodMode: 'DELIVERY', estimatedMinutes: { max: spec.etaMax ?? 40, min: 30 }, fee: spec.fee ?? 7.99 };
  const merchant = { deliveryMethod: delivery, isOpen: true, merchantId, merchantName: `Loja ${merchantId.slice(0, 4)}`,
    minimumOrderAmount: spec.minimumOrder ?? 0, ratingCount: 10, reviewRating: 4.5, straightLineDistanceKm: 1 };
  const price = spec.price === null ? {} : { unitPrice: spec.price, promotionalUnitPrice: spec.price };
  const listing = normalizeListingItem({ itemEan: '', itemId, itemName: spec.name, merchant, ...price });
  const detail = normalizeItemDetail({ itemId, merchantId, itemName: spec.name, itemDescription: spec.description ?? spec.name,
    merchantName: merchant.merchantName, merchantMinimumOrderAmount: spec.minimumOrder ?? 0, ...price, optionGroups: [] });
  return { listing, detail, serverFilters: spec.filters ?? [] };
}
