import { afterEach, describe, expect, it } from 'vitest';
import { accountSession } from '../../src/server/turns/account-session';
import { TurnRuntime } from '../../src/server/turns/runtime';
import { TurnStore } from '../../src/server/turns/store';
import { event, flush, principal, result, temporary } from './helpers';

describe('vínculo conta ↔ fila (account_bindings)', () => {
  const cleanup: (() => void)[] = [];
  afterEach(() => { cleanup.splice(0).forEach(f => f()); });

  function setup(linkId: string | null = 'link-A') {
    const dir = temporary(), store = new TurnStore(dir.file);
    const state = { linkId: linkId as string | undefined };
    const runtime = new TurnRuntime(store, { processor: async ctx => result(ctx),
      sessionOf: async p => accountSession(p, state.linkId ?? null) });
    cleanup.push(() => { runtime.stop(); dir.clean(); });
    return { dir, store, runtime, state };
  }

  it('aceite com cabeçalho do vínculo grava ligação; relogin cancela replay, consulta e revelação', async () => {
    const { store, runtime, state } = setup();
    const header = (await runtime.accountContext(principal)).sessionRef;
    const e = event();
    const accepted = runtime.accept(principal, e, await runtime.authorizeSession(principal, header)).operation;
    runtime.tick(); await flush();
    expect(store.operation(principal, accepted.operationId).status).toBe('SUCCEEDED');
    state.linkId = 'link-B';
    await expect(runtime.authorizeSession(principal, header)).rejects.toMatchObject({ code: 'LINK_CHANGED' });
    await expect(async () => runtime.accept(principal, e, await runtime.authorizeSession(principal, header)))
      .rejects.toMatchObject({ code: 'LINK_CHANGED' });
    const gated = store.snapshot(principal, (await runtime.accountContext(principal)).sessionRef);
    expect(gated.version).toBe(store.snapshot(principal).version);
    expect(gated.blocks).toEqual([]);
    expect(store.snapshot(principal).version).toBeGreaterThanOrEqual(1);
  });

  it('cabeçalho do vínculo anterior com operação concluída só é aceito antes de relogin', async () => {
    const { store, runtime, state } = setup();
    const header = (await runtime.accountContext(principal)).sessionRef;
    const op = runtime.accept(principal, event(), await runtime.authorizeSession(principal, header)).operation;
    runtime.tick(); await flush();
    expect(store.operation(principal, op.operationId, header).status).toBe('SUCCEEDED');
    state.linkId = 'link-B';
    const newHeader = (await runtime.accountContext(principal)).sessionRef;
    await expect(runtime.authorizeSession(principal, header)).rejects.toMatchObject({ code: 'LINK_CHANGED' });
    expect(() => store.operation(principal, op.operationId, newHeader)).toThrow();
    const replay = runtime.accept(principal, event(2, 1), await runtime.authorizeSession(principal, newHeader));
    expect(replay.operation.operationId).not.toBe(op.operationId);
  });

  it('sem cabeçalho o fluxo antigo continua e o vínculo não é gravado', async () => {
    const { store, runtime, state } = setup();
    const op = runtime.accept(principal, event()).operation;
    runtime.tick(); await flush();
    expect(store.operation(principal, op.operationId).status).toBe('SUCCEEDED');
    expect(store.snapshot(principal).version).toBe(1);
    state.linkId = 'link-C';
    expect(store.operation(principal, op.operationId)!.status).toBe('SUCCEEDED');
  });

  it('account-context informa referência atual e runtime sem vínculo recusa cabeçalho fail closed', async () => {
    const { store, runtime, state } = setup();
    state.linkId = 'link-A';
    expect(await runtime.accountContext(principal))
      .toMatchObject({ enabled: true, sessionRef: accountSession(principal, 'link-A').ref });
    state.linkId = undefined;
    const off = new TurnRuntime(store, {});
    cleanup.push(() => off.stop());
    await expect(off.authorizeSession(principal, 'qualquer')).rejects.toMatchObject({ code: 'LINK_CHANGED' });
    expect(await off.authorizeSession(principal)).toBeUndefined();
    expect(await off.accountContext(principal)).toMatchObject({ enabled: false });
  });
});
