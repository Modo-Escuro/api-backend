import { afterEach, describe, expect, it, vi } from 'vitest';
import { TurnRuntime, type TurnContext, type TurnProcessor, type TurnResult } from '../../src/server/turns/runtime';
import { TurnStore } from '../../src/server/turns/store';
import { cancelEnvelope, deferred, event, flush, principal, result, temporary } from './helpers';

describe('RUN-01 worker limitado e abort', () => {
  const cleanup: (() => void)[] = [];
  let now = 1_800_000_000_000;
  function setup(processor?: TurnProcessor) {
    const dir = temporary(), store = new TurnStore(dir.file, {}, () => now);
    const runtime = new TurnRuntime(store, { processor });
    cleanup.push(() => { runtime.stop(); dir.clean(); });
    return { store, runtime };
  }
  afterEach(() => { cleanup.splice(0).forEach(f => f()); now = 1_800_000_000_000; });

  it('aceita antes de executar, não repete resultado e não espera modelo no recebimento', async () => {
    const work = deferred<TurnResult>();
    const processor = vi.fn((_context: TurnContext) => work.promise);
    const { runtime, store } = setup(processor);
    const accepted = runtime.accept(principal, event());
    expect(accepted.status).toBe(202); expect(processor).not.toHaveBeenCalled();
    runtime.tick();
    expect(store.operation(principal, accepted.operation.operationId).status).toBe('RUNNING');
    expect(runtime.accept(principal, event()).operation.operationId).toBe(accepted.operation.operationId);
    const context = processor.mock.calls[0]![0];
    work.resolve(result(context)); await flush(); runtime.tick();
    expect(store.operation(principal, accepted.operation.operationId).status).toBe('SUCCEEDED');
    expect(processor).toHaveBeenCalledTimes(1);
  });

  it('sem adaptador DATA/IA não aceita novo evento nem simula sucesso', () => {
    const { runtime, store } = setup();
    expect(() => runtime.accept(principal, event())).toThrowError('UNAVAILABLE');
    expect(store.db.prepare('SELECT count(*) AS n FROM operations').get()!['n']).toBe(0);
    const accepted = store.accept(principal, event());
    expect(runtime.accept(principal, event()).operation.operationId).toBe(accepted.operation.operationId);
  });

  it('limita concorrência a dois trabalhos e recupera erro sem corpo bruto', async () => {
    const pending = deferred<TurnResult>();
    const processor = vi.fn((_context: TurnContext) => pending.promise);
    const { runtime, store } = setup(processor);
    const ops = [1, 2, 3].map(n => runtime.accept(principal, event(n)).operation);
    runtime.tick(); expect(processor).toHaveBeenCalledTimes(2);
    expect(store.operation(principal, ops[2]!.operationId).status).toBe('ACCEPTED');
    pending.reject(new Error('private-provider-payload')); await flush();
    expect(JSON.stringify(store.operation(principal, ops[0]!.operationId))).not.toContain('private-provider-payload');
    runtime.tick(); expect(processor).toHaveBeenCalledTimes(3); await flush();
  });

  it('cancelamento em curso aborta sinal e resposta tardia não publica', async () => {
    const pending = deferred<TurnResult>();
    const processor = vi.fn((_context: TurnContext) => pending.promise);
    const { runtime, store } = setup(processor);
    const op = runtime.accept(principal, event()).operation; runtime.tick();
    const envelope = cancelEnvelope(2);
    expect(runtime.cancel(principal, { ...envelope, operationId: op.operationId }).result.status).toBe('REQUESTED');
    const context = processor.mock.calls[0]![0];
    expect(context.signal.aborted).toBe(true);
    pending.resolve(result(context)); await flush();
    expect(store.operation(principal, op.operationId).status).toBe('CANCELLED');
    expect(store.snapshot(principal).version).toBe(0);
  });

  it('limite de prazo encerra operação e bloqueia conclusão mesmo se processador ignora abort', async () => {
    const pending = deferred<TurnResult>(); const processor = vi.fn((_context: TurnContext) => pending.promise);
    const { runtime, store } = setup(processor); const op = runtime.accept(principal, event()).operation; runtime.tick();
    const context = processor.mock.calls[0]![0];
    now += store.limits.deadlineMs + 1; runtime.tick();
    expect(context.signal.aborted).toBe(true);
    pending.resolve(result(context)); await flush();
    expect(store.operation(principal, op.operationId)).toMatchObject({ status: 'FAILED', error: { code: 'DEADLINE_EXCEEDED' } });
    expect(store.snapshot(principal).version).toBe(0);
  });

  it('processador que ignora abort não abre slots ilimitados e fecha a admissão', async () => {
    const pending = deferred<TurnResult>(), processor = vi.fn((_context: TurnContext) => pending.promise);
    const { runtime, store } = setup(processor);
    runtime.accept(principal, event()); runtime.tick();
    const context = processor.mock.calls[0]![0];
    now += store.limits.deadlineMs + 1; runtime.tick();
    now += 2001; runtime.tick();
    expect(() => runtime.accept(principal, event(2))).toThrowError('UNAVAILABLE');
    pending.resolve(result(context)); await flush();
  });

  it('escrita externa permanece proibida sem autorização humana injetada pelo servidor', async () => {
    const remote = vi.fn();
    const { runtime, store } = setup(async context => {
      context.beforeExternalWrite(); remote(); return result(context);
    });
    const op = runtime.accept(principal, event()).operation; runtime.tick(); await flush();
    expect(remote).not.toHaveBeenCalled();
    expect(store.operation(principal, op.operationId).status).toBe('FAILED');
    expect(store.db.prepare('SELECT effect FROM operations').get()!['effect']).toBe(0);
  });

  it('stop aborta sem aguardar processador não cooperativo e resultado tardio não acessa banco fechado', async () => {
    const pending = deferred<TurnResult>(), processor = vi.fn((_context: TurnContext) => pending.promise);
    const { runtime } = setup(processor); runtime.accept(principal, event()); runtime.tick();
    const context = processor.mock.calls[0]![0]; runtime.stop();
    expect(context.signal.aborted).toBe(true);
    pending.resolve(result(context)); await flush();
    expect(() => runtime.accept(principal, event(2))).toThrowError('UNAVAILABLE');
  });
});
