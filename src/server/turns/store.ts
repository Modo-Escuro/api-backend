// RUN-01: fila e resultados transacionais. Nenhuma chamada a modelo/provedor neste módulo.
// DATA-01 (schema v2): estado da compra no mesmo banco, gravado na MESMA transação do snapshot/operação;
// patches com proveniência em purchase_changes; exclusão D7 ao encerrar ou após inatividade.
// CART-01 (schema v3): confirmações/intenção duráveis; binários v2 recusam o banco para preservar bloqueios.
// Memória (schema v4): fatos por vínculo/pessoa/finalidade, gravados atomicamente com o turno.
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { commitMemory, installMemorySchema, memoryAccountRef, memoryDirectory, purgeMemorySelf, removeMemoryPerson, retrieveMemory, validateMemoryActions } from '../assistant/memory-store.js';
import type { MemoryCommit, MemoryReader } from '../assistant/memory.js';
import type { AccountSession } from './account-session.js';
import { hasUnresolvedCartWrite, installCartWriteSchema, recoverCartWriteIntents } from '../cart/write-schema.js';
import { CancelResultSchema, OperationSchema, SnapshotSchema, type ConversationEvent, type ErrorCode, type Operation, type Snapshot } from '../contracts/conversation.js';
import { contractErrorResponse } from '../contracts/errors.js';
import { log } from '../ops/log.js';
import { assertOperation, assertReplay, assertScope, assertSnapshot, assertVersion, contentHash, ContractError, eventKey, type AdapterPrincipal } from '../contracts/guards.js';
import {
  CONTRACT_MAX_PARTICIPANTS, DEFAULT_MAX_PARTICIPANTS, DomainError, nextPurchase, parsePurchaseState,
  type ChangePath, type DomainChange, type PurchaseState,
} from '../domain/purchase.js';

const ref = () => randomBytes(24).toString('base64url');
const terminal = (o: Operation) => !['ACCEPTED', 'RUNNING', 'CANCEL_REQUESTED'].includes(o.status);
export const scopeKey = (p: AdapterPrincipal) => JSON.stringify(['TELEGRAM', p.botId, p.organizerId, p.conversationId]);
export interface TurnLimits {
  deadlineMs: number;
  leaseMs: number;
  maxPending: number;
  maxPerConversation: number;
  maxRecords: number;
  maxAttempts: number;
  maxResultBytes: number;
  /** DATA-01: participantes por compra (padrão 20; contrato API-01 aceita até 100). */
  maxParticipants: number;
  /** DEC-01 D7: dados da compra expiram após este tempo sem evento aceito (24 h). */
  inactivityMs: number;
}
export const DEFAULT_LIMITS: TurnLimits = {
  deadlineMs: 120_000, leaseMs: 15_000, maxPending: 100, maxPerConversation: 10,
  maxRecords: 10_000, maxAttempts: 3, maxResultBytes: 65_536,
  maxParticipants: DEFAULT_MAX_PARTICIPANTS, inactivityMs: 24 * 60 * 60_000,
};
export const SCHEMA_VERSION = 6;
export interface CancelCommand {
  contractVersion: '1.0'; eventId: string; conversationId: string; expectedVersion: number;
  source: ConversationEvent['source']; operationId: string;
}
type CancelResult = ReturnType<typeof CancelResultSchema.parse>;
export interface Job {
  operation: Operation; event: ConversationEvent; principal: AdapterPrincipal;
  snapshot: Snapshot; token: string;
  /** DATA-01: compra ativa da conversa no momento do claim (null se não houver). */
  purchase: PurchaseState | null;
  accountSession?: AccountSession;
}
export interface FinishInput {
  snapshot: Snapshot; completeness: 'PARTIAL' | 'COMPLETE'; paths: Operation['changes'][number]['paths'];
  cause?: 'USER' | 'DERIVED';
  /** DATA-01: operações tipadas; o estado é recalculado aqui a partir do estado persistido. */
  domain?: DomainChange;
  memory?: MemoryCommit;
}
interface Row {
  id: string; scope: string; event_id: string; body: string | null; operation: string;
  owner: string | null; token: string | null; lease_until: number | null; attempts: number;
  effect: number;
  account_session?: string | null;
  account_link_id?: string | null;
}
type SqlRow = Record<string, string | number | bigint | Uint8Array | null>;
const row = (r: SqlRow | undefined) => r as unknown as Row | undefined;

export class TurnStore {
  readonly db: DatabaseSync;
  readonly limits: TurnLimits;
  private closed = false;

