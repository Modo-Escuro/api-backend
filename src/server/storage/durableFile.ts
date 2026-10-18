// Gravação durável de arquivos pequenos (metadados de vínculo, tokens).
// Ordem: tmp exclusivo → write → chmod → fsync(arquivo) → rename atômico → fsync(diretório).
// Uma queda em qualquer ponto deixa o arquivo anterior OU o novo inteiro, nunca um arquivo truncado.

import { randomBytes } from 'node:crypto';
import { open, readdir, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/** Prefixo/sufixo dos temporários; nunca são autoritativos e podem ser apagados na inicialização. */
const TMP_RE = /^\..+\.[0-9a-f]{12}\.tmp$/;
/** Temporário do formato anterior (`links.json.<pid>.tmp`). */
const LEGACY_TMP_RE = /^links\.json\.\d+\.tmp$/;

export async function writeFileDurable(path: string, data: string | Uint8Array, mode = 0o600): Promise<void> {
  const dir = dirname(path);
  const tmp = join(dir, `.${basename(path)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  let fh: Awaited<ReturnType<typeof open>> | undefined;
  try {
    fh = await open(tmp, 'wx', mode);
    await fh.writeFile(data);
    await fh.chmod(mode); // umask pode ter afrouxado o modo de criação
    await fh.sync();
    await fh.close();
    fh = undefined;
    await rename(tmp, path);
  } catch (e) {
    await fh?.close().catch(() => undefined);
    await rm(tmp, { force: true }).catch(() => undefined);
    throw e;
  }
  await syncDir(dir);
}

/**
 * fsync do diretório para tornar o rename durável. Depois do rename o conteúdo novo já está no lugar,
 * então uma falha aqui não desfaz a gravação: é registrada (só o código) e não propagada.
 */
export async function syncDir(dir: string): Promise<void> {
  if (process.platform === 'win32') return; // diretórios não aceitam fsync no Windows
  try {
    const d = await open(dir, 'r');
    try {
      await d.sync();
    } finally {
      await d.close();
    }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== 'EINVAL' && code !== 'EISDIR' && code !== 'EPERM' && code !== 'EBADF') {
      console.error('[storage] fsync do diretório falhou:', code ?? 'erro');
    }
  }
}

/** Apaga temporários órfãos de gravações interrompidas. Chamar só antes de qualquer gravação do processo. */
export async function removeStaleTemps(dir: string): Promise<number> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return 0;
  }
  const stale = names.filter((n) => TMP_RE.test(n) || LEGACY_TMP_RE.test(n));
  await Promise.all(stale.map((n) => rm(join(dir, n), { force: true }).catch(() => undefined)));
  return stale.length;
}
