import { spawnSync } from 'node:child_process';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { CancelResultSchema, OperationSchema } from '../../src/server/contracts/conversation';
import { TurnStore } from '../../src/server/turns/store';
import { cancelEnvelope, event, principal, result, temporary } from './helpers';

describe('RUN-01 SQLite real e transações', () => {
  const stores: TurnStore[] = [], dirs: ReturnType<typeof temporary>[] = [];
  let now = 1_800_000_000_000;
  const open = (limits = {}) => {
    const dir = temporary(); dirs.push(dir);
    const store = new TurnStore(dir.file, limits, () => now); stores.push(store);
    return { store, dir };
  };
  afterEach(() => { for (const s of stores.splice(0)) s.close(); for (const d of dirs.splice(0)) d.clean(); now = 1_800_000_000_000; });

  it('replay recupera operação e proveniência após commit/reabertura, antes de conferir versão atual', () => {
    const { store, dir } = open();
    const first = store.accept(principal, event());
    const job = store.claim('one')!;
    expect(store.finish(job, result(job))).toBe(true);
    const completed = store.operation(principal, first.operation.operationId);
    expect(completed.changes[0]).toMatchObject({ source: event().source, eventId: event().eventId, baseVersion: 0, resultVersion: 1 });
    store.close();
    const reopened = new TurnStore(dir.file, {}, () => now); stores.push(reopened);
    expect(reopened.accept(principal, event())).toEqual({ status: 200, operation: completed });
    expect(reopened.snapshot(principal).version).toBe(1);
    expect(reopened.db.prepare('SELECT body FROM operations').get()!['body']).toBeNull();
    expect(reopened.db.prepare('SELECT count(*) AS n FROM events').get()!['n']).toBe(1);
  });

  it('unicidade e conflito são persistentes entre conexões; texto igual em novo update é outra intenção', () => {
    const { store, dir } = open();
    const other = new TurnStore(dir.file, {}, () => now); stores.push(other);
    const first = store.accept(principal, event());
    expect(other.accept(principal, event()).operation.operationId).toBe(first.operation.operationId);
    const changed = event(); changed.input = { kind: 'TEXT', text: 'Outro conteúdo' };
    expect(() => other.accept(principal, changed)).toThrowError('EVENT_CONFLICT');
    expect(other.accept(principal, event(2)).operation.operationId).not.toBe(first.operation.operationId);
  });

  it('rollback do aceite não deixa conversa, evento ou operação parcialmente gravados', () => {
    const { store } = open();
    store.db.exec("CREATE TRIGGER fail_accept BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'synthetic-fault'); END");
    expect(() => store.accept(principal, event())).toThrow();
    for (const table of ['conversations', 'events', 'operations']) {
      expect(store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!['n']).toBe(0);
    }
    store.db.exec('DROP TRIGGER fail_accept');
    expect(store.accept(principal, event()).status).toBe(202);
  });

  it('snapshot, resultado e versão fazem rollback juntos se o commit falha', () => {
    const { store } = open(); store.accept(principal, event());
    const job = store.claim('one')!;
    store.db.exec("CREATE TRIGGER fail_commit BEFORE UPDATE ON conversations BEGIN SELECT RAISE(ABORT, 'synthetic-fault'); END");
    expect(() => store.finish(job, result(job))).toThrow();
    expect(store.snapshot(principal).version).toBe(0);
    expect(store.operation(principal, job.operation.operationId).status).toBe('RUNNING');
    store.db.exec('DROP TRIGGER fail_commit');
    expect(store.finish(job, result(job))).toBe(true);
    expect(store.finish(job, result(job))).toBe(false);
  });

  it('correção concluída primeiro impede busca antiga de sobrescrever revisão mais nova', () => {
    const { store } = open();
    store.accept(principal, event(1)); store.accept(principal, event(2));
    const search = store.claim('old-search')!, correction = store.claim('correction')!;
    expect(store.finish(correction, result(correction, 'Orçamento corrigido'))).toBe(true);
    expect(store.finish(search, result(search, 'Resultado atrasado'))).toBe(false);
    expect(store.snapshot(principal).blocks[0]).toMatchObject({ text: 'Orçamento corrigido' });
    expect(store.operation(principal, search.operation.operationId)).toMatchObject({ status: 'FAILED', error: { code: 'STALE_VERSION' } });
    expect(() => store.accept(principal, event(3))).toThrowError('STALE_VERSION');
  });

  it('outra conversa/bot não acessa operação nem snapshot; origem divergente não é aceita', () => {
    const { store } = open(); const accepted = store.accept(principal, event());
    const other = { organizerId: '222222222', conversationId: '222222222', botId: '900001' };
    expect(() => store.operation(other, accepted.operation.operationId)).toThrowError('NOT_FOUND');
    expect(() => store.snapshot(other)).toThrowError('NOT_FOUND');
    expect(() => store.operation({ ...principal, botId: '900002' }, accepted.operation.operationId)).toThrowError('NOT_FOUND');
    const bad = event(2); bad.source.botId = '900002';
    expect(() => store.accept(principal, bad)).toThrowError('INVALID_SOURCE');
  });

  it('limites persistem, mas replay funciona com fila cheia; cancelamento enfileirado é local', () => {
    const { store } = open({ maxPending: 1, maxPerConversation: 1, maxRecords: 1 });
    const first = store.accept(principal, event());
    expect(() => store.accept(principal, event(2))).toThrowError('LIMIT_EXCEEDED');
    expect(store.accept(principal, event()).status).toBe(200);
    const envelope = cancelEnvelope(3);
    const command = { ...envelope, operationId: first.operation.operationId };
    const cancellation = store.cancel(principal, command);
    expect(CancelResultSchema.parse(cancellation.result)).toMatchObject({ status: 'CANCELLED', remoteCancellation: 'NOT_REQUESTED', eventId: 'tg-update-3' });
    expect(store.cancel(principal, command)).toEqual(cancellation);
    expect(store.operation(principal, first.operation.operationId)).toMatchObject({ status: 'CANCELLED', eventId: 'tg-update-1' });
  });

  it('cancelamento em execução persiste solicitação, mantém a origem original e só então termina', () => {
    const { store } = open(); const accepted = store.accept(principal, event()); const job = store.claim('one')!;
    const envelope = cancelEnvelope(2);
    const cancel = store.cancel(principal, { ...envelope, operationId: accepted.operation.operationId });
    expect(cancel.status).toBe(202);
    expect(store.operation(principal, accepted.operation.operationId).status).toBe('CANCEL_REQUESTED');
    expect(store.finish(job, result(job))).toBe(false);
    expect(store.operation(principal, accepted.operation.operationId).status).toBe('CANCELLED');
    expect(store.snapshot(principal).version).toBe(0);
    expect(store.cancel(principal, { ...envelope, eventId: 'tg-update-3', operationId: accepted.operation.operationId }).result.status).toBe('ALREADY_TERMINAL');
  });

  it('namespace de evento compartilhado não permite reutilização em cancelamento', () => {
    const { store } = open(); const accepted = store.accept(principal, event());
    const envelope = cancelEnvelope(1);
    expect(() => store.cancel(principal, { ...envelope, operationId: accepted.operation.operationId })).toThrowError('EVENT_CONFLICT');
  });

  it('lease expirado gera novo token, preserva operação, e worker antigo não publica nem renova', () => {
    const { store } = open(); store.accept(principal, event()); const old = store.claim('old')!;
    now += store.limits.leaseMs + 1; store.recover();
    const newer = store.claim('new')!;
    expect(newer.operation.operationId).toBe(old.operation.operationId);
    expect(newer.token).not.toBe(old.token);
    expect(store.heartbeat(old)).toBe(false);
    expect(store.finish(old, result(old))).toBe(false);
    expect(store.finish(newer, result(newer))).toBe(true);
  });

  it('prazo e quantidade de tentativas limitam recuperação de leituras', () => {
    const { store } = open({ maxAttempts: 1 }); store.accept(principal, event());
    const job = store.claim('one')!; now += store.limits.leaseMs + 1; store.recover();
    expect(store.operation(principal, job.operation.operationId)).toMatchObject({ status: 'FAILED', error: { code: 'UNAVAILABLE' } });
    const next = store.accept(principal, event(2)); now += store.limits.deadlineMs + 1; store.recover();
    expect(store.operation(principal, next.operation.operationId)).toMatchObject({ status: 'FAILED', error: { code: 'DEADLINE_EXCEEDED' } });
  });

  it('marcador anterior ao efeito impede replay de escrita e cancelamento enganoso após crash', () => {
    const { store } = open(); store.accept(principal, event()); const job = store.claim('one')!;
    store.beginExternalEffect(job, () => {});
    expect(() => store.beginExternalEffect(job, () => {})).toThrowError('ACTION_UNAVAILABLE');
    now += store.limits.leaseMs + 1; store.recover();
    expect(store.operation(principal, job.operation.operationId)).toMatchObject({ status: 'RESULT_UNKNOWN', error: { code: 'RESULT_UNKNOWN' } });
    expect(store.claim('new')).toBeUndefined();
    const envelope = cancelEnvelope(2);
    expect(() => store.cancel(principal, { ...envelope, operationId: job.operation.operationId })).toThrowError('RESULT_UNKNOWN');
    expect(store.accept(principal, event()).operation.status).toBe('RESULT_UNKNOWN');
    store.accept(principal, event(3)); const next = store.claim('new')!;
    expect(() => store.beginExternalEffect(next, () => {})).toThrowError('RESULT_UNKNOWN');
  });

  it('autorização e marcador são atômicos, e nenhum erro bruto é persistido', () => {
    const { store } = open(); store.accept(principal, event()); const job = store.claim('one')!;
    store.db.exec('CREATE TABLE synthetic_authorization (used INTEGER)');
    expect(() => store.beginExternalEffect(job, db => {
      db.exec('INSERT INTO synthetic_authorization(used) VALUES (1)');
      throw new Error('private-provider-secret');
    })).toThrow();
    expect(store.db.prepare('SELECT count(*) AS n FROM synthetic_authorization').get()!['n']).toBe(0);
    expect(() => store.beginExternalEffect(job, async () => {})).toThrowError('ACTION_UNAVAILABLE');
    expect(store.db.prepare('SELECT effect FROM operations').get()!['effect']).toBe(0);
    store.fail(job);
    expect(JSON.stringify(store.operation(principal, job.operation.operationId))).not.toContain('private-provider-secret');
  });

  it('resultado inválido, preços inconsistentes, tamanho e aprovação não são publicados', () => {
    for (const mutate of [
      (r: ReturnType<typeof result>) => { r.snapshot.version = 55; },
      (r: ReturnType<typeof result>) => { r.snapshot.humanApproval = { reviewRef: 'r'.repeat(24), approvalRef: 'a'.repeat(24), expectedVersion: 1, expiresAt: '2099-01-01T00:00:00Z' }; },
      (r: ReturnType<typeof result>) => { r.snapshot.blocks = [{ kind: 'PROPOSAL', proposalRef: 'p'.repeat(24), coverage: [], price: { kind: 'RANGE', currency: 'BRL', minCents: 100, maxCents: 1 } }]; },
      (r: ReturnType<typeof result>) => { r.snapshot.blocks = [{ kind: 'TEXT', text: 'x'.repeat(2000), source: 'SERVER' }]; },
    ]) {
      const { store } = open({ maxResultBytes: 1500 }); store.accept(principal, event()); const job = store.claim('one')!;
      const invalid = result(job); mutate(invalid);
      expect(() => store.finish(job, invalid)).toThrow();
      expect(store.snapshot(principal).version).toBe(0);
    }
  });

  for (const stage of ['accepted', 'running', 'effect', 'committed']) {
    it(`recupera após morte real do processo na etapa ${stage}`, () => {
      const dir = temporary(); dirs.push(dir);
      const child = spawnSync(process.execPath, ['--import', 'tsx', 'test/turns/crash-process.ts', dir.file, stage], { encoding: 'utf8', timeout: 20_000 });
      expect(child.status, child.stderr).toBe(17);
      const { operationId } = JSON.parse(child.stdout) as { operationId: string };
      now += 16_000;
      const store = new TurnStore(dir.file, {}, () => now); stores.push(store); store.recover();
      const replay = store.accept(principal, event());
      expect(replay.status).toBe(200); expect(replay.operation.operationId).toBe(operationId);
      expect(OperationSchema.safeParse(replay.operation).success).toBe(true);
      expect(replay.operation.status).toBe(stage === 'effect' ? 'RESULT_UNKNOWN' : stage === 'committed' ? 'SUCCEEDED' : 'ACCEPTED');
      if (stage === 'effect' || stage === 'committed') expect(store.claim('restarted')).toBeUndefined();
    });
  }

  it('não zera banco inválido e mantém permissões privadas onde suportadas', () => {
    const { store, dir } = open(); store.close();
    if (process.platform !== 'win32') expect(statSync(dir.file).mode & 0o777).toBe(0o600);
    writeFileSync(dir.file, 'synthetic-corrupted-database');
    expect(() => new TurnStore(dir.file)).toThrow();
    expect(readFileSync(dir.file, 'utf8')).toBe('synthetic-corrupted-database');
  });
});
