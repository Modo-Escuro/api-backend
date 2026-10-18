import { randomBytes } from 'node:crypto';
import { contentHash, type AdapterPrincipal } from '../contracts/guards.js';
import { parsePurchaseState, type PurchaseState } from '../domain/purchase.js';
import { scopeKey, type TurnStore } from '../turns/store.js';
import { CartError, type Snapshot } from './contracts.js';
import { recoverCartWriteIntents } from './write-schema.js';

export const opaque = () => randomBytes(24).toString('base64url');
export type WriteTool = 'createCart' | 'addItemToCart' | 'updateCartItem' | 'removeItemFromCart';
export interface WriteStep { tool: WriteTool; args: Record<string, unknown> }
export interface WritePlan {
  purpose: 'PREPARE_CART'; purchaseId: string; version: number; linkId: string;
  merchantId: string; addressId: string; purchaseHash: string;
  remoteHash: string | null; validationHash: string; steps: WriteStep[];
  descriptionHashes: Record<string, string>;
  observedSubtotalCents: number; unknownCosts: true;
  expiresAt: number;
}
export interface Head { cartId: string; fingerprint: string | null; snapshot: Snapshot | null; purchaseId: string }
export interface Intent {
  id: string; scope: string; account: string; organizer: string; request_id: string; signature: string;
  state: 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'RESULT_UNKNOWN'; plan: string;
  step: number; sent: number; cart_id: string | null; code: string | null; lease_until: number;
}
export interface HumanCartCommand { confirmationRef: string; requestId: string; callbackId: string }