  constructor(path: string, limits: Partial<TurnLimits> = {}, readonly now = Date.now) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    for (const n of Object.values(this.limits)) {
      if (!Number.isSafeInteger(n) || n <= 0) throw new Error('Limite de execução inválido.');
    }
    if (this.limits.leaseMs >= this.limits.deadlineMs) throw new Error('Lease deve ser menor que prazo.');
    if (this.limits.maxParticipants > CONTRACT_MAX_PARTICIPANTS) throw new Error('Máximo de participantes acima do contrato.');
    if (path !== ':memory:') {
      const dir = dirname(resolve(path));
      // Usar diretório dedicado: nunca alterar permissões da raiz do volume/sistema.
      if (dirname(dir) === dir) throw new Error('Use um diretório exclusivo para conversas.');
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o700);
    }
    this.db = new DatabaseSync(path);
    try {
      if (path !== ':memory:' && existsSync(path)) chmodSync(path, 0o600);
      this.db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      const version = Number(this.db.prepare('PRAGMA user_version').get()!['user_version']);
      if (version < 0 || version > SCHEMA_VERSION) { this.db.close(); throw new Error('Versão de armazenamento não suportada.'); }
      const integrity = this.db.prepare('PRAGMA quick_check').get()!['quick_check'];
      if (integrity !== 'ok') { this.db.close(); throw new Error('Armazenamento inválido.'); }
      this.transaction(() => {
        // Relido dentro da transação: outra conexão pode ter migrado entre a leitura acima e o BEGIN IMMEDIATE.
        const current = Number(this.db.prepare('PRAGMA user_version').get()!['user_version']);
        if (current < 0 || current > SCHEMA_VERSION) throw new Error('Versão de armazenamento não suportada.');
        if (current === 0) this.db.exec(`
          CREATE TABLE IF NOT EXISTS conversations (scope TEXT PRIMARY KEY, snapshot TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS events (
            key TEXT PRIMARY KEY, scope TEXT NOT NULL, kind TEXT NOT NULL, hash TEXT NOT NULL,
            source TEXT NOT NULL, operation_id TEXT NOT NULL, result TEXT,
            FOREIGN KEY(scope) REFERENCES conversations(scope),
            FOREIGN KEY(operation_id) REFERENCES operations(id)
          );
          CREATE TABLE IF NOT EXISTS operations (
            seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
            scope TEXT NOT NULL, event_id TEXT NOT NULL, body TEXT,
            operation TEXT NOT NULL, status TEXT NOT NULL,
            owner TEXT, token TEXT, lease_until INTEGER, attempts INTEGER NOT NULL DEFAULT 0,
            effect INTEGER NOT NULL DEFAULT 0, UNIQUE(scope,event_id), FOREIGN KEY(scope) REFERENCES conversations(scope)
          );
          CREATE INDEX IF NOT EXISTS operations_queue ON operations(status, seq);
          CREATE INDEX IF NOT EXISTS operations_scope ON operations(scope, status);
          PRAGMA user_version=1;
        `);
        // v2 (DATA-01): domínio da compra + proveniência dos patches. Migração aditiva: dados v1 preservados.
        if (current < 2) this.db.exec(`
          ALTER TABLE conversations ADD COLUMN domain TEXT;
          ALTER TABLE conversations ADD COLUMN last_activity_at INTEGER;
          CREATE INDEX IF NOT EXISTS conversations_activity ON conversations(last_activity_at);
          CREATE TABLE IF NOT EXISTS purchase_changes (
            change_id TEXT PRIMARY KEY, scope TEXT NOT NULL, purchase_id TEXT NOT NULL, event_id TEXT NOT NULL,
            source TEXT NOT NULL, base_version INTEGER NOT NULL, result_version INTEGER NOT NULL,
            cause TEXT NOT NULL CHECK (cause IN ('USER','DERIVED')), caused_by TEXT, patch TEXT NOT NULL,
            created_at INTEGER NOT NULL, FOREIGN KEY(scope) REFERENCES conversations(scope)
          );
          CREATE INDEX IF NOT EXISTS purchase_changes_scope ON purchase_changes(scope, result_version);
          PRAGMA user_version=2;
        `);
        if (current < 3) {
          installCartWriteSchema(this.db);
          this.db.exec('PRAGMA user_version=3;');
        }
        // v6 unifica as duas variantes v5: a publicada tem grupos por conta, a local tem memória/fila.
        // Instalar por capacidade, nunca presumir que user_version=5 implica as mesmas tabelas.
        if (current < 6) {
          installMemorySchema(this.db);
          const columns = this.db.prepare('PRAGMA table_info(operations)').all();
          if (!columns.some(c => c['name'] === 'account_session')) this.db.exec('ALTER TABLE operations ADD COLUMN account_session TEXT;');
          if (!columns.some(c => c['name'] === 'account_link_id')) this.db.exec('ALTER TABLE operations ADD COLUMN account_link_id TEXT;');
          // Vínculo conversa↔conta autenticada em tabela companheira: migração aditiva; a tabela histórica de conversas não muda de forma.
          this.db.exec(`CREATE TABLE IF NOT EXISTS account_bindings (scope TEXT PRIMARY KEY, account_session TEXT NOT NULL,
            account_link_id TEXT, FOREIGN KEY(scope) REFERENCES conversations(scope));
          CREATE TABLE IF NOT EXISTS retired_purchase_states (scope TEXT NOT NULL, version INTEGER NOT NULL,
            domain TEXT NOT NULL, PRIMARY KEY(scope,version), FOREIGN KEY(scope) REFERENCES conversations(scope));
          PRAGMA user_version=6;`);
        }
        // Uma versão numérica válida com forma incompatível também falha fechada; nada é substituído.
        const required = {
          operations: ['account_session', 'account_link_id'],
          assistant_memory_accounts: ['scope', 'account_ref', 'revision', 'context', 'updated_at'],
          assistant_memory_people: ['scope', 'account_ref', 'person_ref', 'person'],
          assistant_memory_facts: ['scope', 'account_ref', 'person_ref', 'fact_key', 'fact'],
          account_bindings: ['scope', 'account_session', 'account_link_id'],
          retired_purchase_states: ['scope', 'version', 'domain'],
        };
        for (const [table, names] of Object.entries(required)) {
          const columns = new Set(this.db.prepare(`PRAGMA table_info(${table})`).all().map(c => c['name']));
          if (names.some(name => !columns.has(name))) throw new Error('Schema incompatível.');
        }
        // Conversas vindas do v1 não têm atividade registrada. O instante da migração abre uma janela única de
        // `inactivityMs` (D7): não presume atividade antiga como recente, nem apaga de surpresa uma conversa em uso.
        if (current === 1) this.db.prepare('UPDATE conversations SET last_activity_at=? WHERE last_activity_at IS NULL').run(this.now());
      });
    } catch {
      try { this.db.close(); } catch { /* já fechado */ }
      throw new Error('Não foi possível abrir o armazenamento de conversas com segurança.');
    }
  }

  private transaction<T>(run: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = run(); this.db.exec('COMMIT'); return result; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  close() { if (!this.closed) { this.closed = true; this.db.close(); } }
  memory(p: AdapterPrincipal): MemoryReader {
    const scope = scopeKey(p);
    return {
      directory: linkId => memoryDirectory(this.db, scope, linkId, this.now()),
      retrieve: (linkId, people, purpose) => retrieveMemory(this.db, scope, linkId, people, purpose),
      validate: (linkId, actions, people, purpose, message) => validateMemoryActions(this.db, scope, linkId, actions, people, purpose, message),
      purgeSelf: linkId => purgeMemorySelf(this.db, scope, linkId),
      removeRecipient: (linkId, label) => removeMemoryPerson(this.db, scope, linkId, label),
    };
  }
  private current(scope: string): Snapshot | undefined {
    const found = this.db.prepare('SELECT snapshot FROM conversations WHERE scope=?').get(scope);
    return found ? SnapshotSchema.parse(JSON.parse(String(found['snapshot']))) : undefined;
  }
  private initial(p: AdapterPrincipal): Snapshot {
    return emptySnapshot(p.conversationId, 0);
  }
  /** Compra persistida da conversa; inválida ⇒ falha fechada (nunca tratada como ausente). */
  private purchaseOf(scope: string): PurchaseState | null {
    const found = this.db.prepare('SELECT domain FROM conversations WHERE scope=?').get(scope);
    if (!found || found['domain'] === null) return null;
    return parsePurchaseState(JSON.parse(String(found['domain'])));
  }
  private budget(scope: string) {
    const count = (sql: string, ...args: string[]) => Number(this.db.prepare(sql).get(...args)!['n']);
    if (count('SELECT count(*) AS n FROM events') >= this.limits.maxRecords ||
        count("SELECT count(*) AS n FROM operations WHERE status IN ('ACCEPTED','RUNNING','CANCEL_REQUESTED')") >= this.limits.maxPending ||
        count("SELECT count(*) AS n FROM operations WHERE scope=? AND status IN ('ACCEPTED','RUNNING','CANCEL_REQUESTED')", scope) >= this.limits.maxPerConversation) {
      throw new ContractError('LIMIT_EXCEEDED');
    }
  }
  private read(id: string, scope?: string): Row {
    const found = row(scope === undefined
      ? this.db.prepare('SELECT * FROM operations WHERE id=?').get(id)
      : this.db.prepare('SELECT * FROM operations WHERE id=? AND scope=?').get(id, scope));
    if (!found) throw new ContractError('NOT_FOUND');
    return found;
  }
  private write(saved: Row, operation: Operation, clear = terminal(operation)) {
    OperationSchema.parse(operation);
    assertOperation(operation, this.now());
    this.db.prepare(`UPDATE operations SET operation=?, status=?, body=CASE WHEN ? THEN NULL ELSE body END,
      owner=CASE WHEN ? THEN NULL ELSE owner END, token=CASE WHEN ? THEN NULL ELSE token END,
      lease_until=CASE WHEN ? THEN NULL ELSE lease_until END WHERE id=?`)
      .run(JSON.stringify(operation), operation.status, clear ? 1 : 0, clear ? 1 : 0, clear ? 1 : 0, clear ? 1 : 0, saved.id);
  }
  private failure(saved: Row, code: ErrorCode) {
    const op = JSON.parse(saved.operation) as Operation;
    this.write(saved, { ...op, status: code === 'RESULT_UNKNOWN' ? 'RESULT_UNKNOWN' : 'FAILED',
      pollAfterMs: null, error: contractErrorResponse(code).body.error,
      snapshot: null, changes: [], resultVersion: null, completeness: 'NONE' });
  }
  private cancelNow(saved: Row) {
    const op = JSON.parse(saved.operation) as Operation;
    this.write(saved, { ...op, status: 'CANCELLED', pollAfterMs: null, error: null });
  }

  accept(p: AdapterPrincipal, event: ConversationEvent, processingAvailable = true, session?: AccountSession): { status: 200 | 202; operation: Operation } {
    return this.transaction(() => {
      const scope = scopeKey(p);
      const snapshot = this.current(scope) ?? this.initial(p);
      assertScope(p, { ...p, version: snapshot.version }, event);
      const key = eventKey(p, event.eventId), hash = contentHash(event);
      const previous = this.db.prepare('SELECT * FROM events WHERE key=?').get(key);
      if (previous) {
        assertReplay(hash, String(previous['hash']));
        if (previous['kind'] !== 'EVENT') throw new ContractError('EVENT_CONFLICT');
        const saved = this.read(String(previous['operation_id']), scope);
        if (session && saved.account_session !== session.ref) throw new ContractError('LINK_CHANGED');
        return { status: 200, operation: this.emitted(saved) };
      }
      if (!processingAvailable) throw new ContractError('UNAVAILABLE');
      assertVersion(event.expectedVersion, snapshot.version);
      if (event.input.kind !== 'TEXT' || event.source.kind !== 'MESSAGE') throw new ContractError('ACTION_UNAVAILABLE');
      this.budget(scope);
      const operation: Operation = {
        contractVersion: '1.0', operationId: ref(), eventId: event.eventId, conversationId: p.conversationId,
        baseVersion: snapshot.version, resultVersion: null, status: 'ACCEPTED',
        createdAt: new Date(this.now()).toISOString(), deadlineAt: new Date(this.now() + this.limits.deadlineMs).toISOString(),
        pollAfterMs: 1000, completeness: 'NONE', snapshot: null, changes: [], error: null,
      };
      this.db.prepare('INSERT OR IGNORE INTO conversations(scope,snapshot) VALUES (?,?)').run(scope, JSON.stringify(snapshot));
      // D7: "evento aceito" renova a atividade; replays acima não renovam.
      this.db.prepare('UPDATE conversations SET last_activity_at=? WHERE scope=?').run(this.now(), scope);
      this.db.prepare('INSERT INTO operations(id,scope,event_id,body,operation,status,account_session,account_link_id) VALUES (?,?,?,?,?,?,?,?)')
        .run(operation.operationId, scope, event.eventId, JSON.stringify(event), JSON.stringify(operation), operation.status, session?.ref ?? null, session?.linkId ?? null);
      this.db.prepare('INSERT INTO events(key,scope,kind,hash,source,operation_id) VALUES (?,?,?,?,?,?)')
        .run(key, scope, 'EVENT', hash, JSON.stringify(event.source), operation.operationId);
      return { status: 202, operation };
    });
  }

  private sanitizeSnapshot(snapshot: Snapshot): Snapshot {
    const now = this.now();
    const clean = structuredClone(snapshot);
    clean.allowedActions = clean.allowedActions.filter(a => Date.parse(a.expiresAt) > now);
    if (clean.humanApproval && Date.parse(clean.humanApproval.expiresAt) <= now) clean.humanApproval = null;
    assertSnapshot(clean, now);
    return clean;
  }
  private emitted(saved: Row): Operation {
    const op = OperationSchema.parse(JSON.parse(saved.operation));
    if (op.snapshot) {
      const current = this.current(saved.scope);
      // Snapshot histórico não reemite referências utilizáveis em outra revisão.
      if (current?.version !== op.snapshot.version) {
        op.snapshot.allowedActions = []; op.snapshot.humanApproval = null;
      }
      op.snapshot = this.sanitizeSnapshot(op.snapshot);
    }
    assertOperation(op, this.now());
    return op;
  }
  operation(p: AdapterPrincipal, id: string, sessionRef?: string): Operation {
    const saved = this.read(id, scopeKey(p));
    if (sessionRef && saved.account_session !== sessionRef) throw new ContractError('LINK_CHANGED');
    return this.emitted(saved);
  }
  snapshot(p: AdapterPrincipal, sessionRef?: string): Snapshot {
    const snapshot = this.current(scopeKey(p));
    if (!snapshot) throw new ContractError('NOT_FOUND');
    if (sessionRef) {
      const bound = this.db.prepare('SELECT account_session FROM account_bindings WHERE scope=?').get(scopeKey(p));
      if (bound?.['account_session'] !== sessionRef) return emptySnapshot(p.conversationId, snapshot.version);
    }
    return this.sanitizeSnapshot(snapshot);
  }

  cancel(p: AdapterPrincipal, command: CancelCommand): { status: 200 | 202; result: CancelResult } {
    return this.transaction(() => {
      const scope = scopeKey(p), saved = this.read(command.operationId, scope);
      const snapshot = this.current(scope)!;
      assertScope(p, { ...p, version: snapshot.version }, command);
      const key = eventKey(p, command.eventId), hash = contentHash(command);
      const previous = this.db.prepare('SELECT * FROM events WHERE key=?').get(key);
      if (previous) {
        assertReplay(hash, String(previous['hash']));
        if (previous['kind'] !== 'CANCEL') throw new ContractError('EVENT_CONFLICT');
        const result = CancelResultSchema.parse(JSON.parse(String(previous['result'])));
        return { status: result.status === 'REQUESTED' ? 202 : 200, result };
      }
      assertVersion(command.expectedVersion, snapshot.version);
      const op = JSON.parse(saved.operation) as Operation;
      if (op.status === 'RESULT_UNKNOWN' || (saved.effect && !terminal(op))) throw new ContractError('RESULT_UNKNOWN');
      // Reserva de espaço para cancelamento: fila cheia não impede parar trabalho;
      // os registros são limitados a um comando novo por operação em andamento.
      if (op.status === 'CANCEL_REQUESTED') throw new ContractError('ACTION_UNAVAILABLE');
      const total = Number(this.db.prepare('SELECT count(*) AS n FROM events').get()!['n']);
      if (total >= this.limits.maxRecords + this.limits.maxPending) throw new ContractError('LIMIT_EXCEEDED');
      const status = terminal(op) ? 'ALREADY_TERMINAL' : op.status === 'ACCEPTED' ? 'CANCELLED' : 'REQUESTED';
      if (status === 'CANCELLED') this.cancelNow(saved);
      if (status === 'REQUESTED') this.write(saved, { ...op, status: 'CANCEL_REQUESTED' });
      const result: CancelResult = { contractVersion: '1.0', eventId: command.eventId,
        conversationId: p.conversationId, targetOperationId: op.operationId, status, remoteCancellation: 'NOT_REQUESTED' };
      this.db.prepare('INSERT INTO events(key,scope,kind,hash,source,operation_id,result) VALUES (?,?,?,?,?,?,?)')
        .run(key, scope, 'CANCEL', hash, JSON.stringify(command.source), op.operationId, JSON.stringify(result));
      return { status: status === 'REQUESTED' ? 202 : 200, result };
    });
  }

  recover() {
    this.transaction(() => {
      recoverCartWriteIntents(this.db, this.now());
      const rows = this.db.prepare("SELECT * FROM operations WHERE status IN ('ACCEPTED','RUNNING','CANCEL_REQUESTED') ORDER BY seq").all();
      for (const value of rows) {
        const saved = row(value)!, op = JSON.parse(saved.operation) as Operation;
        const deadline = Date.parse(op.deadlineAt) <= this.now();
        const lost = op.status !== 'ACCEPTED' && (saved.lease_until ?? 0) <= this.now();
        if (!deadline && !lost) continue;
        if (saved.effect) { this.failure(saved, 'RESULT_UNKNOWN'); continue; }
        if (op.status === 'CANCEL_REQUESTED') { this.cancelNow(saved); continue; }
        if (deadline || saved.attempts >= this.limits.maxAttempts) {
          this.failure(saved, deadline ? 'DEADLINE_EXCEEDED' : 'UNAVAILABLE'); continue;
        }
        this.db.prepare('UPDATE operations SET owner=NULL,token=NULL,lease_until=NULL WHERE id=?').run(saved.id);
        this.write(saved, { ...op, status: 'ACCEPTED' }, false);
      }
    });
  }

  claim(owner: string, activeIds: readonly string[] = []): Job | undefined {
    return this.transaction(() => {
      // Perder lease não encerra a promise antiga. Não retomar no mesmo processo
      // enquanto aquela execução ainda ocupa um slot, mesmo após abort.
      const exclude = activeIds.length ? ` AND id NOT IN (${activeIds.map(() => '?').join(',')})` : '';
      const saved = row(this.db.prepare(`SELECT * FROM operations WHERE status='ACCEPTED'${exclude} ORDER BY seq LIMIT 1`).get(...activeIds));
      if (!saved) return undefined;
      const op = JSON.parse(saved.operation) as Operation;
      // Estado ilegível de UMA conversa falha só a operação dela; a fila das demais continua (DATA-01).
      let snapshot: Snapshot, purchase: PurchaseState | null;
      try {
        snapshot = this.current(saved.scope)!;
        purchase = this.purchaseOf(saved.scope);
        if (saved.account_session) {
          const bound = this.db.prepare('SELECT account_session FROM account_bindings WHERE scope=?').get(saved.scope);
          if (bound?.['account_session'] !== saved.account_session) snapshot = emptySnapshot(snapshot.conversationId, snapshot.version);
          if (purchase?.linkId !== saved.account_link_id) purchase = null;
        }
      } catch {
        this.failure(saved, 'INTERNAL');
        return undefined;
      }
      if (Date.parse(op.deadlineAt) <= this.now()) { this.failure(saved, 'DEADLINE_EXCEEDED'); return undefined; }
      if (snapshot.version !== op.baseVersion) { this.failure(saved, 'STALE_VERSION'); return undefined; }
      const [, botId, organizerId, conversationId] = JSON.parse(saved.scope) as string[];
      const token = ref(), running: Operation = { ...op, status: 'RUNNING' };
      this.write(saved, running, false);
      this.db.prepare('UPDATE operations SET owner=?,token=?,lease_until=?,attempts=attempts+1 WHERE id=?')
        .run(owner, token, Math.min(this.now() + this.limits.leaseMs, Date.parse(op.deadlineAt)), op.operationId);
      return { operation: running, event: JSON.parse(saved.body!) as ConversationEvent,
        principal: { botId: botId!, organizerId: organizerId!, conversationId: conversationId! }, snapshot, token, purchase,
        ...(saved.account_session ? { accountSession: { ref: saved.account_session, linkId: saved.account_link_id ?? null } } : {}) };
    });
  }
  private owned(job: Job): Row | undefined {
    const saved = this.read(job.operation.operationId, scopeKey(job.principal));
    const op = JSON.parse(saved.operation) as Operation;
    return saved.token === job.token && !terminal(op) && (saved.lease_until ?? 0) > this.now() ? saved : undefined;
  }
  heartbeat(job: Job): boolean {
    const saved = this.owned(job);
    if (!saved || JSON.parse(saved.operation).status === 'CANCEL_REQUESTED') return false;
    this.db.prepare('UPDATE operations SET lease_until=? WHERE id=? AND token=?')
      .run(Math.min(this.now() + this.limits.leaseMs, Date.parse(job.operation.deadlineAt)), saved.id, job.token);
    return true;
  }
  beginExternalEffect(job: Job, authorize: (db: DatabaseSync) => void) {
    this.transaction(() => {
      const saved = this.owned(job);
      if (!saved || JSON.parse(saved.operation).status !== 'RUNNING') throw new ContractError('ACTION_UNAVAILABLE');
      assertVersion(job.operation.baseVersion, this.current(saved.scope)!.version);
      const blocked = this.db.prepare("SELECT id FROM operations WHERE scope=? AND effect=1 AND id<>? AND status IN ('RUNNING','CANCEL_REQUESTED','RESULT_UNKNOWN')")
        .get(saved.scope, saved.id);
      if (blocked) throw new ContractError('RESULT_UNKNOWN');
      if (saved.effect) throw new ContractError('ACTION_UNAVAILABLE');
      // BUY-01 deve consumir aprovação/intenção no MESMO banco e transação.
      const authorization: unknown = authorize(this.db);
      if (authorization !== undefined) {
        void Promise.resolve(authorization).catch(() => undefined);
        throw new ContractError('ACTION_UNAVAILABLE');
      }
      this.db.prepare('UPDATE operations SET effect=1 WHERE id=? AND token=?').run(saved.id, job.token);
    });
  }

  finish(job: Job, result: FinishInput): boolean {
    return this.transaction(() => {
      const saved = this.owned(job);
      if (!saved) return false;
      // CART-01: o domínio não muda durante efeito externo/resultado desconhecido.
      if (hasUnresolvedCartWrite(this.db, saved.scope)) { this.failure(saved, saved.effect ? 'RESULT_UNKNOWN' : 'UNAVAILABLE'); return false; }
      const op = JSON.parse(saved.operation) as Operation;
      if (op.status === 'CANCEL_REQUESTED') {
        if (saved.effect) this.failure(saved, 'RESULT_UNKNOWN'); else this.cancelNow(saved);
        return false;
      }
      if (this.current(saved.scope)!.version !== op.baseVersion) {
        this.failure(saved, saved.effect ? 'RESULT_UNKNOWN' : 'STALE_VERSION'); return false;
      }
      const snapshot = SnapshotSchema.parse(result.snapshot);
      // Processamento somente leitura não comprova carrinho/pedido/pagamento.
      if (!saved.effect && (snapshot.blocks.some(b => b.kind === 'OUTCOME') ||
          snapshot.phase === 'SUBMITTING' || snapshot.phase === 'CONFIRMED')) {
        throw new ContractError('INVALID_REQUEST');
      }
      if (snapshot.conversationId !== op.conversationId || snapshot.version !== op.baseVersion + 1 ||
          snapshot.humanApproval !== null || snapshot.allowedActions.length ||
          (saved.effect && !snapshot.blocks.some(b => b.kind === 'OUTCOME' && b.evidenceRef !== null && b.status !== 'UNKNOWN'))) {
        throw new ContractError('INVALID_REQUEST');
      }
      assertSnapshot(snapshot, this.now());
      // DATA-01: recalcula o domínio a partir do estado PERSISTIDO (não do que o processador viu nem de um estado pronto).
      let domain: ReturnType<typeof nextPurchase> | null = null;
      if (result.domain !== undefined) {
        try {
          const previous = this.purchaseOf(saved.scope);
          if (job.accountSession && previous && previous.linkId !== job.accountSession.linkId)
            this.db.prepare('INSERT OR IGNORE INTO retired_purchase_states VALUES(?,?,?)').run(saved.scope, previous.version, JSON.stringify(previous));
          domain = nextPurchase(job.accountSession && previous?.linkId !== job.accountSession.linkId ? null : previous, result.domain,
            { seed: saved.scope, eventId: op.eventId, maxParticipants: this.limits.maxParticipants });
        } catch (e) {
          if (e instanceof DomainError) throw new ContractError('INVALID_REQUEST');
          throw e;
        }
      }
      const endedStatus = domain?.state && domain.state.status !== 'ACTIVE' ? domain.state.status : null;
      // D7: o snapshot de encerramento é gerado pelo servidor; nada do processador (texto, pendências) sobrevive.
      const stored = endedStatus ? closingSnapshot(snapshot, endedStatus) : snapshot;
      // O bloco GROUP mostrado precisa refletir exatamente a compra gravada (participantes, nomes e teto).
      if (!endedStatus) assertGroupMatches(stored, domain ? domain.state : this.purchaseOf(saved.scope));
      if (result.memory) {
        if (result.memory.linkId !== result.domain?.linkId || job.event.input.kind !== 'TEXT') throw new ContractError('INVALID_REQUEST');
        commitMemory(this.db, saved.scope, op.eventId, job.event.input.text, result.memory, this.now());
      } else if (endedStatus && job.event.input.kind === 'TEXT' && /^Confirmo: apagar todos os dados deste pedido[.!]?$/iu.test(job.event.input.text)) {
        const linkId = domain?.state?.linkId;
        if (linkId) this.db.prepare('DELETE FROM assistant_memory_accounts WHERE scope=? AND account_ref=?').run(saved.scope, memoryAccountRef(linkId));
      }
      if (job.accountSession) this.db.prepare(`INSERT INTO account_bindings(scope,account_session,account_link_id) VALUES(?,?,?)
        ON CONFLICT(scope) DO UPDATE SET account_session=excluded.account_session, account_link_id=excluded.account_link_id`)
        .run(saved.scope, job.accountSession.ref, job.accountSession.linkId);
      const paths = [...new Set<ChangePath>([...result.paths, ...(domain?.paths ?? [])])];
      // Operações de domínio vêm de uma mensagem humana aceita: por padrão a origem é USER, não DERIVED.
      const cause = result.cause ?? (domain?.ops.length ? 'USER' : 'DERIVED');
      const changeId = ref();
      const complete: Operation = { ...op, status: 'SUCCEEDED', resultVersion: stored.version,
        snapshot: stored, completeness: result.completeness, pollAfterMs: null, error: null,
        changes: [{ changeId, eventId: op.eventId, source: job.event.source,
          baseVersion: op.baseVersion, resultVersion: stored.version, paths, cause }] };
      if (Buffer.byteLength(JSON.stringify(complete)) > this.limits.maxResultBytes) throw new ContractError('LIMIT_EXCEEDED');
      this.write(saved, complete);
      if (!domain || domain.state === null) {
        this.db.prepare('UPDATE conversations SET snapshot=?, last_activity_at=? WHERE scope=?')
          .run(JSON.stringify(stored), this.now(), saved.scope);
        return true;
      }
      if (endedStatus) {
        // D7: encerrar exclui a compra na mesma transação. O snapshot neutro de encerramento e a operação atual
        // também expiram: a atividade é renovada para o expurgo por inatividade apagá-los depois.
        this.db.prepare('UPDATE conversations SET snapshot=? WHERE scope=?').run(JSON.stringify(stored), saved.scope);
        this.purgeScope(saved.scope, op.operationId);
        this.db.prepare('UPDATE conversations SET last_activity_at=? WHERE scope=?').run(this.now(), saved.scope);
        return true;
      }
      const state: PurchaseState = { ...domain.state, version: snapshot.version };
      this.db.prepare('UPDATE conversations SET snapshot=?, domain=?, last_activity_at=? WHERE scope=?')
        .run(JSON.stringify(snapshot), JSON.stringify(parsePurchaseState(state)), this.now(), saved.scope);
      const insert = this.db.prepare(`INSERT INTO purchase_changes(change_id,scope,purchase_id,event_id,source,base_version,
        result_version,cause,caused_by,patch,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
      const source = JSON.stringify(job.event.source);
      // Associação/troca de vínculo é derivada: aponta para o evento causador sem fabricar mensagem humana.
      const link = domain.linkEvent ? JSON.stringify({ derived: domain.linkEvent === 'CHANGED' ? 'LINK_CHANGED' : 'LINK_ASSOCIATED' }) : null;
      // A linha das operações usa o changeId da operação; a derivada tem ID próprio e `caused_by` = changeId da
      // operação (referência canônica do contrato, em Operation.changes[]), exista ou não linha de operações.
      if (domain.ops.length) {
        insert.run(changeId, saved.scope, state.purchaseId, op.eventId, source, op.baseVersion, snapshot.version,
          cause, null, JSON.stringify(domain.ops), this.now());
      }
      if (link) {
        insert.run(ref(), saved.scope, state.purchaseId, op.eventId, source, op.baseVersion, snapshot.version,
          'DERIVED', changeId, link, this.now());
      }
      return true;
    });
  }

  /**
   * DEC-01 D7: exclui dados de compras sem evento aceito há `inactivityMs`. Escopos com trabalho em andamento ou
   * resultado externo desconhecido são preservados. Cada conversa roda num SAVEPOINT próprio: estado ilegível em uma
   * não impede o expurgo das demais (a falha é contada e registrada sem identificadores).
   */
  purge(): { purged: number; failed: number } {
    return this.transaction(() => {
      const cutoff = this.now() - this.limits.inactivityMs;
      const scopes = this.db.prepare(`SELECT scope FROM conversations c WHERE last_activity_at IS NOT NULL AND last_activity_at <= ?
        AND NOT EXISTS (SELECT 1 FROM operations o WHERE o.scope = c.scope
          AND (o.status IN ('ACCEPTED','RUNNING','CANCEL_REQUESTED','RESULT_UNKNOWN') OR (o.effect = 1 AND o.status <> 'SUCCEEDED')))
        AND NOT EXISTS (SELECT 1 FROM cart_write_intents w WHERE w.scope=c.scope AND w.state IN ('PENDING','RESULT_UNKNOWN'))`).all(cutoff);
      let purged = 0, failed = 0;
      for (const r of scopes) {
        this.db.exec('SAVEPOINT purge_scope');
        try {
          this.purgeScope(String(r['scope']), null);
          this.db.exec('RELEASE purge_scope');
          purged++;
        } catch {
          this.db.exec('ROLLBACK TO purge_scope');
          this.db.exec('RELEASE purge_scope');
          failed++;
        }
      }
      if (failed) log('error', 'retention.purge_failed', { component: 'turns', failed }); // nova tentativa no próximo ciclo
      return { purged, failed };
    });
  }

  /**
   * Remove a compra, os patches e o conteúdo histórico das operações do escopo. Mantém só a deduplicação
   * (chave + hash dos eventos e status das operações). Sem `keep`, o snapshot volta ao inicial com versão
   * incrementada, para que nada antigo passe na checagem de versão. Deve rodar dentro de uma transação.
   */
  private purgeScope(scope: string, keep: string | null) {
    if (hasUnresolvedCartWrite(this.db, scope)) throw new ContractError('RESULT_UNKNOWN');
    // Perfil é separado da compra; inatividade D7 apaga tudo. Limpar perfil explícito apaga a conta no finish.
    if (keep === null) this.db.prepare('DELETE FROM assistant_memory_accounts WHERE scope=?').run(scope);
    this.db.prepare('DELETE FROM retired_purchase_states WHERE scope=?').run(scope);
    this.db.prepare('DELETE FROM account_bindings WHERE scope=?').run(scope);
    // Dados da variante publicada continuam preservados na migração, mas sujeitos à mesma exclusão D7.
    for (const table of ['account_groups', 'conversation_accounts']) {
      if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))
        this.db.prepare(`DELETE FROM ${table} WHERE scope=?`).run(scope);
    }
    this.db.prepare('DELETE FROM cart_write_reviews WHERE scope=?').run(scope);
    // Mantém só tombstones técnicos para impedir replay; sem conteúdo da composição após D7.
    this.db.prepare("UPDATE cart_write_intents SET plan='{}' WHERE scope=?").run(scope);
    this.db.prepare('UPDATE cart_write_heads SET snapshot=NULL WHERE scope=?').run(scope);
    if (keep === null) {
      const current = this.current(scope)!;
      this.db.prepare('UPDATE conversations SET snapshot=?, domain=NULL, last_activity_at=NULL WHERE scope=?')
        .run(JSON.stringify(emptySnapshot(current.conversationId, current.version + 1)), scope);
    } else {
      this.db.prepare('UPDATE conversations SET domain=NULL, last_activity_at=NULL WHERE scope=?').run(scope);
    }
    this.db.prepare('DELETE FROM purchase_changes WHERE scope=?').run(scope);
    const rows = this.db.prepare('SELECT * FROM operations WHERE scope=? AND id<>?').all(scope, keep ?? '');
    for (const value of rows) {
      const saved = row(value)!, op = JSON.parse(saved.operation) as Operation;
      if (!terminal(op) || (!op.snapshot && !op.changes.length)) continue;
      const scrubbed: Operation = { ...op, changes: [],
        snapshot: op.snapshot ? emptySnapshot(op.conversationId, op.snapshot.version) : null };
      this.write(saved, scrubbed);
    }
    this.db.prepare(`UPDATE events SET source='"PURGED"' WHERE scope=? AND operation_id<>?`).run(scope, keep ?? '');
  }

  /**
   * OPS-02: contagens agregadas para observabilidade (sem escopo, identidade ou conteúdo).
   * `resultUnknown` inclui operações com marcador de escrita ainda não resolvido.
   */
  stats(): { pending: number; running: number; resultUnknown: number; activePurchases: number; records: number } {
    const n = (sql: string) => Number(this.db.prepare(sql).get()!['n']);
    return {
      pending: n("SELECT count(*) AS n FROM operations WHERE status IN ('ACCEPTED','CANCEL_REQUESTED')"),
      running: n("SELECT count(*) AS n FROM operations WHERE status='RUNNING'"),
      resultUnknown: n("SELECT count(*) AS n FROM operations WHERE status='RESULT_UNKNOWN' OR (effect=1 AND status NOT IN ('SUCCEEDED','FAILED','CANCELLED'))"),
      activePurchases: n('SELECT count(*) AS n FROM conversations WHERE domain IS NOT NULL'),
      records: n('SELECT count(*) AS n FROM events'),
    };
  }

  fail(job: Job, code: ErrorCode = 'INTERNAL') {
    this.transaction(() => {
      const saved = this.owned(job);
      if (!saved) return;
      if (saved.effect) this.failure(saved, 'RESULT_UNKNOWN');
      else if (JSON.parse(saved.operation).status === 'CANCEL_REQUESTED') this.cancelNow(saved);
      else this.failure(saved, code);
    });
  }
}

/** Snapshot neutro, sem blocos nem referências (estado inicial ou conteúdo expurgado). */
function emptySnapshot(conversationId: string, version: number): Snapshot {
  return { contractVersion: '1.0', conversationId, version, phase: 'COLLECTING',
    blocks: [], pending: [], allowedActions: [], humanApproval: null };
}

/** Snapshot gerado pelo servidor ao encerrar/cancelar: sem nada vindo do processador (D7). */
function closingSnapshot(snapshot: Snapshot, status: 'CLOSED' | 'CANCELLED'): Snapshot {
  const text = status === 'CLOSED'
    ? 'Compra encerrada. Os dados desta compra foram excluídos.'
    : 'Compra cancelada. Os dados desta compra foram excluídos.';
  return { ...emptySnapshot(snapshot.conversationId, snapshot.version), blocks: [{ kind: 'TEXT', source: 'SERVER', text }] };
}

/**
 * Bloco GROUP precisa refletir a compra gravada: no máximo um bloco, exatamente os mesmos participantes
 * (participantRef = participantId, mesmo nome) e o teto coletivo declarado (ou null). Texto de condições não é
 * verificável aqui e é responsabilidade de quem monta o snapshot.
 */
function assertGroupMatches(snapshot: Snapshot, state: PurchaseState | null) {
  const groups = snapshot.blocks.filter(b => b.kind === 'GROUP');
  if (!groups.length) return;
  const group = groups[0]!;
  if (groups.length > 1 || group.kind !== 'GROUP' || !state || state.status !== 'ACTIVE') throw new ContractError('INVALID_REQUEST');
  const byId = new Map(state.participants.map(p => [p.participantId, p.displayName]));
  const refs = new Set(group.participants.map(p => p.participantRef));
  const budget = state.groupLimit.state === 'DECLARED' ? state.groupLimit.value.amountCents : null;
  if (group.participants.length !== byId.size || refs.size !== byId.size || group.budgetCents !== budget ||
      group.participants.some(p => byId.get(p.participantRef) !== p.displayName)) throw new ContractError('INVALID_REQUEST');
}
