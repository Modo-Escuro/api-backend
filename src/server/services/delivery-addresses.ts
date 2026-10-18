// Seleção humana de endereço: somente listAddresses, sem createAddress ou escrita MCP.
import { randomBytes } from 'node:crypto';
import { contentHash, type AdapterPrincipal, ContractError } from '../contracts/guards.js';
import type { IfoodLinkService, OperationalContext } from '../links/service.js';
import { scopeKey, type TurnStore } from '../turns/store.js';

import { AddressError, assertSelectedAddress, linkFingerprint, parseAddressList, type DeliveryAddress } from './address-reference.js';
export { AddressError } from './address-reference.js';
const safeText = (s: string | null | undefined, n = 50) => [...(s ?? '').replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, '').trim()].slice(0, n).join('');
export function addressLabel(a: DeliveryAddress) {
  const alias = ['CASA', 'TRABALHO'].includes(a.alias?.toUpperCase() ?? '') ? safeText(a.alias, 20) : '';
  // Sem número, complemento, CEP, coordenadas, formattedAddress ou identidade da conta.
  return [alias || safeText(a.location?.street, 60), safeText(a.location?.neighborhood), safeText(a.location?.city)]
    .filter(Boolean).join(' · ') || 'Endereço cadastrado (resumo indisponível)';
}
const DAY = 86_400_000;
const TTL = 300_000;

type Choice = { scope: string; linkHash: string; addressId: string; addressHash: string; expires: number };
export class DeliveryAddresses {
  // Opções ainda não autorizadas ficam só na RAM. Reinício invalida seus botões.
  readonly choices = new Map<string, Choice>();
  constructor(readonly store: TurnStore, private readonly links: Pick<IfoodLinkService, 'status' | 'withOperational'>) {
    // Extensão aditiva isolada: guarda só IDs/referências/hashes; não copia o endereço para SQLite.
    store.db.exec(`CREATE TABLE IF NOT EXISTS delivery_address_selected (
      scope TEXT PRIMARY KEY, link_hash TEXT NOT NULL, address_id TEXT NOT NULL,
      address_hash TEXT NOT NULL, expires INTEGER NOT NULL, choice_hash TEXT);`);
    const columns = store.db.prepare('PRAGMA table_info(delivery_address_selected)').all();
    if (!columns.some(c => c['name'] === 'choice_hash')) store.db.exec('ALTER TABLE delivery_address_selected ADD COLUMN choice_hash TEXT');
  }
  private prune() {
    for (const [key, c] of this.choices) if (c.expires <= this.store.now()) this.choices.delete(key);
    this.store.db.prepare('DELETE FROM delivery_address_selected WHERE expires<=?').run(this.store.now());
  }

