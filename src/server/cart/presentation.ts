// Projeção humana de campos já observados em getItem/listAddresses/getUser.
// Não persiste rótulos, endereço ou identidade no plano técnico de escrita.
import { contentHash } from '../contracts/guards.js';
import { cleanName } from '../domain/group.js';
import type { AccountIdentity } from '../links/identity.js';
import { addressLabel } from '../services/delivery-addresses.js';
import type { DeliveryAddress } from '../services/address-reference.js';
import { CartError, parseItem } from './contracts.js';

export interface ItemLabel {
  itemId: string; name: string;
  options: { optionId: string; name: string; quantity: number }[];
}
export interface CartDisplay {
  accountLabel: string; merchantName: string; addressLabel: string; items: ItemLabel[];
}
export const labelKey = (i: { itemId: string; options: { optionId: string; quantity: number }[] }) =>
  contentHash([i.itemId, i.options.map(o => ({ optionId: o.optionId, quantity: o.quantity }))
    .sort((a, b) => a.optionId.localeCompare(b.optionId))]);
export function readable(value: unknown): string {
  if (typeof value !== 'string') throw new CartError('CART_REVIEW_NOT_DISPLAYABLE', 'Identificação humana incompleta.');
  const text = cleanName(value);
  if (!text || [...text].length > 180) throw new CartError('CART_REVIEW_NOT_DISPLAYABLE', 'Identificação humana incompleta ou longa.');
  return text;
}
export function describeItem(detail: ReturnType<typeof parseItem>, options: { optionId: string; quantity: number }[]): ItemLabel {
  const available = detail.optionGroups?.flatMap(g => g.options) ?? [];
  return { itemId: detail.itemId, name: readable(detail.itemName), options: options.map(o => {
    const found = available.filter(a => a.optionId === o.optionId);
    if (found.length !== 1) throw new CartError('CART_REVIEW_NOT_DISPLAYABLE', 'Opção sem identificação unívoca.');
    return { ...o, name: readable(found[0]!.name) };
  }).sort((a, b) => a.optionId.localeCompare(b.optionId)) };
}
export function displayContext(identity: AccountIdentity | null | undefined, address: DeliveryAddress | undefined, merchantName: unknown) {
  if (!identity || identity.status !== 'VERIFIED' || (!identity.displayName && !identity.emailMasked) || !address ||
    (!address.alias && !address.location?.street) || !address.location?.city)
    throw new CartError('CART_REVIEW_NOT_DISPLAYABLE', 'Confirme uma conta e um endereço identificáveis antes da revisão.');
  return { accountLabel: readable([identity.displayName, identity.emailMasked].filter(Boolean).join(' · ')),
    merchantName: readable(merchantName), addressLabel: readable(addressLabel(address)) };
}
export const descriptionHashes = (items: ItemLabel[]) => Object.fromEntries(items.map(i => [labelKey(i), contentHash(i)]));
