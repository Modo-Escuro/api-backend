import { contentHash, ContractError } from '../contracts/guards.js';
import { evaluateCandidate } from '../domain/eligibility.js';
import { val } from '../domain/fields.js';
import { centsToBrl, formatCents } from '../domain/money.js';
import { normalizeItemDetail, normalizeSearchOffers, type NormalizedItemDetail, type NormalizedListingItem } from '../domain/normalize.js';
import { serverFiltersFor } from '../domain/constraints.js';
import type { ItemRestriction } from '../mcp/types.js';
import type { MemoryPurpose, PersonProfile } from './memory.js';
import type { IfoodLinkService, OperationalContext } from '../links/service.js';
import { McpToolError } from '../mcp/errors.js';
import type { SearchOffersArgs, SearchRefinements } from '../mcp/types.js';
import { AddressError, parseAddressList } from '../services/address-reference.js';
import type { AssistantRequest } from './protocol.js';
import type { CatalogCandidate } from '../domain/group.js';

export const safeText = (s: string, max = 180) => [...s.replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, ' ').trim()].slice(0, max).join('');
interface ObservedItem { ref: string; merchantRef: string; listing: NormalizedListingItem; detail?: NormalizedItemDetail; serverFilters: ItemRestriction[] }
type Links = Pick<IfoodLinkService, 'withOperational' | 'status'>;
export interface AssistantToolOptions {
  links: Links;
  organizerId: string;
  linkId: string | null;
  signal: AbortSignal;
  selectedAddress(linkId: string): { addressId: string; addressHash: string };
}

/** IDs reais, coordenadas e cursores ficam no executor; o modelo recebe somente referências deste turno. */
export class AssistantTools {
  private items = new Map<string, ObservedItem>();
  private merchants = new Map<string, string>();
  private pages = new Map<string, { token: string; queryHash: string }>();
  private addresses?: ReturnType<typeof this.readAddresses>;
  private observedLocation?: { addressId: string; addressHash: string };
  private calls = new Map<string, Promise<unknown>>();
  private audience: readonly PersonProfile[] = [];
  private purpose: MemoryPurpose = 'UNKNOWN';
  constructor(private readonly options: AssistantToolOptions) {}
  setAudience(people: readonly PersonProfile[], purpose: MemoryPurpose) { this.audience = people; this.purpose = purpose; }

