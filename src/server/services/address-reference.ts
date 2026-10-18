// Contrato conservador de listAddresses: campos já observados/tipados, sem inventar IDs.
import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { contentHash, type AdapterPrincipal } from '../contracts/guards.js';
import { payload } from '../cart/contracts.js';
import { scopeKey } from '../turns/store.js';

const text = z.string().min(1).max(200);
export const addressSchema = z.object({
  addressId: text,
  alias: z.string().max(200).nullish(),
  formattedAddress: z.string().max(1000).nullish(),
  postalCode: z.string().max(40).nullish(),
  location: z.object({ street: z.string().max(200).nullish(), neighborhood: z.string().max(200).nullish(),
    number: z.string().max(100).nullish(), city: z.string().max(200).nullish(), state: z.string().max(100).nullish() }).nullish(),
  coordinates: z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) }).nullish(),
});
const listSchema = z.object({ results: z.array(addressSchema).max(50) });
export function parseAddressList(raw: unknown): DeliveryAddress[] {
  const parsed = listSchema.safeParse(payload(raw));
  if (!parsed.success || new Set(parsed.data.results.map(a => a.addressId)).size !== parsed.data.results.length)
    throw new AddressError('UNAVAILABLE');
  return parsed.data.results;
}
export type DeliveryAddress = z.infer<typeof addressSchema>;
export class AddressError extends Error {
  constructor(readonly code: 'UNAVAILABLE' | 'ADDRESS_REQUIRED' | 'REFERENCE_EXPIRED' | 'LINK_CHANGED') {
    super('Não foi possível validar o endereço de entrega.');
  }
}

export const linkFingerprint = (linkId: string) => createHash('sha256').update(linkId).digest('hex');
/** Revalidar a referência autorizada antes de qualquer caminho dependente da entrega. */
export function assertSelectedAddress(db: DatabaseSync, p: AdapterPrincipal, linkId: string, raw: unknown, now: number) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='delivery_address_selected'").get())
    throw new AddressError('ADDRESS_REQUIRED');
  const address = addressSchema.parse(raw);
  const selected = db.prepare('SELECT address_id,address_hash FROM delivery_address_selected WHERE scope=? AND link_hash=? AND expires>?')
    .get(scopeKey(p), linkFingerprint(linkId), now);
  if (!selected || selected['address_id'] !== address.addressId || selected['address_hash'] !== contentHash(address))
    throw new AddressError('ADDRESS_REQUIRED');
}
