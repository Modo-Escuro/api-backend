// DATA-01 integrado à RUN-01: migração v2, atomicidade snapshot+domínio+patch, isolamento, versionamento,
// replay, troca de conta e exclusão D7 — em SQLite real.
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Snapshot } from '../../src/server/contracts/conversation';
import type { DomainChange, DomainOp } from '../../src/server/domain/purchase';
import { TurnRuntime, type TurnContext, type TurnResult } from '../../src/server/turns/runtime';
import { SCHEMA_VERSION, TurnStore, type Job } from '../../src/server/turns/store';
import { event, flush, principal, temporary } from './helpers';

const HOUR = 3600_000;
const other = { organizerId: '222222222', botId: principal.botId, conversationId: '222222222' };
function eventFor(p: typeof principal, n: number, expectedVersion = 0) {
  const e = event(n, expectedVersion);
  return { ...e, conversationId: p.conversationId, source: { ...e.source, conversationId: p.conversationId } };
}
function out(job: Pick<Job, 'snapshot'>, domain?: DomainChange, blocks: Snapshot['blocks'] = []): TurnResult {
  return {
    snapshot: { ...structuredClone(job.snapshot), version: job.snapshot.version + 1, blocks: [{ kind: 'TEXT', source: 'SERVER', text: 'ok' }, ...blocks] },
    completeness: 'COMPLETE', paths: ['PHASE'], cause: 'USER', ...(domain ? { domain } : {}),
  };
}
const ops = (...o: DomainOp[]): DomainChange => ({ ops: o });

