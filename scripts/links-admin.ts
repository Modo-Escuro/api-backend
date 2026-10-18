// Operação do diretório de vínculos (OPS-01): verificar, fazer backup e restaurar.
// Uso:
//   npm run links -- verify [--dir <dir>]
//   npm run links -- backup --out <dir-novo> [--dir <dir>]
//   npm run links -- verify-backup --from <backup>
//   npm run links -- restore --from <backup> [--to <dir-vazio>]
// <dir> padrão = IFOOD_LINKS_DIR resolvido pela configuração da API (inclui o volume da Railway).
// A saída tem só contagens e códigos: nunca tokens, identidades ou IDs de organizador.

import { resolve } from 'node:path';
import { loadConfig } from '../src/server/config.js';
import { backupLinks, inspectLinksDir, LinksAdminError, restoreLinks, verifyBackup } from '../src/server/links/backup.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<number> {
  const cmd = process.argv[2];
  const cfg = loadConfig();
  const dir = resolve(arg('--dir') ?? cfg.linksDir);
  const out = (o: Record<string, unknown>) => console.log(JSON.stringify(o, null, 2));

  switch (cmd) {
    case 'verify': {
      const r = await inspectLinksDir(dir);
      const ok = r.missingTokenFiles === 0 && r.looseFileModes === 0 && (r.dirMode === null || r.dirMode === 0o700);
      out({ ok, durability: cfg.linksStorage.durability, ...r, dirMode: r.dirMode === null ? null : r.dirMode.toString(8) });
      return ok ? 0 : 1;
    }
    case 'backup': {
      const target = arg('--out');
      if (!target) throw new LinksAdminError('MISSING_--out');
      out({ ok: true, ...(await backupLinks(dir, resolve(target))) });
      return 0;
    }
    case 'verify-backup': {
      const from = arg('--from');
      if (!from) throw new LinksAdminError('MISSING_--from');
      out({ ok: true, ...(await verifyBackup(resolve(from))) });
      return 0;
    }
    case 'restore': {
      const from = arg('--from');
      if (!from) throw new LinksAdminError('MISSING_--from');
      const to = resolve(arg('--to') ?? dir);
      out({ ok: true, ...(await restoreLinks(resolve(from), to)) });
      return 0;
    }
    default:
      console.error('Comandos: verify | backup --out <dir> | verify-backup --from <dir> | restore --from <dir> [--to <dir>]');
      return 2;
  }
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    const code = e instanceof LinksAdminError ? e.code : ((e as NodeJS.ErrnoException)?.code ?? 'ERRO');
    console.error(JSON.stringify({ ok: false, error: code }));
    process.exit(1);
  },
);
