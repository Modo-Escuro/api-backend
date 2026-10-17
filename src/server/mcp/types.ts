// Tipos derivados de respostas REAIS do MCP (ver fixtures/). Campos opcionais = podem faltar.
// Não adicionar campos que não apareceram em resposta real.

export interface LatLng {
  latitude: number;
  longitude: number;
}

export interface Address {
  addressId: string;
  formattedAddress?: string;
  alias?: string;
  location?: { street?: string; number?: string; neighborhood?: string; city?: string; state?: string };
  postalCode?: string;
  coordinates?: LatLng;
  isLastUsedAddress?: boolean;
  isMostUsedAddress30d?: boolean;
}

export interface ListAddressesResult {
  results: Address[];
  agentHints?: Record<string, unknown>;
}

export const ITEM_RESTRICTIONS = ['LAC_FREE', 'SUGAR_FREE', 'VEGAN', 'VEGETARIAN', 'ORGANIC', 'GLUTEN_FREE'] as const;
export type ItemRestriction = (typeof ITEM_RESTRICTIONS)[number];

export const SORTS = ['RELEVANCE', 'DELIVERY_FEE', 'DELIVERY_TIME', 'DISTANCE', 'PRICE'] as const;
export type SearchSort = (typeof SORTS)[number];

/** Subconjunto do inputSchema de searchOffers (fixtures/tools-list.json). */
export interface SearchRefinements {
  itemRestrictions?: ItemRestriction[];
  itemTaxonomy?: string[];
  maxDeliveryFee?: number;
  maxDeliveryTimeMinutes?: number;
  maxDistanceKm?: number;
  maxItemPrice?: number;
  maxMinimumOrderAmount?: number;
  merchantId?: string;
  minRating?: number;
  onlyOpen?: boolean;
  onlyWithPromotion?: boolean;
  sort?: SearchSort;
}

export interface SearchOffersArgs {
  query: string;
  userLocation: LatLng;
  resultKind?: 'MERCHANT' | 'ITEM';
  merchantType?: 'RESTAURANT' | 'GROCERIES' | 'LIQUORSTORE' | 'DRUGSTORE' | 'PETSTORE' | 'SHOPPING';
  refinements?: SearchRefinements;
  pageSize?: number;
  nextPageToken?: string;
}

export interface SearchMerchant {
  merchantId: string;
  merchantName?: string;
  merchantLogoUrl?: string;
  isOpen?: boolean;
  minimumOrderAmount?: number;
  ratingCount?: number;
  reviewRating?: number;
  straightLineDistanceKm?: number;
  deliveryMethod?: {
    deliveryMethodId?: string;
    deliveryMethodMode?: string;
    estimatedMinutes?: { min?: number; max?: number };
    fee?: number;
    promotionalFee?: number;
  };
}

export interface SearchItemResult {
  itemId: string;
  itemName?: string;
  itemEan?: string;
  itemImageUrl?: string;
  unitPrice?: number;
  promotionalUnitPrice?: number;
  merchant: SearchMerchant;
}

export interface SearchOffersResult {
  resultKind?: string;
  interpretedQuery?: string;
  hasMore?: boolean;
  nextPageToken?: string;
  results: SearchItemResult[];
  agentHints?: Record<string, unknown>;
}

export interface ItemOption {
  optionId: string;
  name?: string;
  description?: string;
  additionalPrice?: number;
}

export interface OptionGroup {
  optionGroupId: string;
  name?: string;
  minSelections?: number;
  maxSelections?: number;
  options: ItemOption[];
}

export interface GetItemResult {
  itemId: string;
  itemName?: string;
  itemDescription?: string;
  itemImageUrl?: string;
  merchantId: string;
  merchantName?: string;
  merchantMinimumOrderAmount?: number;
  unitPrice?: number;
  promotionalUnitPrice?: number;
  optionGroups?: OptionGroup[];
  appDeeplink?: string;
  agentHints?: Record<string, unknown>;
}
