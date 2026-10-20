import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { ContractError } from '../contracts/guards.js';
import {
  factKey, MemoryCommitSchema, MemoryContextSchema, MemoryFactSchema, MemoryPersonSchema, profile, projectAction,
  recipient, SELF, validateMemoryAction,
  type MemoryAction, type MemoryCommit, type MemoryDirectory, type MemoryFact, type MemoryPerson, type MemoryPurpose,
} from './memory.js';

export function installMemorySchema(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS assistant_memory_accounts (
      scope TEXT NOT NULL, account_ref TEXT NOT NULL, revision INTEGER NOT NULL,
      context TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY(scope,account_ref),
      FOREIGN KEY(scope) REFERENCES conversations(scope));
    CREATE TABLE IF NOT EXISTS assistant_memory_people (
      scope TEXT NOT NULL, account_ref TEXT NOT NULL, person_ref TEXT NOT NULL,
      person TEXT NOT NULL, PRIMARY KEY(scope,account_ref,person_ref),
      FOREIGN KEY(scope,account_ref) REFERENCES assistant_memory_accounts(scope,account_ref) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS assistant_memory_facts (
      scope TEXT NOT NULL, account_ref TEXT NOT NULL, person_ref TEXT NOT NULL,
      fact_key TEXT NOT NULL, fact TEXT NOT NULL, PRIMARY KEY(scope,account_ref,person_ref,fact_key),
      FOREIGN KEY(scope,account_ref,person_ref) REFERENCES assistant_memory_people(scope,account_ref,person_ref) ON DELETE CASCADE);
  `);
}

/** Partição provisória por vínculo real autenticado: não afirma conhecer o userId iFood. */
export function memoryAccountRef(linkId: string) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(linkId)) throw new ContractError('INVALID_REQUEST');
  return createHash('sha256').update(JSON.stringify(['IFOOD_AUTHENTICATED_LINK', linkId])).digest('hex');
}

const CONTEXT_TTL = 15 * 60_000;
export function memoryDirectory(db: DatabaseSync, scope: string, linkId: string, now: number): MemoryDirectory {
  const account = memoryAccountRef(linkId);
  const row = db.prepare('SELECT revision,context,updated_at FROM assistant_memory_accounts WHERE scope=? AND account_ref=?').get(scope, account);
  const recipients = db.prepare("SELECT person FROM assistant_memory_people WHERE scope=? AND account_ref=? AND person_ref<>'SELF' ORDER BY person_ref")
    .all(scope, account).map(r => MemoryPersonSchema.parse(JSON.parse(String(r['person']))));
  return { revision: row ? Number(row['revision']) : 0, recipients,
    previous: row?.['context'] && Number(row['updated_at']) + CONTEXT_TTL > now
      ? MemoryContextSchema.parse(JSON.parse(String(row['context']))) : null };
}

function factsFor(db: DatabaseSync, scope: string, account: string, ref: string, purpose: MemoryPurpose): MemoryFact[] {
  // A seleção de finalidade ocorre no SQL: nenhuma alergia é lida para flores/presentes não alimentares.
  const filter = purpose === 'FOOD'
    ? "(fact_key LIKE 'ALLERGY:%' OR fact_key LIKE 'DIETARY:%' OR fact_key='NO_RESTRICTIONS' OR fact_key LIKE 'PREFERENCE:FOOD:%' OR fact_key LIKE 'PREFERENCE:GENERAL:%')"
    : purpose === 'NON_FOOD' ? "(fact_key LIKE 'PREFERENCE:GIFT:%' OR fact_key LIKE 'PREFERENCE:GENERAL:%')"
      : "fact_key LIKE 'PREFERENCE:GENERAL:%'";
  return db.prepare(`SELECT fact FROM assistant_memory_facts WHERE scope=? AND account_ref=? AND person_ref=? AND ${filter}`)
    .all(scope, account, ref).map(r => MemoryFactSchema.parse(JSON.parse(String(r['fact']))));
}
export function retrieveMemory(db: DatabaseSync, scope: string, linkId: string, people: readonly MemoryPerson[], purpose: MemoryPurpose) {
  const account = memoryAccountRef(linkId);
  return people.map(person => profile(person, factsFor(db, scope, account, person.ref, purpose), purpose));
}

/** Confirmação digitada pelo titular (nunca pelo modelo). Vale só para a partição deste vínculo. */
export function purgeMemorySelf(db: DatabaseSync, scope: string, linkId: string): boolean {
  const account = memoryAccountRef(linkId);
  const row = db.prepare('SELECT revision FROM assistant_memory_accounts WHERE scope=? AND account_ref=?').get(scope, account);
  if (!row) return false;
  const deleted = db.prepare("DELETE FROM assistant_memory_facts WHERE scope=? AND account_ref=? AND person_ref='SELF'").run(scope, account);
  if (Number(deleted['changes'] ?? 0) === 0) return false;
  db.prepare('UPDATE assistant_memory_accounts SET revision=revision+1 WHERE scope=? AND account_ref=?').run(scope, account);
  return true;
}

export function removeMemoryPerson(db: DatabaseSync, scope: string, linkId: string, label: string): boolean {
  const ref = recipient(label).ref;
  const account = memoryAccountRef(linkId);
  const row = db.prepare('SELECT revision FROM assistant_memory_accounts WHERE scope=? AND account_ref=?').get(scope, account);
  if (!row) return false;
  const deleted = db.prepare('DELETE FROM assistant_memory_people WHERE scope=? AND account_ref=? AND person_ref=?')
    .run(scope, account, ref);
  if (Number(deleted['changes'] ?? 0) === 0) return false;
  db.prepare('UPDATE assistant_memory_accounts SET revision=revision+1 WHERE scope=? AND account_ref=?').run(scope, account);
  return true;
}

/** Diretório por vínculo para o bot: só personas, sem fatos. */
export function memoryRecipients(db: DatabaseSync, scope: string, linkId: string): { label: string; kind: MemoryPerson['kind'] }[] {
  const account = memoryAccountRef(linkId);
  return db.prepare('SELECT person FROM assistant_memory_people WHERE scope=? AND account_ref=? ORDER BY CASE WHEN person_ref=\'SELF\' THEN 0 ELSE 1 END, person_ref')
    .all(scope, account).map(r => {
      const p = MemoryPersonSchema.parse(JSON.parse(String(r['person'])));
      return { label: String(p['label']), kind: String(p['kind']) as MemoryPerson['kind'] };
    });
}

export function validateMemoryActions(db: DatabaseSync, scope: string, linkId: string, proposed: readonly MemoryAction[],
  people: readonly MemoryPerson[], purpose: MemoryPurpose, message: string) {
  const actions: MemoryAction[] = [], notes: string[] = [];
  const account = memoryAccountRef(linkId), seen = new Set<string>();
  // Leitura para validação de escrita apenas das pessoas explicitamente autorizadas; esses fatos não vão à IA.
  const profiles = people.map(p => profile(p, factsFor(db, scope, account, p.ref, purpose), purpose));
  for (const action of proposed) {
    const key = JSON.stringify(action);
    if (seen.has(key)) continue;
    seen.add(key);
    const invalid = validateMemoryAction(action, message, people, purpose) ?? projectAction(profiles, action);
    if (invalid) { notes.push(invalid); continue; }
    actions.push(action);
  }
  return { actions, notes: [...new Set(notes)] };
}

/** Chamada exclusivamente pelo finish do turno, dentro da mesma transação do snapshot. */
export function commitMemory(db: DatabaseSync, scope: string, eventId: string, message: string, raw: MemoryCommit, now: number) {
  const parsed = MemoryCommitSchema.safeParse(raw);
  if (!parsed.success) throw new ContractError('INVALID_REQUEST');
  const commit = parsed.data, account = memoryAccountRef(commit.linkId);
  const row = db.prepare('SELECT revision FROM assistant_memory_accounts WHERE scope=? AND account_ref=?').get(scope, account);
  if ((row ? Number(row['revision']) : 0) !== commit.baseRevision) throw new ContractError('STALE_VERSION');
  if (commit.clear) {
    if (!/^Confirmo: apagar todos os dados deste pedido[.!]?$/iu.test(message)) throw new ContractError('INVALID_REQUEST');
    db.prepare('DELETE FROM assistant_memory_accounts WHERE scope=? AND account_ref=?').run(scope, account);
    return;
  }
  const people = [...new Map(commit.people.map(p => [p.ref, p])).values()];
  for (const person of people) {
    if (person.ref === 'SELF' ? person.kind !== 'SELF' || person.label !== SELF.label
      : person.kind !== 'RECIPIENT' || person.ref !== recipient(person.label).ref) throw new ContractError('INVALID_REQUEST');
  }
  if (commit.context.targets.some(p => !people.some(v => JSON.stringify(v) === JSON.stringify(p)))) throw new ContractError('INVALID_REQUEST');
  const validated = validateMemoryActions(db, scope, commit.linkId, commit.actions, people, commit.context.purpose, message);
  if (validated.actions.length !== commit.actions.length) throw new ContractError('INVALID_REQUEST');
  const existingPeople = Number(db.prepare('SELECT count(*) AS n FROM assistant_memory_people WHERE scope=? AND account_ref=?').get(scope, account)!['n']);
  const newPeople = people.filter(p => !db.prepare('SELECT 1 FROM assistant_memory_people WHERE scope=? AND account_ref=? AND person_ref=?').get(scope, account, p.ref));
  if (existingPeople + newPeople.length > 21) throw new ContractError('LIMIT_EXCEEDED');
  db.prepare(`INSERT INTO assistant_memory_accounts VALUES(?,?,?,?,?) ON CONFLICT(scope,account_ref)
    DO UPDATE SET revision=excluded.revision,context=excluded.context,updated_at=excluded.updated_at`)
    .run(scope, account, commit.baseRevision + 1, JSON.stringify(commit.context), now);
  for (const person of people) db.prepare('INSERT INTO assistant_memory_people VALUES(?,?,?,?) ON CONFLICT(scope,account_ref,person_ref) DO NOTHING')
    .run(scope, account, person.ref, JSON.stringify(person));
  for (const action of commit.actions) {
    const count = Number(db.prepare('SELECT count(*) AS n FROM assistant_memory_facts WHERE scope=? AND account_ref=? AND person_ref=?').get(scope, account, action.subjectRef)!['n']);
    const key = factKey(action);
    if (count >= 40 && !db.prepare('SELECT 1 FROM assistant_memory_facts WHERE scope=? AND account_ref=? AND person_ref=? AND fact_key=?').get(scope, account, action.subjectRef, key))
      throw new ContractError('LIMIT_EXCEEDED');
    const { evidenceQuote, ...stored } = action;
    const fact = MemoryFactSchema.parse({ key, action: stored, originEventId: eventId,
      evidenceHash: createHash('sha256').update(evidenceQuote).digest('hex'), recordedAt: now });
    if (action.action === 'REMEMBER_RESTRICTION') db.prepare("DELETE FROM assistant_memory_facts WHERE scope=? AND account_ref=? AND person_ref=? AND fact_key='NO_RESTRICTIONS'")
      .run(scope, account, action.subjectRef);
    db.prepare('INSERT INTO assistant_memory_facts VALUES(?,?,?,?,?) ON CONFLICT(scope,account_ref,person_ref,fact_key) DO UPDATE SET fact=excluded.fact')
      .run(scope, account, action.subjectRef, key, JSON.stringify(fact));
  }
}