  private transaction<T>(work: () => T): T {
    this.store.db.exec('BEGIN IMMEDIATE');
    try { const value = work(); this.store.db.exec('COMMIT'); return value; }
    catch (e) { this.store.db.exec('ROLLBACK'); throw e; }
  }
  private async same(p: AdapterPrincipal, linkId: string) {
    const status = await this.links.status(p.organizerId);
    if (status.state !== 'CONNECTED' || !status.operational || status.linkId !== linkId || status.attempt)
      throw new AddressError('LINK_CHANGED');
    if (status.scopeEvidence !== 'TOKEN_SCOPES' || !status.allowedOperations.includes('ADDRESSES_READ'))
      throw new AddressError('UNAVAILABLE');
  }
  private async read(p: AdapterPrincipal, ctx: OperationalContext) {
    await this.same(p, ctx.linkId);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const raw = await Promise.race([ctx.deps.listAddresses(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new AddressError('UNAVAILABLE')), 4000); timer.unref();
      })]);
      const addresses = parseAddressList(raw);
      await this.same(p, ctx.linkId);
      return addresses;
    } finally { if (timer) clearTimeout(timer); }
  }
  async review(p: AdapterPrincipal) {
    this.prune();
    return this.links.withOperational(p.organizerId, 'ADDRESSES_READ', async ctx => {
      const addresses = await this.read(p, ctx), scope = scopeKey(p), linkHash = linkFingerprint(ctx.linkId);
      // Não reutilizar escolhas de uma conta anterior.
      for (const [key, c] of this.choices) if (c.scope === scope && (c.linkHash !== linkHash || !addresses.some(a => a.addressId === c.addressId && contentHash(a) === c.addressHash))) this.choices.delete(key);
      this.store.db.prepare('DELETE FROM delivery_address_selected WHERE scope=? AND link_hash<>?').run(scope, linkHash);
      const labels = addresses.map(addressLabel);
      if (addresses.length > 1 && new Set(labels).size !== labels.length) throw new AddressError('UNAVAILABLE');
      const expires = this.store.now() + TTL;
      const options = addresses.map((a, index) => {
        // Tokens estáveis durante a validade permitem editar/recuperar a mesma apresentação.
        const hash = contentHash(a);
        const previous = [...this.choices].find(([, c]) => c.scope === scope && c.linkHash === linkHash && c.addressId === a.addressId && c.addressHash === hash);
        const choiceRef = previous?.[0] ?? randomBytes(24).toString('base64url');
        const choice = previous?.[1] ?? { scope, linkHash, addressId: a.addressId, addressHash: hash, expires };
        this.choices.set(choiceRef, choice);
        return { choiceRef, label: labels[index]!, expiresAt: new Date(choice.expires).toISOString() };
      });
      return { contractVersion: '1.0', state: options.length ? 'CHOICE_REQUIRED' : 'EMPTY', linkHash, options };
    });
  }
  async select(p: AdapterPrincipal, reference: string) {
    this.prune();
    const scope = scopeKey(p);
    const saved = this.store.db.prepare('SELECT * FROM delivery_address_selected WHERE scope=? AND choice_hash=? AND expires>?')
      .get(scope, contentHash(reference), this.store.now());
    const choice = this.choices.get(reference) ?? (saved ? {
      scope, linkHash: String(saved['link_hash']), addressId: String(saved['address_id']),
      addressHash: String(saved['address_hash']), expires: Number(saved['expires']),
    } : undefined);
    if (!choice || choice.scope !== scope) throw new AddressError('REFERENCE_EXPIRED');
    return this.links.withOperational(p.organizerId, 'ADDRESSES_READ', async ctx => {
      if (linkFingerprint(ctx.linkId) !== choice.linkHash) throw new AddressError('LINK_CHANGED');
      const addresses = await this.read(p, ctx), found = addresses.find(a => a.addressId === choice.addressId);
      if (!found || contentHash(found) !== choice.addressHash) throw new AddressError('REFERENCE_EXPIRED');
      // Releitura e commit são separados; expiração e consumo são rechecados na transação.
      this.transaction(() => {
        const candidate = this.choices.get(reference);
        if (!candidate) {
          const selected = this.store.db.prepare('SELECT * FROM delivery_address_selected WHERE scope=? AND choice_hash=? AND expires>?')
            .get(scope, contentHash(reference), this.store.now());
          if (!selected || selected['link_hash'] !== choice.linkHash || selected['address_id'] !== choice.addressId || selected['address_hash'] !== choice.addressHash)
            throw new AddressError('REFERENCE_EXPIRED');
          return; // Replay após reinício só reconhece a seleção persistida, nunca muda para uma antiga.
        }
        if (candidate.expires <= this.store.now()) throw new AddressError('REFERENCE_EXPIRED');
        this.store.db.prepare('INSERT INTO delivery_address_selected VALUES(?,?,?,?,?,?) ON CONFLICT(scope) DO UPDATE SET link_hash=excluded.link_hash,address_id=excluded.address_id,address_hash=excluded.address_hash,expires=excluded.expires,choice_hash=excluded.choice_hash')
          .run(scope, choice.linkHash, found.addressId, choice.addressHash, this.store.now() + DAY, contentHash(reference));
      });
      for (const [key, c] of this.choices) if (c.scope === scope) this.choices.delete(key);
      return { contractVersion: '1.0', state: 'SELECTED', linkHash: linkFingerprint(ctx.linkId), label: addressLabel(found), purchaseAuthorized: false };
    });
  }
  /** Só a camada autenticada de sugestões lê esta referência; nunca o modelo. */
  selected(p: AdapterPrincipal, linkId: string) {
    this.prune();
    const r = this.store.db.prepare('SELECT * FROM delivery_address_selected WHERE scope=? AND link_hash=? AND expires>?')
      .get(scopeKey(p), linkFingerprint(linkId), this.store.now());
    if (!r) throw new AddressError('ADDRESS_REQUIRED');
    return { addressId: String(r['address_id']), addressHash: String(r['address_hash']) };
  }
  async forSuggestions(p: AdapterPrincipal, ctx: OperationalContext) {
    const chosen = this.selected(p, ctx.linkId), addresses = await this.read(p, ctx);
    const found = addresses.find(a => a.addressId === chosen.addressId);
    if (!found || contentHash(found) !== chosen.addressHash || !found.coordinates) throw new AddressError('ADDRESS_REQUIRED');
    assertSelectedAddress(this.store.db, p, ctx.linkId, found, this.store.now());
    const current = this.selected(p, ctx.linkId);
    if (current.addressId !== chosen.addressId || current.addressHash !== chosen.addressHash) throw new AddressError('ADDRESS_REQUIRED');
    return found.addressId;
  }
}

export function addressFailure(e: unknown): never {
  if (e instanceof AddressError) {
    if (e.code === 'LINK_CHANGED' || e.code === 'REFERENCE_EXPIRED') throw new ContractError(e.code);
  }
  throw new ContractError('UNAVAILABLE');
}