/** Guarda só plano técnico/referências; não copia participantes, restrições ou rateio da DATA-01. */
export class CartWriteStore {
  constructor(readonly turns: TurnStore) {}
  get db() { return this.turns.db; }
  get now() { return this.turns.now; }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); this.db.exec('COMMIT'); return r; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  purchase(p: AdapterPrincipal, allowExpired = false): PurchaseState {
    const row = this.db.prepare('SELECT domain,last_activity_at FROM conversations WHERE scope=?').get(scopeKey(p));
    if (!row?.['domain'] || (!allowExpired && Number(row['last_activity_at'] ?? 0) + this.turns.limits.inactivityMs <= this.now()))
      throw new CartError('PURCHASE_UNAVAILABLE', 'A compra não existe ou expirou.');
    const state = parsePurchaseState(JSON.parse(String(row['domain'])));
    if (state.status !== 'ACTIVE') throw new CartError('PURCHASE_UNAVAILABLE', 'A compra não está ativa.');
    return state;
  }
  account(p: AdapterPrincipal, linkId: string) { return contentHash([p.botId, p.organizerId, linkId]); }
  organizer(p: AdapterPrincipal) { return contentHash([p.botId, p.organizerId]); }
  assertUnchanged(p: AdapterPrincipal, hash: string) {
    if (contentHash(this.purchase(p)) !== hash) throw new CartError('CART_REVIEW_CHANGED', 'O grupo ou o carrinho simulado mudou; revise novamente.');
  }
  assertNotBlocked(p: AdapterPrincipal) {
    // Não libera por reinício, reconexão, mudança de requestId ou leitura que apenas se parece com o esperado.
    this.recover();
    if (this.db.prepare("SELECT id FROM cart_write_intents WHERE organizer=? AND state IN ('PENDING','RESULT_UNKNOWN') LIMIT 1").get(this.organizer(p)))
      throw new CartError('RESULT_UNKNOWN', 'Há uma escrita pendente ou desconhecida. Consulte e reconcilie; não repita.');
  }
  recover() {
    recoverCartWriteIntents(this.db, this.now());
  }
  head(p: AdapterPrincipal, state: PurchaseState): Head | null {
    const r = this.db.prepare('SELECT * FROM cart_write_heads WHERE account=?').get(this.account(p, state.linkId!));
    if (!r) return null;
    if (r['scope'] !== scopeKey(p) || r['purchase_id'] !== state.purchaseId)
      throw new CartError('CART_CONTEXT_CHANGED', 'Já existe carrinho associado a outra compra; requer reconciliação.');
    return { cartId: String(r['cart_id']), fingerprint: r['fingerprint'] === null ? null : String(r['fingerprint']),
      snapshot: r['snapshot'] === null ? null : JSON.parse(String(r['snapshot'])) as Snapshot, purchaseId: state.purchaseId };
  }
  saveHead(p: AdapterPrincipal, state: PurchaseState, cartId: string, snapshot: Snapshot | null, fingerprint: string | null) {
    this.db.prepare(`INSERT INTO cart_write_heads(account,scope,link_id,purchase_id,cart_id,snapshot,fingerprint)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(account) DO UPDATE SET cart_id=excluded.cart_id,snapshot=excluded.snapshot,fingerprint=excluded.fingerprint`)
      .run(this.account(p, state.linkId!), scopeKey(p), state.linkId!, state.purchaseId, cartId, snapshot ? JSON.stringify(snapshot) : null, fingerprint);
  }
  review(p: AdapterPrincipal, plan: WritePlan) {
    return this.transaction(() => {
      this.assertNotBlocked(p); this.assertUnchanged(p, plan.purchaseHash);
      const confirmationRef = opaque(), expiresAt = plan.expiresAt;
      this.db.prepare('INSERT INTO cart_write_reviews(ref_hash,scope,purchase_hash,plan,expires) VALUES(?,?,?,?,?)')
        .run(contentHash(confirmationRef), scopeKey(p), plan.purchaseHash, JSON.stringify(plan), expiresAt);
      return { confirmationRef, expiresAt: new Date(expiresAt).toISOString(), purpose: plan.purpose, version: plan.version,
        fingerprint: contentHash(plan), observedSubtotalCents: plan.observedSubtotalCents,
        totalCents: null, unknownCosts: true, operations: plan.steps.map(s => s.tool),
        note: 'Confirma somente a escrita desta composição no carrinho real. Total ainda não confirmado; pedido não será enviado e nenhum pagamento será processado.' };
    });
  }
  readReview(p: AdapterPrincipal, reference: string): WritePlan {
    const r = this.db.prepare('SELECT * FROM cart_write_reviews WHERE ref_hash=? AND scope=?').get(contentHash(reference), scopeKey(p));
    if (!r || r['consumed'] || Number(r['expires']) <= this.now())
      throw new CartError('CART_CONFIRMATION_EXPIRED', 'Confirmação inválida, consumida ou expirada.');
    this.assertUnchanged(p, String(r['purchase_hash']));
    return JSON.parse(String(r['plan'])) as WritePlan;
  }
  signature(command: HumanCartCommand) { return contentHash(command); }
  find(p: AdapterPrincipal, command: HumanCartCommand): Intent | null {
    this.recover();
    const r = this.db.prepare('SELECT * FROM cart_write_intents WHERE scope=? AND request_id=?').get(scopeKey(p), command.requestId);
    if (!r) return null;
    if (r['signature'] !== this.signature(command)) throw new CartError('IDEMPOTENCY_CONFLICT', 'requestId já usado com outra confirmação ou callback.');
    return r as unknown as Intent;
  }
  reserve(p: AdapterPrincipal, command: HumanCartCommand, plan: WritePlan): Intent {
    return this.transaction(() => {
      this.assertNotBlocked(p);
      if (contentHash(this.readReview(p, command.confirmationRef)) !== contentHash(plan))
        throw new CartError('CART_REVIEW_CHANGED', 'A revisão mudou.');
      const id = opaque();
      if (this.db.prepare('SELECT id FROM cart_write_intents WHERE organizer=? AND callback_hash=?').get(this.organizer(p), contentHash(command.callbackId)))
        throw new CartError('CALLBACK_REPLAY', 'Callback humano já utilizado.');
      this.db.prepare('UPDATE cart_write_reviews SET consumed=1 WHERE ref_hash=?').run(contentHash(command.confirmationRef));
      this.db.prepare('UPDATE conversations SET last_activity_at=? WHERE scope=?').run(this.now(), scopeKey(p));
      this.db.prepare(`INSERT INTO cart_write_intents(id,scope,account,organizer,request_id,signature,callback_hash,state,plan,lease_until)
        VALUES(?,?,?,?,?,?,?,'PENDING',?,?)`).run(id, scopeKey(p), this.account(p, plan.linkId), this.organizer(p),
        command.requestId, this.signature(command), contentHash(command.callbackId), JSON.stringify(plan), this.now() + 120_000);
      return this.intent(p, id);
    });
  }
  intent(p: AdapterPrincipal, id: string): Intent {
    this.recover();
    const r = this.db.prepare('SELECT * FROM cart_write_intents WHERE id=? AND scope=?').get(id, scopeKey(p));
    if (!r) throw new CartError('CART_INTENT_NOT_FOUND', 'Intenção não encontrada.', 404);
    return r as unknown as Intent;
  }
  byRequest(p: AdapterPrincipal, requestId: string): Intent {
    this.recover();
    const row = this.db.prepare('SELECT * FROM cart_write_intents WHERE scope=? AND request_id=?').get(scopeKey(p), requestId);
    if (!row) throw new CartError('CART_INTENT_NOT_FOUND', 'Intenção não encontrada.', 404);
    return row as unknown as Intent;
  }
  beforeCall(p: AdapterPrincipal, id: string, expectedHash: string, addressCheck?: () => void) {
    this.transaction(() => {
      this.assertUnchanged(p, expectedHash);
      const intent = this.intent(p, id);
      if (intent.state !== 'PENDING' || intent.lease_until <= this.now()) throw new CartError('RESULT_UNKNOWN', 'Escrita não pode ser retomada automaticamente.');
      if ((JSON.parse(intent.plan) as WritePlan).expiresAt <= this.now()) throw new CartError('CART_CONFIRMATION_EXPIRED', 'Confirmação expirou antes da escrita; revise novamente.');
      addressCheck?.(); // Mesma transação do marcador, sem await entre guarda e despacho.
      this.db.prepare('UPDATE cart_write_intents SET sent=1 WHERE id=?').run(id);
    });
  }
  stepDone(p: AdapterPrincipal, state: PurchaseState, id: string, step: number, cartId: string) {
    this.transaction(() => {
      const saved = this.db.prepare('SELECT * FROM cart_write_intents WHERE id=? AND scope=?').get(id, scopeKey(p));
      if (!saved || saved['account'] !== this.account(p,state.linkId!)) throw new CartError('CART_INTENT_NOT_FOUND','Intenção não encontrada.',404);
      // Persistir o ID técnico e o reconhecimento juntos: não existe janela que permita recriar após crash.
      this.saveHead(p, state, cartId, null, null);
      if (saved['state'] !== 'PENDING') throw new CartError('RESULT_UNKNOWN','Intenção já interrompida; consultar e reconciliar.');
      this.db.prepare("UPDATE cart_write_intents SET step=?,sent=0,cart_id=? WHERE id=? AND state='PENDING'").run(step, cartId, id);
    });
  }
  finish(id: string, state: Intent['state'], code: string | null = null) {
    this.db.prepare("UPDATE cart_write_intents SET state=?,code=? WHERE id=? AND state='PENDING'").run(state, code, id);
  }
}