  private async readAddresses(ctx: OperationalContext) {
    return parseAddressList(await ctx.deps.listAddresses());
  }
  private async location(ctx: OperationalContext) {
    const addresses = await (this.addresses ??= this.readAddresses(ctx));
    if (!addresses.length) throw new AddressError('ADDRESS_REQUIRED');
    const selected = this.options.selectedAddress(ctx.linkId);
    const address = addresses.find(a => a.addressId === selected.addressId && contentHash(a) === selected.addressHash);
    if (!address?.coordinates) throw new AddressError('ADDRESS_REQUIRED');
    this.observedLocation = { ...selected };
    return address.coordinates;
  }
  /** Proveniência da localização realmente usada; uma seleção posterior não substitui o endereço da busca. */
  observedAddressId(): string | null {
    const observed = this.observedLocation;
    if (!observed || !this.options.linkId) return null;
    const current = this.options.selectedAddress(this.options.linkId);
    if (contentHash(current) !== contentHash(observed)) throw new AddressError('ADDRESS_REQUIRED');
    return observed.addressId;
  }
  async execute(request: AssistantRequest): Promise<unknown> {
    const key = contentHash([request, this.purpose, this.audience.map(p => [p.ref, p.restrictions])]);
    const previous = this.calls.get(key);
    if (previous) return previous;
    const call = this.run(request).catch(error => {
      this.options.signal.throwIfAborted();
      if (error instanceof ContractError && error.code === 'LINK_CHANGED') throw error;
      if (error instanceof AddressError) return { error: { code: error.code } };
      if (error instanceof McpToolError) return { error: {
        code: error.code && /^[A-Z_]{1,50}$/.test(error.code) ? error.code : 'MCP_TOOL_ERROR', retryable: error.retryable,
      } };
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
      if (['IFOOD_LINK_REQUIRED', 'IFOOD_RECONNECT_REQUIRED', 'IFOOD_SCOPE_REQUIRED'].includes(code)) return { error: { code } };
      return { error: { code: 'UNAVAILABLE' } };
    });
    this.calls.set(key, call);
    return call;
  }
  private async run(request: AssistantRequest) {
    const o = this.options;
    o.signal.throwIfAborted();
    return o.links.withOperational(o.organizerId, request.name === 'listAddresses' ? 'ADDRESSES_READ' : 'OFFERS_EVALUATE', async ctx => {
      if (ctx.linkId !== o.linkId) throw new ContractError('LINK_CHANGED');
      const result = await this.call(ctx, request);
      o.signal.throwIfAborted();
      const current = await o.links.status(o.organizerId);
      if (current.state === 'UNAVAILABLE') throw new ContractError('UNAVAILABLE');
      if (current.linkId !== ctx.linkId || !current.operational) throw new ContractError('LINK_CHANGED');
      return result;
    });
  }
  private async call(ctx: OperationalContext, request: AssistantRequest): Promise<unknown> {
    const opts = { signal: this.options.signal, timeoutMs: 8_000 };
    if (request.name === 'listAddresses') {
      const addresses = await (this.addresses ??= this.readAddresses(ctx));
      if (!addresses.length) return { state: 'EMPTY', count: 0 };
      try { await this.location(ctx); return { state: 'READY', count: addresses.length }; }
      catch (e) { if (e instanceof AddressError) return { state: 'CHOICE_REQUIRED', count: addresses.length }; throw e; }
    }
    const userLocation = await this.location(ctx);
    if (request.name === 'getItem') {
      const item = this.items.get(request.arguments.itemRef);
      if (!item) return { error: { code: 'UNOBSERVED_REFERENCE' } };
      const raw = await ctx.deps.getItem({ itemId: item.listing.itemId, merchantId: item.listing.merchant.merchantId, userLocation }, opts);
      const detail = normalizeItemDetail(raw);
      if (detail.itemId !== item.listing.itemId || detail.merchantId !== item.listing.merchant.merchantId) return { error: { code: 'ITEM_MISMATCH' } };
      item.detail = detail;
      return { ...this.itemView(item), description: safeText(val(detail.itemDescription) ?? '', 240),
        options: val(detail.optionGroups)?.slice(0, 4).map(g => ({ name: safeText(val(g.name) ?? ''),
          minSelections: val(g.minSelections) ?? null, maxSelections: val(g.maxSelections) ?? null,
          options: g.options.slice(0, 4).map(p => ({ name: safeText(val(p.name) ?? ''), additionalPriceCents: val(p.additionalPrice) ?? null })),
        })) ?? null };
    }
    if (request.name === 'getMerchant') {
      const merchantId = this.merchants.get(request.arguments.merchantRef);
      if (!merchantId) return { error: { code: 'UNOBSERVED_REFERENCE' } };
      if (!ctx.discovery) return { error: { code: 'TOOL_UNAVAILABLE' } };
      const raw = await ctx.discovery('getMerchant', { merchantId, userLocation }, opts);
      // Somente campos já observados no contrato de catálogo; corpo externo nunca é repassado inteiro.
      const parsed = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
      return { merchantRef: request.arguments.merchantRef,
        merchantName: typeof parsed.merchantName === 'string' ? safeText(parsed.merchantName) : null };
    }
    const { refinements, nextPageRef, ...input } = request.arguments;
    const filters: SearchRefinements = {};
    // Só filtros comuns aos consumidores do pedido, nunca a união das restrições de pessoas distintas.
    const foodVertical = !input.merchantType || input.merchantType === 'RESTAURANT' || input.merchantType === 'GROCERIES';
    if (this.purpose === 'FOOD' && foodVertical && this.audience.length) {
      const perPerson = this.audience.map(p => serverFiltersFor(p.restrictions));
      const common = perPerson[0]!.filter(f => perPerson.every(values => values.includes(f)));
      if (common.length) filters.itemRestrictions = common;
    }
    if (refinements) {
      const { maxItemPriceCents, maxDeliveryFeeCents, merchantRef, ...rest } = refinements;
      Object.assign(filters, rest);
      if (maxItemPriceCents !== undefined) filters.maxItemPrice = centsToBrl(maxItemPriceCents);
      if (maxDeliveryFeeCents !== undefined) filters.maxDeliveryFee = centsToBrl(maxDeliveryFeeCents);
      if (merchantRef) {
        const id = this.merchants.get(merchantRef);
        if (!id) return { error: { code: 'UNOBSERVED_REFERENCE' } };
        filters.merchantId = id;
      }
    }
    const args = { ...input, userLocation, resultKind: 'ITEM' as const, pageSize: 6, refinements: filters };
    const queryHash = contentHash({ name: request.name, args });
    let nextPageToken: string | undefined;
    if (nextPageRef) {
      const page = this.pages.get(nextPageRef);
      if (!page || page.queryHash !== queryHash) return { error: { code: 'UNOBSERVED_REFERENCE' } };
      nextPageToken = page.token;
    }
    const paged = { ...args, ...(nextPageToken ? { nextPageToken } : {}) };
    const raw = request.name === 'searchOffers'
      ? await ctx.deps.searchOffers(paged as SearchOffersArgs, opts)
      : ctx.discovery ? await ctx.discovery(request.name, paged, opts) : null;
    if (raw === null) return { error: { code: 'TOOL_UNAVAILABLE' } };
    const result = normalizeSearchOffers(raw);
    const refs: string[] = [];
    for (const listing of result.items.slice(0, 6)) {
      let merchantRef = [...this.merchants].find(([, id]) => id === listing.merchant.merchantId)?.[0];
      if (!merchantRef) { merchantRef = `merchant_${this.merchants.size + 1}`; this.merchants.set(merchantRef, listing.merchant.merchantId); }
      const prior = [...this.items.values()].find(i => i.listing.itemId === listing.itemId && i.listing.merchant.merchantId === listing.merchant.merchantId);
      const ref = prior?.ref ?? `item_${this.items.size + 1}`;
      this.items.set(ref, { ref, merchantRef, listing,
        serverFilters: [...new Set([...(prior && contentHash(prior.listing) === contentHash(listing) ? prior.serverFilters : []), ...(filters.itemRestrictions ?? [])])],
        ...(prior?.detail && contentHash(prior.listing) === contentHash(listing) ? { detail: prior.detail } : {}) });
      refs.push(ref);
    }
    const token = val(result.nextPageToken);
    let pageRef: string | null = null;
    if (token) { pageRef = `page_${this.pages.size + 1}`; this.pages.set(pageRef, { token, queryHash }); }
    return { items: refs.map(ref => this.itemView(this.items.get(ref)!)), hasMore: val(result.hasMore) ?? null, nextPageRef: pageRef };
  }
  private itemView(item: ObservedItem) {
    const delivery = val(item.listing.merchant.delivery);
    return { itemRef: item.ref, merchantRef: item.merchantRef,
      name: safeText(val(item.detail?.itemName ?? item.listing.itemName) ?? 'Item sem nome'),
      merchant: safeText(val(item.listing.merchant.name) ?? 'Loja sem nome'),
      detailed: !!item.detail, listingPriceCents: item.listing.price.basePrice,
      deliveryFeeCents: delivery?.effectiveFee ?? null,
      etaMinutes: delivery ? { min: val(delivery.etaMinutes.min) ?? null, max: val(delivery.etaMinutes.max) ?? null } : null,
    };
  }
  hasDetail(ref: string) { return !!this.items.get(ref)?.detail; }
  /** Só candidatos detalhados por getItem podem virar proposta (regra 2 do cartão). */
  candidates(refs: readonly string[]): CatalogCandidate[] {
    return [...new Set(refs)].flatMap(ref => {
      const item = this.items.get(ref);
      return item?.detail ? [{ listing: item.listing, detail: item.detail, serverFilters: item.serverFilters }] : [];
    });
  }
  render(refs: readonly string[], people: readonly PersonProfile[] = [], purpose: MemoryPurpose = 'FOOD'): string[] {
    return [...new Set(refs)].flatMap(ref => {
      const item = this.items.get(ref);
      if (!item?.detail) return [];
      const input = { listing: item.listing, detail: item.detail, serverFilters: item.serverFilters };
      const evaluated = evaluateCandidate(input, { restrictions: [] });
      const range = (evaluated.pricing.selected ?? evaluated.pricing.minimumConfigurable)?.unitTotalRange;
      const price = range?.min === null || range?.min === undefined ? 'Preço não verificável'
        : range.max === range.min ? `Estimativa: ${formatCents(range.min)}`
          : range.max === null ? `A partir de ${formatCents(range.min)}` : `Faixa: ${formatCents(range.min)} a ${formatCents(range.max)}`;
      const view = this.itemView(item);
      const blocked = purpose !== 'FOOD' ? [] : people.flatMap(p => !p.restrictionsKnown
        || !evaluateCandidate(input, { restrictions: p.restrictions }).eligible ? [safeText(p.label, 50)] : []);
      const eta = view.etaMinutes;
      return [[`${view.name} — ${view.merchant}`, price,
        view.deliveryFeeCents === null ? 'Entrega: taxa indisponível' : `Entrega: ${formatCents(view.deliveryFeeCents)}`,
        ...(eta?.max !== null && eta?.max !== undefined ? [`Prazo estimado: ${eta.min ?? '?'}–${eta.max} min`] : []),
        ...(val(item.listing.merchant.isOpen) === false ? ['Loja fechada agora.'] : []),
        ...(blocked.length ? [`Não elegível para consumo por ${blocked.join(', ')}: há condições ou dados pendentes.`] : []),
      ].join('\n')];
    });
  }
}
