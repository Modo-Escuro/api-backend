import type { DatabaseSync } from 'node:sqlite';

/** Extensão aditiva da DATA-01; usa o mesmo banco e as mesmas transações do domínio. */
export function installCartWriteSchema(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cart_write_reviews (
      ref_hash TEXT PRIMARY KEY, scope TEXT NOT NULL, purchase_hash TEXT NOT NULL,
      plan TEXT NOT NULL, expires INTEGER NOT NULL, consumed INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS cart_write_intents (
      id TEXT PRIMARY KEY, scope TEXT NOT NULL, account TEXT NOT NULL, organizer TEXT NOT NULL,
      request_id TEXT NOT NULL, signature TEXT NOT NULL, callback_hash TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('PENDING','SUCCEEDED','FAILED','RESULT_UNKNOWN')),
      plan TEXT NOT NULL, step INTEGER NOT NULL DEFAULT 0, sent INTEGER NOT NULL DEFAULT 0,
      cart_id TEXT, code TEXT, lease_until INTEGER NOT NULL,
      UNIQUE(scope,request_id), UNIQUE(organizer,callback_hash)
    );
    CREATE INDEX IF NOT EXISTS cart_write_intents_scope ON cart_write_intents(scope,state);
    CREATE INDEX IF NOT EXISTS cart_write_intents_organizer ON cart_write_intents(organizer,state);
    CREATE TABLE IF NOT EXISTS cart_write_heads (
      account TEXT PRIMARY KEY, scope TEXT NOT NULL, link_id TEXT NOT NULL, purchase_id TEXT NOT NULL,
      cart_id TEXT NOT NULL, fingerprint TEXT, snapshot TEXT
    );
  `);
}

export function hasUnresolvedCartWrite(db: DatabaseSync, scope: string): boolean {
  return Boolean(db.prepare("SELECT id FROM cart_write_intents WHERE scope=? AND state IN ('PENDING','RESULT_UNKNOWN') LIMIT 1").get(scope));
}

/** OPS-02: apenas contagens persistidas, sem identidade, composição ou referências. */
export function cartIntentSummary(db: DatabaseSync) {
  const result = { PENDING: 0, SUCCEEDED: 0, FAILED: 0, RESULT_UNKNOWN: 0 };
  try {
    for (const row of db.prepare('SELECT state,count(*) count FROM cart_write_intents GROUP BY state').all()) {
      const state = String(row['state']) as keyof typeof result;
      if (state in result) result[state] = Number(row['count']);
    }
  } catch {
    return null; // Storage indisponível não é zero intenções e não derruba o diagnóstico de saúde.
  }
  return result;
}

/** Recuperação local sem replay de rede, inclusive quando o opt-in de escrita foi desligado. */
export function recoverCartWriteIntents(db: DatabaseSync, now: number): void {
  db.prepare("UPDATE cart_write_intents SET state=CASE WHEN sent=1 THEN 'RESULT_UNKNOWN' ELSE 'FAILED' END,code='INTERRUPTED' WHERE state='PENDING' AND lease_until<=?").run(now);
}