describe('DATA-01 no armazenamento da RUN-01', () => {
  const stores: TurnStore[] = [], dirs: ReturnType<typeof temporary>[] = [];
  let now = 1_800_000_000_000;
  const open = (limits = {}, file?: string) => {
    const dir = file ? null : temporary();
    if (dir) dirs.push(dir);
    const store = new TurnStore(file ?? dir!.file, limits, () => now); stores.push(store);
    return { store, file: file ?? dir!.file };
  };
  /** Aceita, faz claim e finaliza um turno com o resultado produzido a partir do job. */
  const turn = (store: TurnStore, p: typeof principal, n: number, make: (job: Job) => TurnResult) => {
    const expected = (() => { try { return store.snapshot(p).version; } catch { return 0; } })();
    const accepted = store.accept(p, eventFor(p, n, expected));
    const job = store.claim('w')!;
    const ok = store.finish(job, make(job));
    return { accepted, job, ok, operation: store.operation(p, accepted.operation.operationId) };
  };
  const domainOf = (store: TurnStore, p = principal) => {
    const r = store.db.prepare("SELECT domain FROM conversations WHERE scope LIKE ?").get(`%"${p.organizerId}"%`);
    return r?.['domain'] ? JSON.parse(String(r['domain'])) : null;
  };
  const changes = (store: TurnStore) => store.db.prepare('SELECT * FROM purchase_changes ORDER BY result_version, cause DESC').all();
  afterEach(() => { for (const s of stores.splice(0)) s.close(); for (const d of dirs.splice(0)) d.clean(); now = 1_800_000_000_000; });

  describe('migração', () => {
    it('banco v1 existente com dados migra para v2 preservando operações, snapshot e replay', () => {
      const dir = temporary(); dirs.push(dir);
      // 1) produz um turno sem domínio (o que a RUN-01 já gravava)…
      const writer = new TurnStore(dir.file, {}, () => now);
      const first = turn(writer, principal, 1, (job) => out(job));
      const snapshotBefore = writer.snapshot(principal);
      writer.close();
      // 2) …e rebaixa o arquivo para o formato v1 exato (sem colunas/tabela da DATA-01), com os dados dentro.
      const raw = new DatabaseSync(dir.file);
      raw.exec(`DROP TABLE purchase_changes; DROP INDEX conversations_activity;
        ALTER TABLE conversations DROP COLUMN domain; ALTER TABLE conversations DROP COLUMN last_activity_at; PRAGMA user_version=1;`);
      expect(raw.prepare('PRAGMA table_info(conversations)').all().map((c) => c['name'])).toEqual(['scope', 'snapshot']);
      raw.close();
      // 3) abrir com o código novo migra e preserva tudo.
      const { store } = open({}, dir.file);
      expect(Number(store.db.prepare('PRAGMA user_version').get()!['user_version'])).toBe(SCHEMA_VERSION);
      expect(store.snapshot(principal)).toEqual(snapshotBefore);
      expect(store.accept(principal, eventFor(principal, 1, 0))).toEqual({ status: 200, operation: first.operation });
      expect(store.db.prepare('PRAGMA table_info(conversations)').all().map((c) => c['name'])).toEqual(['scope', 'snapshot', 'domain', 'last_activity_at']);
      // e a compra pode começar normalmente sobre a conversa migrada
      expect(turn(store, principal, 2, (job) => out(job, ops({ op: 'ADD_PARTICIPANT', displayName: 'Ana' }))).ok).toBe(true);
      expect(domainOf(store).version).toBe(2);
    });

    it('duas conexões abrindo o mesmo banco novo não migram em duplicidade', () => {
      const { file } = open();
      const second = new TurnStore(file, {}, () => now); stores.push(second);
      expect(Number(second.db.prepare('PRAGMA user_version').get()!['user_version'])).toBe(2);
    });

    it('versão de esquema futura é recusada (fail closed)', () => {
      const dir = temporary(); dirs.push(dir);
      const db = new DatabaseSync(dir.file); db.exec('PRAGMA user_version=3'); db.close();
      expect(() => new TurnStore(dir.file, {}, () => now)).toThrow('Não foi possível abrir');
    });

    it('limite de participantes acima do contrato é recusado na configuração', () => {
      expect(() => open({ maxParticipants: 101 })).toThrow('acima do contrato');
    });
  });

  describe('persistência e atomicidade', () => {
    it('grava snapshot, domínio e patch juntos; changeId do patch = changeId da operação; reinício recupera a compra', () => {
      const { store, file } = open();
      const t = turn(store, principal, 1, (job) => out(job, ops({ op: 'ADD_PARTICIPANT', displayName: 'Ana' },
        { op: 'SET_LIMIT', target: 'GROUP', value: { amountCents: 18000, kind: 'MANDATORY' } })));
      expect(t.ok).toBe(true);
      const d = domainOf(store);
      expect(d).toMatchObject({ status: 'ACTIVE', version: 1, participants: [{ displayName: 'Ana' }] });
      expect(t.operation.changes[0]!.paths.sort()).toEqual(['BUDGET', 'PARTICIPANTS', 'PHASE']);
      const [c] = changes(store);
      expect(c).toMatchObject({ change_id: t.operation.changes[0]!.changeId, event_id: 'tg-update-1', cause: 'USER', base_version: 0, result_version: 1 });
      expect(JSON.parse(String(c!['source']))).toMatchObject({ kind: 'MESSAGE', messageId: '1' });
      expect(String(c!['source'])).not.toContain('Mensagem sintética'); // proveniência sem texto da mensagem
      store.close();
      const reopened = open({}, file).store;
      reopened.accept(principal, eventFor(principal, 2, 1));
      const job = reopened.claim('w')!;
      expect(job.purchase).toMatchObject({ purchaseId: d.purchaseId, version: 1, participants: [{ participantId: d.participants[0].participantId }] });
    });

    it('R$ 180 → R$ 150 em outro turno conserva participantes e restrições', () => {
      const { store } = open();
      turn(store, principal, 1, (job) => out(job, ops({ op: 'ADD_PARTICIPANT', displayName: 'Ana' },
        { op: 'SET_LIMIT', target: 'GROUP', value: { amountCents: 18000, kind: 'MANDATORY' } })));
      const ana = domainOf(store).participants[0];
      turn(store, principal, 2, (job) => out(job, ops({ op: 'ADD_RESTRICTION', participantId: ana.participantId, key: { kind: 'ALLERGY', code: 'PEANUT' } })));
      const before = domainOf(store);
      turn(store, principal, 3, (job) => out(job, ops({ op: 'SET_LIMIT', target: 'GROUP', value: { amountCents: 15000, kind: 'MANDATORY' } })));
      const after = domainOf(store);
      expect(after.groupLimit.value.amountCents).toBe(15000);
      expect(after.participants).toEqual(before.participants);
      expect(after.version).toBe(3);
    });

    it('patch inválido: finish rejeita INVALID_REQUEST e nada muda (snapshot, domínio, patches)', () => {
      const { store } = open();
      turn(store, principal, 1, (job) => out(job, ops({ op: 'ADD_PARTICIPANT', displayName: 'Ana' })));
      const before = { snap: store.snapshot(principal), dom: domainOf(store), n: changes(store).length };
      store.accept(principal, eventFor(principal, 2, 1));
      const job = store.claim('w')!;
      expect(() => store.finish(job, out(job, ops({ op: 'SET_LIMIT', target: 'GROUP', value: { amountCents: 1, kind: 'MANDATORY' } },
        { op: 'REMOVE_PARTICIPANT', participantId: 'id-que-o-modelo-inventou' })))).toThrow('INVALID_REQUEST');
      expect(store.snapshot(principal)).toEqual(before.snap);
      expect(domainOf(store)).toEqual(before.dom);
      expect(changes(store)).toHaveLength(before.n);
    });

    it('estado pronto no resultado é recusado; o armazenamento só aceita operações', () => {
      const { store } = open();
      store.accept(principal, eventFor(principal, 1));
      const job = store.claim('w')!;
      const forged = { ops: [], state: { participants: [] } } as unknown as DomainChange;
      expect(() => store.finish(job, out(job, forged))).toThrow('INVALID_REQUEST');
    });

    it('máximo de participantes configurável no armazenamento', () => {
      const { store } = open({ maxParticipants: 2 });
      store.accept(principal, eventFor(principal, 1));
      const job = store.claim('w')!;
      expect(() => store.finish(job, out(job, ops(...['A', 'B', 'C'].map((displayName) => ({ op: 'ADD_PARTICIPANT' as const, displayName })))))).toThrow('INVALID_REQUEST');
    });
  });

  describe('isolamento, versão e replay', () => {
    it('organizadores têm compras separadas; ID de participante de outro organizador é rejeitado', () => {
      const { store } = open();
      turn(store, principal, 1, (job) => out(job, ops({ op: 'ADD_PARTICIPANT', displayName: 'Ana' })));
      const anaId = domainOf(store, principal).participants[0].participantId;
      store.accept(other, eventFor(other, 1));
      const job = store.claim('w')!;
      expect(job.purchase).toBeNull();
      expect(() => store.finish(job, out(job, ops({ op: 'RENAME_PARTICIPANT', participantId: anaId, displayName: 'Invasor' })))).toThrow('INVALID_REQUEST');
      expect(domainOf(store, principal).participants[0].displayName).toBe('Ana');
      expect(domainOf(store, other)).toBeNull();
    });

    it('turno baseado em versão antiga não sobrescreve a atual (STALE_VERSION)', () => {
      const { store } = open();
      store.accept(principal, eventFor(principal, 1, 0));
      store.accept(principal, eventFor(principal, 2, 0)); // os dois partiram da versão 0
      const first = store.claim('w')!;
      expect(store.finish(first, out(first, ops({ op: 'ADD_PARTICIPANT', displayName: 'Ana' })))).toBe(true);
      expect(store.claim('w')).toBeUndefined(); // o segundo falha no claim por versão
      const ops2 = store.db.prepare("SELECT operation FROM operations WHERE event_id='tg-update-2'").get()!;
      expect(JSON.parse(String(ops2['operation'])).error.code).toBe('STALE_VERSION');
      expect(domainOf(store).participants.map((p: { displayName: string }) => p.displayName)).toEqual(['Ana']);
    });

    it('finish depois que outro turno avançou a versão é rejeitado sem gravar domínio', () => {
      const { store } = open();
      store.accept(principal, eventFor(principal, 1, 0));
      const job = store.claim('w')!;
      // outro processo grava versão 1 por baixo (simula corrida no mesmo banco)
      const snap = store.snapshot(principal);
      store.db.prepare('UPDATE conversations SET snapshot=?').run(JSON.stringify({ ...snap, version: 1 }));
      expect(store.finish(job, { ...out(job, ops({ op: 'ADD_PARTICIPANT', displayName: 'Ana' })), snapshot: { ...out(job).snapshot, version: 1 } })).toBe(false);
      expect(domainOf(store)).toBeNull();
      expect(changes(store)).toHaveLength(0);
    });

    it('replay do mesmo evento devolve a operação sem novo patch', () => {
      const { store } = open();
      const t = turn(store, principal, 1, (job) => out(job, ops({ op: 'ADD_PARTICIPANT', displayName: 'Ana' })));
      expect(store.accept(principal, eventFor(principal, 1, 0))).toEqual({ status: 200, operation: t.operation });
      expect(changes(store)).toHaveLength(1);
      expect(store.claim('w')).toBeUndefined();
    });
  });

  describe('troca de conta', () => {
    it('linkId diferente invalida loja/endereço, preserva participantes e registra alteração DERIVED ligada ao evento', () => {
      const { store } = open();
      turn(store, principal, 1, (job) => out(job, { ops: [{ op: 'ADD_PARTICIPANT', displayName: 'Ana' }, { op: 'SET_MERCHANT', merchantId: 'merchant-1' }], linkId: 'link-A' }));
      const t = turn(store, principal, 2, (job) => out(job, { ops: [{ op: 'SET_PRIORITY', value: 'SPEED' }], linkId: 'link-B' }));
      expect(domainOf(store)).toMatchObject({ linkId: 'link-B', merchant: { state: 'NOT_ASKED' }, participants: [{ displayName: 'Ana' }] });
      const rows = changes(store).filter((c) => c['result_version'] === 2);
      expect(rows.map((c) => c['cause']).sort()).toEqual(['DERIVED', 'USER']);
      const derived = rows.find((c) => c['cause'] === 'DERIVED')!;
      expect(derived).toMatchObject({ event_id: 'tg-update-2', caused_by: t.operation.changes[0]!.changeId });
      expect(String(derived['patch'])).not.toContain('link-');
    });
  });

  describe('exclusão D7', () => {
    it('encerrar exclui a compra e o conteúdo histórico na mesma transação; mantém só deduplicação', () => {
      const { store } = open();
      const first = turn(store, principal, 1, (job) => out(job, ops({ op: 'ADD_PARTICIPANT', displayName: 'Ana' }),
        [{ kind: 'TEXT', source: 'MODEL', text: 'Ana entrou na compra' }]));
      const closing = turn(store, principal, 2, (job) => out(job, ops({ op: 'END', reason: 'CLOSED' })));
      expect(closing.ok).toBe(true);
      expect(domainOf(store)).toBeNull();
      expect(changes(store)).toHaveLength(0);
      const old = store.operation(principal, first.accepted.operation.operationId);
      expect(old).toMatchObject({ status: 'SUCCEEDED', changes: [], snapshot: { blocks: [] } });
      expect(JSON.stringify(old)).not.toContain('Ana');
      expect(closing.operation.snapshot!.blocks).toEqual([{ kind: 'TEXT', source: 'SERVER', text: 'Compra encerrada. Os dados desta compra foram excluídos.' }]);
      expect(store.accept(principal, eventFor(principal, 1, 0)).status).toBe(200);
      expect(store.db.prepare("SELECT source FROM events WHERE key LIKE '%tg-update-1%'").get()!['source']).toBe('"PURGED"');
      const nextTurn = turn(store, principal, 3, (job) => out(job, ops({ op: 'ADD_PARTICIPANT', displayName: 'Bia' })));
      expect(nextTurn.ok).toBe(true);
      expect(domainOf(store).participants.map((p: { displayName: string }) => p.displayName)).toEqual(['Bia']);
      expect(JSON.stringify(store.db.prepare('SELECT * FROM operations').all())).not.toContain('Mensagem sintética');
    });

    it('24 h sem evento aceito: expurga; antes disso, não; replay não renova; versão avança e evento antigo fica obsoleto', () => {
      const { store } = open();
      turn(store, principal, 1, (job) => out(job, ops({ op: 'ADD_PARTICIPANT', displayName: 'Ana' })));
      now += 24 * HOUR - 1;
      store.accept(principal, eventFor(principal, 1, 0)); // replay não conta como atividade
      expect(store.purge()).toEqual({ purged: 0, failed: 0 });
      now += 1;
      expect(store.purge()).toEqual({ purged: 1, failed: 0 });
      expect(domainOf(store)).toBeNull();
      expect(changes(store)).toHaveLength(0);
      expect(store.snapshot(principal)).toMatchObject({ version: 2, blocks: [] });
      expect(store.purge()).toEqual({ purged: 0, failed: 0 }); // idempotente
      expect(() => store.accept(principal, eventFor(principal, 9, 1))).toThrow('STALE_VERSION');
      expect(store.accept(principal, eventFor(principal, 9, 2)).status).toBe(202);
    });

    it('não expurga conversa com trabalho em andamento; expurga depois que ele termina', () => {
      const { store } = open();
      turn(store, principal, 1, (job) => out(job, ops({ op: 'ADD_PARTICIPANT', displayName: 'Ana' })));
      store.accept(principal, eventFor(principal, 2, 1));
      const job = store.claim('w')!;
      now += 25 * HOUR;
      store.heartbeat(job);
      expect(store.purge().purged).toBe(0);
      store.recover();
      expect(store.purge().purged).toBe(1);
      expect(domainOf(store)).toBeNull();
    });

    it('vínculo OAuth não é tocado pelo expurgo (armazenamento separado, OPS-01)', () => {
      const { store } = open();
      const tables = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r['name']);
      expect(tables).not.toEqual(expect.arrayContaining(['links', 'tokens']));
    });
  });

  describe('regressões da auditoria', () => {
    /** Bloco GROUP montado a partir do estado gravado (o que um processador correto faz). */
    const groupFrom = (store: TurnStore, p = principal): Snapshot['blocks'][number] => {
      const d = domainOf(store, p);
      return { kind: 'GROUP', participants: d.participants.map((x: { participantId: string; displayName: string }) => ({ participantRef: x.participantId, displayName: x.displayName, conditions: [] })),
        budgetCents: d.groupLimit.state === 'DECLARED' ? d.groupLimit.value.amountCents : null };
    };

    it('bug 3: encerramento descarta TEXT/pending do processador; snapshot de encerramento e operação expiram em 24 h', () => {
      const { store } = open();
      turn(store, principal, 1, (job) => out(job, ops({ op: 'ADD_PARTICIPANT', displayName: 'Ana' })));
      const closing = turn(store, principal, 2, (job) => ({ ...out(job, ops({ op: 'END', reason: 'CANCELLED' }),
        [{ kind: 'TEXT', source: 'MODEL', text: 'Ana (alergia a amendoim) pagou R$ 40' }]), snapshot: { ...out(job).snapshot, pending: ['Confirmar Pix da Ana'],
        blocks: [{ kind: 'TEXT', source: 'MODEL', text: 'Ana (alergia a amendoim) pagou R$ 40' }] } }));
      const stored = JSON.stringify(store.snapshot(principal)) + JSON.stringify(closing.operation);
      expect(stored).not.toMatch(/Ana|amendoim|Pix/);
      expect(store.snapshot(principal)).toMatchObject({ pending: [], blocks: [{ source: 'SERVER' }] });
      now += 24 * HOUR;
      expect(store.purge().purged).toBe(1);
      expect(store.snapshot(principal)).toMatchObject({ blocks: [], version: 3 });
      expect(store.operation(principal, closing.accepted.operation.operationId)).toMatchObject({ changes: [], snapshot: { blocks: [] } });
    });

    it('bug 4: conversa vinda do v1 ganha janela de expiração a partir da migração', () => {
      const dir = temporary(); dirs.push(dir);
      const writer = new TurnStore(dir.file, {}, () => now);
      turn(writer, principal, 1, (job) => ({ ...out(job), snapshot: { ...out(job).snapshot, blocks: [{ kind: 'TEXT', source: 'MODEL', text: 'dado pessoal antigo' }] } }));
      writer.close();
      const raw = new DatabaseSync(dir.file);
      raw.exec(`DROP TABLE purchase_changes; DROP INDEX conversations_activity;
        ALTER TABLE conversations DROP COLUMN domain; ALTER TABLE conversations DROP COLUMN last_activity_at; PRAGMA user_version=1;`);
      raw.close();
      now += 30 * 24 * HOUR; // dados antigos: migração acontece muito depois
      const { store } = open({}, dir.file);
      expect(store.db.prepare('SELECT last_activity_at FROM conversations').get()!['last_activity_at']).toBe(now);
      now += 24 * HOUR - 1;
      expect(store.purge().purged).toBe(0); // não apaga de surpresa logo após o deploy
      now += 1;
      expect(store.purge().purged).toBe(1);
      expect(JSON.stringify(store.db.prepare('SELECT * FROM conversations').all())).not.toContain('dado pessoal');
    });

    it('bug 5: GROUP precisa refletir a compra gravada (participantes, nomes, teto, um bloco só)', () => {
      const { store } = open();
      turn(store, principal, 1, (job) => out(job, ops({ op: 'ADD_PARTICIPANT', displayName: 'Ana' }, { op: 'SET_LIMIT', target: 'GROUP', value: { amountCents: 18000, kind: 'MANDATORY' } })));
      const good = groupFrom(store) as Extract<Snapshot['blocks'][number], { kind: 'GROUP' }>;
      const bad: Snapshot['blocks'][number][] = [
        { ...good, participants: [{ participantRef: 'INVENTADO_000000000000', displayName: 'Fantasma', conditions: [] }] },
        { ...good, participants: [{ ...good.participants[0]!, displayName: 'Outro nome' }] },
        { ...good, budgetCents: 99999 },
        { ...good, participants: [] },
      ];
      for (const block of bad) {
        store.accept(principal, eventFor(principal, 50 + bad.indexOf(block), 1));
        const job = store.claim('w')!;
        expect(() => store.finish(job, out(job, undefined, [block]))).toThrow('INVALID_REQUEST');
        store.fail(job, 'INVALID_REQUEST');
      }
      store.accept(principal, eventFor(principal, 60, 1));
      const twice = store.claim('w')!;
      expect(() => store.finish(twice, out(twice, undefined, [good, good]))).toThrow('INVALID_REQUEST');
      store.fail(twice, 'INVALID_REQUEST');
      store.accept(principal, eventFor(principal, 61, 1));
      const ok = store.claim('w')!;
      expect(store.finish(ok, out(ok, undefined, [good]))).toBe(true); // sem mudança de domínio: confere com o persistido
      // GROUP sem compra é recusado
      store.accept(other, eventFor(other, 1));
      const noPurchase = store.claim('w')!;
      expect(() => store.finish(noPurchase, out(noPurchase, undefined, [{ ...good, participants: [], budgetCents: null }]))).toThrow('INVALID_REQUEST');
    });

    it('bug 6: estado corrompido de uma conversa falha só a operação dela; as outras seguem e o expurgo isola a falha', async () => {
      const { store } = open();
      turn(store, principal, 1, (job) => out(job, ops({ op: 'ADD_PARTICIPANT', displayName: 'Ana' })));
      turn(store, other, 1, (job) => out(job, ops({ op: 'ADD_PARTICIPANT', displayName: 'Bia' })));
      store.db.prepare('UPDATE conversations SET domain=? WHERE scope LIKE ?').run('{"corrompido":true}', `%"${principal.organizerId}"%`);
      const a = store.accept(principal, eventFor(principal, 2, 1));
      const b = store.accept(other, eventFor(other, 2, 1));
      expect(store.claim('w')).toBeUndefined(); // operação de A falha isolada
      expect(store.operation(principal, a.operation.operationId)).toMatchObject({ status: 'FAILED', error: { code: 'INTERNAL' } });
      const jobB = store.claim('w')!;
      expect(jobB.operation.operationId).toBe(b.operation.operationId);
      expect(store.finish(jobB, out(jobB, ops({ op: 'ADD_PARTICIPANT', displayName: 'Caio' })))).toBe(true);
      // expurgo: snapshot ilegível em A não impede B
      store.db.prepare('UPDATE conversations SET snapshot=? WHERE scope LIKE ?').run('ilegivel', `%"${principal.organizerId}"%`);
      now += 25 * HOUR;
      const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      expect(store.purge()).toEqual({ purged: 1, failed: 1 });
      expect(String(err.mock.calls[0])).not.toContain(principal.organizerId);
      err.mockRestore();
      expect(domainOf(store, other)).toBeNull();
    });

    it('bug 6 (runtime): conversa corrompida não marca o runtime como indisponível', async () => {
      const dir = temporary(); dirs.push(dir);
      const store = new TurnStore(dir.file, {}, () => now);
      const runtime = new TurnRuntime(store, { processor: async (ctx) => out({ snapshot: ctx.snapshot }, ops({ op: 'ADD_PARTICIPANT', displayName: 'X' })) });
      try {
        runtime.accept(principal, eventFor(principal, 1, 0)); runtime.tick(); await flush(); runtime.tick();
        store.db.prepare('UPDATE conversations SET domain=?').run('{"corrompido":true}');
        runtime.accept(principal, eventFor(principal, 2, 1));
        runtime.accept(other, eventFor(other, 1, 0));
        runtime.tick(); await flush(); runtime.tick(); await flush(); runtime.tick();
        expect(() => runtime.accept(other, eventFor(other, 2, 1))).not.toThrow(); // continua saudável
        expect(store.snapshot(other).version).toBe(1);
      } finally {
        runtime.stop();
      }
    });

    it('bug 7: primeira associação do vínculo deixa rastro e invalida loja escolhida sem vínculo', () => {
      const { store } = open();
      turn(store, principal, 1, (job) => out(job, ops({ op: 'ADD_PARTICIPANT', displayName: 'Ana' }, { op: 'SET_MERCHANT', merchantId: 'm-sem-vinculo' })));
      const t = turn(store, principal, 2, (job) => out(job, { ops: [], linkId: 'link-A' }));
      expect(domainOf(store)).toMatchObject({ linkId: 'link-A', merchant: { state: 'NOT_ASKED' } });
      const row = changes(store).find((c) => c['result_version'] === 2)!;
      expect(row).toMatchObject({ cause: 'DERIVED', caused_by: t.operation.changes[0]!.changeId });
      expect(row['change_id']).not.toBe(t.operation.changes[0]!.changeId);
      expect(JSON.parse(String(row['patch']))).toEqual({ derived: 'LINK_ASSOCIATED' });
    });

    it('bug 7: compra criada já sob um vínculo registra a associação ligada à alteração do turno', () => {
      const { store } = open();
      const t = turn(store, principal, 1, (job) => out(job, { ops: [{ op: 'ADD_PARTICIPANT', displayName: 'Ana' }, { op: 'SET_MERCHANT', merchantId: 'm-1' }], linkId: 'link-A' }));
      expect(domainOf(store)).toMatchObject({ linkId: 'link-A', merchant: { state: 'DECLARED' } });
      const rows = changes(store);
      expect(rows.map((r) => r['cause']).sort()).toEqual(['DERIVED', 'USER']);
      expect(rows.find((r) => r['cause'] === 'DERIVED')).toMatchObject({ caused_by: t.operation.changes[0]!.changeId });
    });

    it('bug 8: END sem compra ativa é recusado e não apaga o histórico da conversa', () => {
      const { store } = open();
      const first = turn(store, principal, 1, (job) => ({ ...out(job), snapshot: { ...out(job).snapshot, blocks: [{ kind: 'TEXT', source: 'SERVER', text: 'histórico' }] } }));
      store.accept(principal, eventFor(principal, 2, 1));
      const job = store.claim('w')!;
      expect(() => store.finish(job, out(job, ops({ op: 'END', reason: 'CLOSED' })))).toThrow('INVALID_REQUEST');
      expect(store.operation(principal, first.accepted.operation.operationId).snapshot!.blocks).toEqual([{ kind: 'TEXT', source: 'SERVER', text: 'histórico' }]);
    });

    it('proveniência: operações de domínio vindas de mensagem humana são USER por padrão', () => {
      const { store } = open();
      const t = turn(store, principal, 1, (job) => { const r = out(job, ops({ op: 'ADD_PARTICIPANT', displayName: 'Ana' })); delete r.cause; return r; });
      expect(t.operation.changes[0]!.cause).toBe('USER');
      expect(changes(store)[0]).toMatchObject({ cause: 'USER' });
    });
  });

  describe('runtime', () => {
    it('processador usa purchase + previewDomain; IDs do snapshot batem com o estado gravado', async () => {
      const dir = temporary(); dirs.push(dir);
      const store = new TurnStore(dir.file, {}, () => now);
      const seen: TurnContext[] = [];
      const runtime = new TurnRuntime(store, {
        processor: async (ctx) => {
          seen.push(ctx);
          const change: DomainChange = ops({ op: 'ADD_PARTICIPANT', displayName: `P${seen.length}` });
          const preview = ctx.previewDomain(change)!;
          const participants = preview.participants.map((p) => ({ participantRef: p.participantId, displayName: p.displayName, conditions: [] }));
          return out({ snapshot: ctx.snapshot }, change, [{ kind: 'GROUP', participants, budgetCents: null }]);
        },
      });
      try {
        runtime.accept(principal, eventFor(principal, 1, 0));
        runtime.tick(); await flush(); runtime.tick();
        runtime.accept(principal, eventFor(principal, 2, 1));
        runtime.tick(); await flush(); runtime.tick();
        expect(seen[0]!.purchase).toBeNull();
        expect(seen[1]!.previewDomain(ops({ op: 'SET_PRIORITY', value: 'SPEED' }))!.version).toBe(2); // = versão que o commit grava
        expect(seen[1]!.purchase!.participants).toHaveLength(1);
        const group = store.snapshot(principal).blocks.find((b) => b.kind === 'GROUP');
        const refs = group && group.kind === 'GROUP' ? group.participants.map((p) => p.participantRef) : [];
        expect(refs).toEqual(domainOf(store).participants.map((p: { participantId: string }) => p.participantId));
      } finally {
        runtime.stop(); // fecha o banco
      }
    });

    it('patch inválido do processador termina a operação como FAILED/INVALID_REQUEST', async () => {
      const dir = temporary(); dirs.push(dir);
      const store = new TurnStore(dir.file, {}, () => now);
      const runtime = new TurnRuntime(store, {
        processor: async (ctx) => out({ snapshot: ctx.snapshot }, ops({ op: 'REMOVE_PARTICIPANT', participantId: 'inexistente-000000000000' })),
      });
      try {
        const a = runtime.accept(principal, eventFor(principal, 1, 0));
        runtime.tick(); await flush(); runtime.tick();
        expect(store.operation(principal, a.operation.operationId)).toMatchObject({ status: 'FAILED', error: { code: 'INVALID_REQUEST' } });
      } finally {
        runtime.stop();
      }
    });

    it('tick roda a expiração D7 no máximo uma vez por minuto', () => {
      const dir = temporary(); dirs.push(dir);
      const store = new TurnStore(dir.file, {}, () => now);
      const spy = vi.spyOn(store, 'purge');
      const runtime = new TurnRuntime(store, { processor: async (ctx) => out({ snapshot: ctx.snapshot }) });
      try {
        runtime.tick(); runtime.tick();
        expect(spy).toHaveBeenCalledTimes(1);
        now += TurnRuntime.PURGE_INTERVAL_MS;
        runtime.tick();
        expect(spy).toHaveBeenCalledTimes(2);
        spy.mockImplementation(() => { throw new Error('banco ocupado'); });
        now += TurnRuntime.PURGE_INTERVAL_MS;
        runtime.tick();
        expect(() => runtime.accept(principal, eventFor(principal, 1, 0))).not.toThrow(); // falha de expurgo não derruba a fila
      } finally {
        runtime.stop();
      }
    });
  });
});
