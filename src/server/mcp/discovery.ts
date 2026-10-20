import type { CallOptions } from './tools.js';

/** Extensões de descoberta ligadas exclusivamente à sessão autenticada do vínculo. */
export type DiscoveryName = 'browseOffers' | 'getRecommendations' | 'getMerchant';
export type DiscoveryReader = (name: DiscoveryName, args: Record<string, unknown>, options: CallOptions) => Promise<unknown>;
