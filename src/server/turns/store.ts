// RUN-01: fila e resultados transacionais. Nenhuma chamada a modelo/provedor neste módulo.
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CancelResultSchema, OperationSchema, SnapshotSchema, type ConversationEvent, type ErrorCode, type Operation, type Snapshot } from '../contracts/conversation.js';
import { contractErrorResponse } from '../contracts/errors.js';
import { assertOperation, assertReplay, assertScope, assertSnapshot, assertVersion, contentHash, ContractError, eventKey, type AdapterPrincipal } from '../contracts/guards.js';

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
}
export const DEFAULT_LIMITS: TurnLimits = {
  deadlineMs: 120_000, leaseMs: 15_000, maxPending: 100, maxPerConversation: 10,
  maxRecords: 10_000, maxAttempts: 3, maxResultBytes: 65_536,
};
export interface CancelCommand {
  contractVersion: '1.0'; eventId: string; conversationId: string; expectedVersion: number;
  source: ConversationEvent['source']; operationId: string;
}
type CancelResult = ReturnType<typeof CancelResultSchema.parse>;
export interface Job {
  operation: Operation; event: ConversationEvent; principal: AdapterPrincipal;
  snapshot: Snapshot; token: string;
}
interface Row {
  id: string; scope: string; event_id: string; body: string | null; operation: string;
  owner: string | null; token: string | null; lease_until: number | null; attempts: number;
  effect: number;
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
      const version = this.db.prepare('PRAGMA user_version').get()!['user_version'];
      if (version !== 0 && version !== 1) { this.db.close(); throw new Error('Versão de armazenamento não suportada.'); }
      const integrity = this.db.prepare('PRAGMA quick_check').get()!['quick_check'];
      if (integrity !== 'ok') { this.db.close(); throw new Error('Armazenamento inválido.'); }
      this.transaction(() => {
        this.db.exec(`
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
  private current(scope: string): Snapshot | undefined {
    const found = this.db.prepare('SELECT snapshot FROM conversations WHERE scope=?').get(scope);
    return found ? SnapshotSchema.parse(JSON.parse(String(found['snapshot']))) : undefined;
  }
  private initial(p: AdapterPrincipal): Snapshot {
    return { contractVersion: '1.0', conversationId: p.conversationId, version: 0, phase: 'COLLECTING',
      blocks: [], pending: [], allowedActions: [], humanApproval: null };
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

  accept(p: AdapterPrincipal, event: ConversationEvent, processingAvailable = true): { status: 200 | 202; operation: Operation } {
    return this.transaction(() => {
      const scope = scopeKey(p);
      const snapshot = this.current(scope) ?? this.initial(p);
      assertScope(p, { ...p, version: snapshot.version }, event);
      const key = eventKey(p, event.eventId), hash = contentHash(event);
      const previous = this.db.prepare('SELECT * FROM events WHERE key=?').get(key);
      if (previous) {
        assertReplay(hash, String(previous['hash']));
        if (previous['kind'] !== 'EVENT') throw new ContractError('EVENT_CONFLICT');
        return { status: 200, operation: this.emitted(this.read(String(previous['operation_id']), scope)) };
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
      this.db.prepare('INSERT INTO operations(id,scope,event_id,body,operation,status) VALUES (?,?,?,?,?,?)')
        .run(operation.operationId, scope, event.eventId, JSON.stringify(event), JSON.stringify(operation), operation.status);
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
  operation(p: AdapterPrincipal, id: string): Operation { return this.emitted(this.read(id, scopeKey(p))); }
  snapshot(p: AdapterPrincipal): Snapshot {
    const snapshot = this.current(scopeKey(p));
    if (!snapshot) throw new ContractError('NOT_FOUND');
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
      const op = JSON.parse(saved.operation) as Operation, snapshot = this.current(saved.scope)!;
      if (Date.parse(op.deadlineAt) <= this.now()) { this.failure(saved, 'DEADLINE_EXCEEDED'); return undefined; }
      if (snapshot.version !== op.baseVersion) { this.failure(saved, 'STALE_VERSION'); return undefined; }
      const [, botId, organizerId, conversationId] = JSON.parse(saved.scope) as string[];
      const token = ref(), running: Operation = { ...op, status: 'RUNNING' };
      this.write(saved, running, false);
      this.db.prepare('UPDATE operations SET owner=?,token=?,lease_until=?,attempts=attempts+1 WHERE id=?')
        .run(owner, token, Math.min(this.now() + this.limits.leaseMs, Date.parse(op.deadlineAt)), op.operationId);
      return { operation: running, event: JSON.parse(saved.body!) as ConversationEvent,
        principal: { botId: botId!, organizerId: organizerId!, conversationId: conversationId! }, snapshot, token };
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

  finish(job: Job, result: { snapshot: Snapshot; completeness: 'PARTIAL' | 'COMPLETE'; paths: Operation['changes'][number]['paths']; cause?: 'USER' | 'DERIVED' }): boolean {
    return this.transaction(() => {
      const saved = this.owned(job);
      if (!saved) return false;
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
      const complete: Operation = { ...op, status: 'SUCCEEDED', resultVersion: snapshot.version,
        snapshot, completeness: result.completeness, pollAfterMs: null, error: null,
        changes: [{ changeId: ref(), eventId: op.eventId, source: job.event.source,
          baseVersion: op.baseVersion, resultVersion: snapshot.version, paths: result.paths, cause: result.cause ?? 'DERIVED' }] };
      if (Buffer.byteLength(JSON.stringify(complete)) > this.limits.maxResultBytes) throw new ContractError('LIMIT_EXCEEDED');
      this.write(saved, complete);
      this.db.prepare('UPDATE conversations SET snapshot=? WHERE scope=?').run(JSON.stringify(snapshot), saved.scope);
      return true;
    });
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
