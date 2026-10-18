// Concorrência determinística: confirmação × desconexão/substituição/cancelamento.
// Um LinkStore "com portão" segura a gravação do vínculo para intercalar operações em ordem conhecida.
import { existsSync, readdirSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IfoodAuth } from '../../src/server/auth';
import { IfoodLinkService } from '../../src/server/links/service';
import { LinkStore, type LinkRecord } from '../../src/server/links/store';
import { ORG_A, authorize, setup } from '../helpers/fakes';

class GatedStore extends LinkStore {
  private gate: { release: () => void; promise: Promise<void> } | null = null;
  reached: Promise<void> = Promise.resolve();
  private signalReached: () => void = () => {};
  /** A próxima gravação fica bloqueada até release(); `reached` resolve quando ela começar. */
  holdNext() {
    let release!: () => void;
    const promise = new Promise<void>((r) => (release = r));
    this.gate = { release, promise };
    this.reached = new Promise<void>((r) => (this.signalReached = r));
    return () => release();
  }
  override async save(links: Record<string, LinkRecord>): Promise<void> {
    const g = this.gate;
    if (g) {
      this.gate = null;
      this.signalReached();
      await g.promise;
    }
    return super.save(links);
  }
}

function gated() {
  const env = setup();
  const store = new GatedStore(env.cfg.linksDir);
  const links = new IfoodLinkService({ cfg: env.cfg, sessionFactory: env.mcp.factory, fetchImpl: env.as.fetch, now: env.clock.now, store });
  return { ...env, links, store };
}

/** Segura a PRÓXIMA gravação de tokens de vínculo (setTokens) — janela entre CONFIRMING e a instalação do vínculo. */
function holdTokenWrite() {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let signal!: () => void;
  const reached = new Promise<void>((r) => (signal = r));
  const orig = IfoodAuth.prototype.setTokens;
  let used = false;
  vi.spyOn(IfoodAuth.prototype, 'setTokens').mockImplementation(async function (this: IfoodAuth, t) {
    if (!used && (this as unknown as { tokenFile: string | null }).tokenFile) {
      used = true;
      signal();
      await gate;
    }
    return orig.call(this, t);
  });
  return { release: () => release(), reached };
}
afterEach(() => vi.restoreAllMocks());

const settle = (p: Promise<unknown>) => p.then(() => 'OK', (e: { code?: string }) => e.code ?? 'ERR');
const tokenFiles = (dir: string) => readdirSync(dir).filter((f) => f.endsWith('.tokens.json'));

describe('janela antes da instalação do vínculo (gravação de tokens)', () => {
  it('disconnect durante a gravação de tokens ⇒ DISCONNECTED, sem tokens, mesmo após reinício', async () => {
    const env = setup();
    const a = await authorize(env, ORG_A);
    const h = holdTokenWrite();
    const confirming = settle(env.links.confirm(ORG_A, a.confirmationId));
    await h.reached;
    const disconnecting = settle(env.links.disconnect(ORG_A));
    h.release();
    await Promise.all([confirming, disconnecting]);
    expect(await env.links.status(ORG_A)).toMatchObject({ state: 'DISCONNECTED', linkId: null, allowedOperations: [] });
    expect(tokenFiles(env.cfg.linksDir)).toEqual([]);
    const restarted = new IfoodLinkService({ cfg: env.cfg, sessionFactory: env.mcp.factory, fetchImpl: env.as.fetch, now: env.clock.now });
    expect((await restarted.status(ORG_A)).state).toBe('DISCONNECTED');
  });

  it('nova tentativa (connect) durante a gravação: ordem serializada, nada é perdido nem ressuscitado', async () => {
    const env = setup();
    const a = await authorize(env, ORG_A);
    const h = holdTokenWrite();
    const confirming = settle(env.links.confirm(ORG_A, a.confirmationId));
    await h.reached;
    const connecting = env.links.connect(ORG_A);
    h.release();
    expect(await confirming).toBe('OK');
    const c = await connecting;
    const s = await env.links.status(ORG_A);
    expect(s.linkId).not.toBeNull();
    expect(s.attempt?.attemptId).toBe(c.attemptId);
    expect(tokenFiles(env.cfg.linksDir)).toHaveLength(1);
  });

  it('confirmação de tentativa já cancelada/substituída nunca instala vínculo', async () => {
    const env = setup();
    const a = await authorize(env, ORG_A);
    await env.links.cancelAttempt(ORG_A);
    expect(await settle(env.links.confirm(ORG_A, a.confirmationId))).toBe('CONFIRMATION_INVALID');
    const b = await authorize(env, ORG_A);
    await env.links.connect(ORG_A); // substitui b
    expect(await settle(env.links.confirm(ORG_A, b.confirmationId))).toBe('CONFIRMATION_INVALID');
    expect((await env.links.status(ORG_A)).linkId).toBeNull();
    expect(tokenFiles(env.cfg.linksDir)).toEqual([]);
  });
});

