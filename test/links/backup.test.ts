// OPS-01: backup consistente, verificação e restauração do diretório de vínculos.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { backupLinks, inspectLinksDir, restoreLinks, verifyBackup } from '../../src/server/links/backup';
import { IfoodLinkService } from '../../src/server/links/service';
import { ORG_A, ORG_B, connectAndConfirm, setup } from '../helpers/fakes';

const fresh = (p: string) => join(mkdtempSync(join(tmpdir(), `${p}-`)), 'd');
const POSIX = process.platform !== 'win32';

async function twoLinks() {
  const env = setup();
  const a = await connectAndConfirm(env, ORG_A);
  const b = await connectAndConfirm(env, ORG_B);
  return { env, a, b };
}

describe('backup e restauração', () => {
  it('backup → verificação → restauração num diretório novo → API recupera os mesmos vínculos', async () => {
    const { env, a, b } = await twoLinks();
    const bak = fresh('bak');
    expect(await backupLinks(env.cfg.linksDir, bak)).toEqual({ linkCount: 2, fileCount: 3, missingTokenFiles: 0 });
    expect(await verifyBackup(bak)).toEqual({ linkCount: 2, fileCount: 3 });

    const target = fresh('restored');
    await restoreLinks(bak, target);
    if (POSIX) {
      expect(statSync(target).mode & 0o777).toBe(0o700);
      for (const f of readdirSync(target)) expect(statSync(join(target, f)).mode & 0o777).toBe(0o600);
    }
    expect(await inspectLinksDir(target)).toMatchObject({ linkCount: 2, missingTokenFiles: 0, looseFileModes: 0 });

    const cfg = { ...env.cfg, linksDir: target };
    const svc = new IfoodLinkService({ cfg, sessionFactory: env.mcp.factory, fetchImpl: env.as.fetch, now: env.clock.now });
    expect((await svc.status(ORG_A)).linkId).toBe(a.status.linkId);
    expect((await svc.status(ORG_B)).linkId).toBe(b.status.linkId);
    expect(await svc.verify(ORG_A)).toMatchObject({ operational: true });
  });

  it('manifesto tem só nomes, hashes e tamanhos — nenhum token nem ID de organizador', async () => {
    const { env } = await twoLinks();
    const bak = fresh('bak');
    await backupLinks(env.cfg.linksDir, bak);
    const manifest = readFileSync(join(bak, 'MANIFEST.json'), 'utf8');
    expect(manifest).not.toMatch(/at-\d|rt-\d/);
    expect(manifest).not.toContain(ORG_A);
  });

  it('restauração nunca sobrescreve: destino com arquivos ⇒ TARGET_NOT_EMPTY, nada alterado', async () => {
    const { env } = await twoLinks();
    const bak = fresh('bak');
    await backupLinks(env.cfg.linksDir, bak);
    const before = readFileSync(join(env.cfg.linksDir, 'links.json'), 'utf8');
    await expect(restoreLinks(bak, env.cfg.linksDir)).rejects.toMatchObject({ code: 'TARGET_NOT_EMPTY' });
    expect(readFileSync(join(env.cfg.linksDir, 'links.json'), 'utf8')).toBe(before);
  });

  it('backup adulterado ou incompleto é recusado antes de restaurar', async () => {
    const { env, a } = await twoLinks();
    const bak = fresh('bak');
    await backupLinks(env.cfg.linksDir, bak);
    writeFileSync(join(bak, `${a.status.linkId}.tokens.json`), '{"accessToken":"outro"}');
    await expect(verifyBackup(bak)).rejects.toMatchObject({ code: 'BACKUP_FILE_MISMATCH' });
    const target = fresh('restored');
    await expect(restoreLinks(bak, target)).rejects.toMatchObject({ code: 'BACKUP_FILE_MISMATCH' });
  });

  it('backup recusa destino não vazio e origem sem links.json', async () => {
    const { env } = await twoLinks();
    const used = fresh('used');
    mkdirSync(used, { recursive: true });
    writeFileSync(join(used, 'x'), '1');
    await expect(backupLinks(env.cfg.linksDir, used)).rejects.toMatchObject({ code: 'TARGET_NOT_EMPTY' });
    const empty = mkdtempSync(join(tmpdir(), 'empty-'));
    await expect(backupLinks(empty, fresh('bak'))).rejects.toMatchObject({ code: 'SOURCE_EMPTY' });
  });

  it('origem mudando durante toda a cópia ⇒ SOURCE_CHANGING (não grava backup inconsistente)', async () => {
    const { env, a } = await twoLinks();
    const tok = join(env.cfg.linksDir, `${a.status.linkId}.tokens.json`);
    let n = 0;
    const timer = setInterval(() => writeFileSync(tok, JSON.stringify({ accessToken: `x${n++}` })), 0);
    try {
      // Com o arquivo mudando sem parar, alguma tentativa pode coincidir; o importante é nunca gravar algo divergente.
      const bak = fresh('bak');
      const r = await backupLinks(env.cfg.linksDir, bak, { attempts: 2 }).catch((e) => e);
      if (r instanceof Error) expect(r).toMatchObject({ code: 'SOURCE_CHANGING' });
      else expect(await verifyBackup(bak)).toMatchObject({ linkCount: 2 });
    } finally {
      clearInterval(timer);
    }
  });

  it('verificação aponta token ausente e permissão frouxa', async () => {
    const { env, a } = await twoLinks();
    const { rmSync, chmodSync } = await import('node:fs');
    rmSync(join(env.cfg.linksDir, `${a.status.linkId}.tokens.json`));
    if (POSIX) chmodSync(join(env.cfg.linksDir, 'links.json'), 0o644);
    expect(await inspectLinksDir(env.cfg.linksDir)).toMatchObject({ linkCount: 2, missingTokenFiles: 1, looseFileModes: POSIX ? 1 : 0 });
  });
});
