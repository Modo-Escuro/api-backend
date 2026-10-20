import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, TurnStore } from '../../src/server/turns/store';
import { applyPatch } from '../../src/server/domain/purchase';
import { event, principal, temporary } from './helpers';

describe('v6: variantes v5 publicada e local', () => {
  it('schema incompatível aborta a migração sem marcar v6 ou substituir dados', () => {
    const dir = temporary();
    const store = new TurnStore(dir.file);
    store.db.exec('DROP TABLE account_bindings; CREATE TABLE account_bindings(scope TEXT); PRAGMA user_version=5;');
    store.db.prepare('INSERT INTO account_bindings VALUES(?)').run('synthetic-preserved-scope');
    store.close();
    try {
      expect(() => new TurnStore(dir.file)).toThrow('Não foi possível abrir');
      const raw = new DatabaseSync(dir.file);
      try {
        expect(raw.prepare('PRAGMA user_version').get()!['user_version']).toBe(5);
        expect(raw.prepare('SELECT * FROM account_bindings').get()!['scope']).toBe('synthetic-preserved-scope');
      } finally { raw.close(); }
    } finally { dir.clean(); }
  });
  it.each(['published', 'local'] as const)('migra %s preservando domínio, evento, intenção desconhecida e dados próprios', variant => {
    const dir = temporary();
    let store = new TurnStore(dir.file);
    const accepted = store.accept(principal, event());
    const scope = JSON.stringify(['TELEGRAM', principal.botId, principal.organizerId, principal.conversationId]);
    const purchase = applyPatch(null, [{ op: 'ADD_PARTICIPANT', displayName: 'Pessoa sintética' }], { seed: 'migration', eventId: 'seed' }).state;
    store.db.prepare('UPDATE conversations SET domain=?').run(JSON.stringify(purchase));
    // Banco real da variante local: fatos/sessão já existentes devem sobreviver à atualização.
    store.db.prepare('INSERT INTO assistant_memory_accounts VALUES(?,?,?,?,?)').run(scope, 'synthetic-account', 3, null, 1);
    store.db.prepare('INSERT INTO account_bindings VALUES(?,?,?)').run(scope, 'synthetic-session', 'link-A');
    const job = store.claim('migration-test')!;
    store.beginExternalEffect(job, () => {});
    store.fail(job, 'INTERNAL');
    store.db.prepare(`INSERT INTO cart_write_intents(id,scope,account,organizer,request_id,signature,callback_hash,state,plan,sent,lease_until)
      VALUES(?,?,?,?,?,?,?,'RESULT_UNKNOWN',?,1,0)`).run('synthetic-intent', scope, 'synthetic-account', principal.organizerId,
        'synthetic-request', 'synthetic-signature', 'synthetic-callback', '{"source":"synthetic"}');
    const tables = ['assistant_memory_facts', 'assistant_memory_people', 'assistant_memory_accounts', 'account_bindings', 'retired_purchase_states'];
    if (variant === 'published') {
      for (const table of tables) store.db.exec(`DROP TABLE ${table};`);
      store.db.exec(`ALTER TABLE operations DROP COLUMN account_session; ALTER TABLE operations DROP COLUMN account_link_id;
        CREATE TABLE account_groups(scope TEXT NOT NULL, account_key TEXT NOT NULL, data TEXT NOT NULL, version INTEGER NOT NULL, PRIMARY KEY(scope,account_key));
        CREATE TABLE conversation_accounts(scope TEXT PRIMARY KEY, account_key TEXT NOT NULL, session_ref TEXT NOT NULL);
        CREATE TABLE operation_accounts(operation_id TEXT PRIMARY KEY REFERENCES operations(id) ON DELETE CASCADE, session_ref TEXT NOT NULL);`);
      store.db.prepare('INSERT INTO account_groups VALUES(?,?,?,?)').run(scope, 'old-account', '{"participants":[]}', 7);
      store.db.prepare('INSERT INTO conversation_accounts VALUES(?,?,?)').run(scope, 'old-account', 'old-session');
      store.db.prepare('INSERT INTO operation_accounts VALUES(?,?)').run(accepted.operation.operationId, 'old-session');
    }
    store.db.exec('PRAGMA user_version=5;');
    const before = store.db.prepare('SELECT * FROM operations').all();
    store.close();
    store = new TurnStore(dir.file);
    try {
      expect(SCHEMA_VERSION).toBe(6);
      expect(store.db.prepare('PRAGMA user_version').get()!['user_version']).toBe(6);
      const after = store.db.prepare('SELECT * FROM operations').all();
      for (const [name, value] of Object.entries(before[0]!)) expect(after[0]![name]).toEqual(value);
      expect(store.stats().resultUnknown).toBe(1);
      expect(JSON.parse(String(store.db.prepare('SELECT domain FROM conversations').get()!['domain']))).toEqual(purchase);
      expect(store.db.prepare('SELECT state,plan FROM cart_write_intents').get()).toMatchObject({ state: 'RESULT_UNKNOWN', plan: '{"source":"synthetic"}' });
      expect(store.purge()).toEqual({ purged: 0, failed: 0 });
      expect(store.memory(principal).directory('link-A')).toMatchObject({ recipients: [], revision: 0 });
      if (variant === 'published') {
        expect(store.db.prepare('SELECT version FROM account_groups').get()!['version']).toBe(7);
        expect(store.db.prepare('SELECT session_ref FROM operation_accounts').get()!['session_ref']).toBe('old-session');
        expect(after[0]!['account_session']).toBeNull(); // não associar retrospectivamente por suposição
      } else {
        expect(store.db.prepare('SELECT revision FROM assistant_memory_accounts').get()!['revision']).toBe(3);
        expect(store.db.prepare('SELECT account_session FROM account_bindings').get()!['account_session']).toBe('synthetic-session');
      }
    } finally { store.close(); dir.clean(); }
  });
});
import { DatabaseSync } from 'node:sqlite';