describe('confirmação concorrente não restaura vínculo', () => {
  it('disconnect durante a confirmação ⇒ estado final DISCONNECTED, sem tokens', async () => {
    const env = gated();
    const a = await authorize(env, ORG_A);
    const release = env.store.holdNext();
    const confirming = settle(env.links.confirm(ORG_A, a.confirmationId));
    await env.store.reached; // confirmação parada no meio
    const disconnecting = settle(env.links.disconnect(ORG_A));
    release();
    await Promise.all([confirming, disconnecting]);
    const s = await env.links.status(ORG_A);
    expect(s).toMatchObject({ state: 'DISCONNECTED', linkId: null, allowedOperations: [] });
    expect(tokenFiles(env.cfg.linksDir)).toEqual([]);
    const restarted = new IfoodLinkService({ cfg: env.cfg, sessionFactory: env.mcp.factory, fetchImpl: env.as.fetch, now: env.clock.now });
    expect((await restarted.status(ORG_A)).state).toBe('DISCONNECTED');
  });

  it('nova tentativa (connect) durante a confirmação não é anulada nem anula o vínculo confirmado', async () => {
    const env = gated();
    const a = await authorize(env, ORG_A);
    const release = env.store.holdNext();
    const confirming = settle(env.links.confirm(ORG_A, a.confirmationId));
    await env.store.reached;
    const connecting = env.links.connect(ORG_A);
    release();
    expect(await confirming).toBe('OK');
    const c = await connecting;
    const s = await env.links.status(ORG_A);
    // A confirmação terminou antes da nova tentativa: vínculo existe e a nova tentativa segue pendente.
    expect(s.linkId).not.toBeNull();
    expect(s.attempt?.attemptId).toBe(c.attemptId);
    expect(tokenFiles(env.cfg.linksDir)).toHaveLength(1);
  });

  it('cancelamento durante a confirmação é serializado (não deixa vínculo órfão)', async () => {
    const env = gated();
    const a = await authorize(env, ORG_A);
    const release = env.store.holdNext();
    const confirming = settle(env.links.confirm(ORG_A, a.confirmationId));
    await env.store.reached;
    const cancelling = env.links.cancelAttempt(ORG_A);
    release();
    expect(await confirming).toBe('OK');
    const r = await cancelling;
    expect(r.cancelled).toBe(false); // nada pendente: a tentativa já tinha virado vínculo
    expect((await env.links.status(ORG_A)).state).toBe('CONNECTED');
    expect(tokenFiles(env.cfg.linksDir)).toHaveLength(1);
  });

  it('disconnect concorrente com confirmação de OUTRA tentativa não deixa arquivo de token órfão', async () => {
    const env = gated();
    const a = await authorize(env, ORG_A);
    await env.links.confirm(ORG_A, a.confirmationId);
    const b = await authorize(env, ORG_A); // reconexão
    const release = env.store.holdNext();
    const confirming = settle(env.links.confirm(ORG_A, b.confirmationId));
    await env.store.reached;
    const disconnecting = settle(env.links.disconnect(ORG_A));
    release();
    await Promise.all([confirming, disconnecting]);
    expect((await env.links.status(ORG_A)).state).toBe('DISCONNECTED');
    expect(tokenFiles(env.cfg.linksDir)).toEqual([]);
    expect(existsSync(env.cfg.linksDir)).toBe(true);
  });
});
