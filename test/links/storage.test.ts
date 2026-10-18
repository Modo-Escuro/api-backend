// Regressão: persistência dos tokens de vínculo (diretório ausente, permissões, falhas de gravação com rollback).
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/server/config';
import { IfoodLinkService } from '../../src/server/links/service';
import { LinkStore, type LinkRecord } from '../../src/server/links/store';
import { ORG_A, authorize, connectAndConfirm, setup } from '../helpers/fakes';

// fs.chmod no Windows só representa o bit de escrita; mode não comprova isolamento por ACL.
// As asserções completas 700/600 permanecem obrigatórias em plataformas POSIX.
// https://nodejs.org/api/fs.html#file-modes
function expectPlatformMode(path: string, expected: number) {
  const actual = statSync(path).mode;
  if (process.platform === 'win32') expect(actual & 0o200).toBe(expected & 0o200);
  else expect(actual & 0o777).toBe(expected);
}
const tokenFiles = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.tokens.json')) : []);
afterEach(() => vi.restoreAllMocks());

function freshDir() {
  return join(tmpdir(), `links-missing-${process.pid}-${Math.random().toString(36).slice(2)}`, 'nested', '.ifood-links');
}

describe('diretório de vínculos ausente (bug: ENOENT no confirm)', () => {
  it('confirm cria diretório e arquivos, com os modos privados suportados pela plataforma', async () => {
    const dir = freshDir();
    const env = setup({ linksDir: dir });
    expect(existsSync(dir)).toBe(false);
    const r = await connectAndConfirm(env, ORG_A);
    expect(r.status).toMatchObject({ state: 'CONNECTED', operational: true });
    expectPlatformMode(dir, 0o700);
    const [tok] = tokenFiles(dir);
    expectPlatformMode(join(dir, tok!), 0o600);
    expectPlatformMode(join(dir, 'links.json'), 0o600);
  });

  it('corrige os modos suportados ao reutilizar diretório e regravar tokens', async () => {
    const dir = freshDir();
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    chmodSync(dir, 0o755);
    const env = setup({ linksDir: dir });
    const r = await connectAndConfirm(env, ORG_A);
    expectPlatformMode(dir, 0o700);
    const file = join(dir, `${r.status.linkId}.tokens.json`);
    chmodSync(file, 0o644);
    env.clock.advance(2 * 3600_000); // força refresh ⇒ regrava o arquivo
    await env.links.verify(ORG_A);
    expectPlatformMode(file, 0o600);
  });
});

describe('falha de gravação: rollback e estado recuperável', () => {
  it('diretório impossível de criar ⇒ 503 LINK_STORAGE_FAILED; tentativa continua confirmável com o MESMO confirmationId', async () => {
    const base = join(tmpdir(), `links-blocked-${process.pid}-${Math.random().toString(36).slice(2)}`);
    writeFileSync(base, 'não sou diretório');
    const dir = join(base, '.ifood-links');
    const env = setup({ linksDir: dir });
    const a = await authorize(env, ORG_A);
    const err = await env.links.confirm(ORG_A, a.confirmationId).catch((e) => e);
    expect(err).toMatchObject({ code: 'LINK_STORAGE_FAILED', httpStatus: 503 });
    expect(JSON.stringify(err)).not.toMatch(/at-\d|rt-\d/);
    const s = await env.links.status(ORG_A);
    expect(s).toMatchObject({ state: 'AWAITING_CONFIRMATION', linkId: null, attempt: { status: 'PENDING_CONFIRMATION', confirmationId: a.confirmationId } });
    // Corrige o ambiente e tenta de novo
    rmSync(base);
    const ok = await env.links.confirm(ORG_A, a.confirmationId);
    expect(ok.status).toMatchObject({ state: 'CONNECTED', operational: true });
  });

  it('falha ao salvar links.json depois do token ⇒ token apagado, nada instalado, vínculo anterior intacto', async () => {
    const env = setup();
    const first = await connectAndConfirm(env, ORG_A);
    const b = await authorize(env, ORG_A); // reconexão pendente
    const orig = LinkStore.prototype.save;
    let failed = false;
    vi.spyOn(LinkStore.prototype, 'save').mockImplementation(function (this: LinkStore, links: Record<string, LinkRecord>) {
      if (!failed) {
        failed = true;
        return Promise.reject(Object.assign(new Error('EIO: falha sintética'), { code: 'EIO' }));
      }
      return orig.call(this, links);
    });
    const err = await env.links.confirm(ORG_A, b.confirmationId).catch((e) => e);
    expect(err).toMatchObject({ code: 'LINK_STORAGE_FAILED' });
    // Só o token do vínculo anterior permanece; ele continua operacional
    expect(tokenFiles(env.cfg.linksDir)).toEqual([`${first.status.linkId}.tokens.json`]);
    const s = await env.links.status(ORG_A);
    expect(s).toMatchObject({ linkId: first.status.linkId, attempt: { confirmationId: b.confirmationId, status: 'PENDING_CONFIRMATION' } });
    expect((await env.links.withOperational(ORG_A, 'ADDRESSES_READ', (ctx) => ctx.deps.listAddresses())).results).toHaveLength(1);
    // Reinício: o vínculo persistido é o anterior
    const restarted = new IfoodLinkService({ cfg: env.cfg, sessionFactory: env.mcp.factory, fetchImpl: env.as.fetch, now: env.clock.now });
    expect((await restarted.status(ORG_A)).linkId).toBe(first.status.linkId);
    // Nova tentativa de confirmar funciona
    const ok = await env.links.confirm(ORG_A, b.confirmationId);
    expect(ok.previousLinkId).toBe(first.status.linkId);
    expect(tokenFiles(env.cfg.linksDir)).toEqual([`${ok.status.linkId}.tokens.json`]);
  });

  it('após falha, clique repetido não fica preso em ALREADY_CONFIRMED', async () => {
    const base = join(tmpdir(), `links-blocked2-${process.pid}-${Math.random().toString(36).slice(2)}`);
    writeFileSync(base, 'x');
    const env = setup({ linksDir: join(base, 'd') });
    const a = await authorize(env, ORG_A);
    for (let i = 0; i < 3; i++) {
      expect((await env.links.confirm(ORG_A, a.confirmationId).catch((e) => e)).code).toBe('LINK_STORAGE_FAILED');
    }
  });
});

describe('caminho consistente', () => {
  it('IFOOD_LINKS_DIR relativo é resolvido a partir da raiz do projeto, independentemente do cwd', () => {
    const cwd = process.cwd();
    const a = loadConfig({ IFOOD_LINKS_DIR: '.ifood-links' }).linksDir;
    process.chdir(tmpdir());
    try {
      const b = loadConfig({ IFOOD_LINKS_DIR: '.ifood-links' }).linksDir;
      expect(b).toBe(a);
    } finally {
      process.chdir(cwd);
    }
    expect(a).toBe(join(cwd, '.ifood-links'));
    expect(loadConfig({}).linksDir).toBe(join(cwd, '.ifood-links'));
    expect(loadConfig({ IFOOD_LINKS_DIR: '/tmp/abs-links' }).linksDir).toBe('/tmp/abs-links');
  });
});
