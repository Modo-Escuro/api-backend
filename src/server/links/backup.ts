// Backup, restauração e verificação do diretório de vínculos (OPS-01).
// Saídas e erros nunca contêm tokens, identidades, IDs de organizador ou conteúdo de arquivos — só contagens e códigos.

import { createHash } from 'node:crypto';
import { chmod, mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileDurable } from '../storage/durableFile.js';
import { LINKS_FILE, LinkStorageError, parseLinksFile, TOKEN_FILE_RE, type LinkRecord } from './store.js';

export const MANIFEST_FILE = 'MANIFEST.json';

interface ManifestEntry {
  name: string;
  sha256: string;
  bytes: number;
}
interface Manifest {
  format: 'ifood-links-backup';
  version: 1;
  createdAt: string;
  linkCount: number;
  files: ManifestEntry[];
}

export class LinksAdminError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

async function readIfExists(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new LinksAdminError(`READ_FAILED_${(e as NodeJS.ErrnoException).code ?? 'ERRO'}`);
  }
}

async function isEmptyOrMissing(dir: string): Promise<boolean> {
  try {
    return (await readdir(dir)).length === 0;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw new LinksAdminError(`TARGET_UNREADABLE_${(e as NodeJS.ErrnoException).code ?? 'ERRO'}`);
  }
}

/** Lê links.json + tokens referenciados. Tokens ausentes são reportados, não inventados. */
async function snapshot(dir: string): Promise<{ files: Map<string, Buffer>; records: Record<string, LinkRecord>; missingTokenFiles: number }> {
  const files = new Map<string, Buffer>();
  const linksBuf = await readIfExists(join(dir, LINKS_FILE));
  if (!linksBuf) return { files, records: {}, missingTokenFiles: 0 };
  const records = parseLinksFile(linksBuf.toString('utf8'));
  files.set(LINKS_FILE, linksBuf);
  let missingTokenFiles = 0;
  for (const r of Object.values(records)) {
    const tok = await readIfExists(join(dir, r.tokenFileName));
    if (tok) files.set(r.tokenFileName, tok);
    else missingTokenFiles++;
  }
  return { files, records, missingTokenFiles };
}

const sameSnapshot = (a: Map<string, Buffer>, b: Map<string, Buffer>) =>
  a.size === b.size && [...a].every(([k, v]) => b.get(k)?.equals(v) === true);

export interface BackupResult {
  linkCount: number;
  fileCount: number;
  missingTokenFiles: number;
}

/**
 * Copia o estado de forma consistente: lê tudo, relê e compara; se a API gravou no meio (ex.: refresh), repete.
 * O destino precisa estar vazio ou não existir — backup nunca sobrescreve outro backup.
 */
export async function backupLinks(sourceDir: string, outDir: string, opts: { attempts?: number; now?: () => Date } = {}): Promise<BackupResult> {
  if (!(await isEmptyOrMissing(outDir))) throw new LinksAdminError('TARGET_NOT_EMPTY');
  let snap: Awaited<ReturnType<typeof snapshot>> | null = null;
  for (let i = 0; i < (opts.attempts ?? 5); i++) {
    const first = await snapshot(sourceDir);
    const second = await snapshot(sourceDir);
    if (sameSnapshot(first.files, second.files)) {
      snap = second;
      break;
    }
  }
  if (!snap) throw new LinksAdminError('SOURCE_CHANGING');
  if (!snap.files.has(LINKS_FILE)) throw new LinksAdminError('SOURCE_EMPTY');

  await mkdir(outDir, { recursive: true, mode: 0o700 });
  await chmod(outDir, 0o700);
  const entries: ManifestEntry[] = [];
  // Tokens primeiro, links.json por último: um backup interrompido não aponta para tokens que não existem.
  const names = [...snap.files.keys()].sort((a, b) => (a === LINKS_FILE ? 1 : b === LINKS_FILE ? -1 : a.localeCompare(b)));
  for (const name of names) {
    const buf = snap.files.get(name)!;
    await writeFileDurable(join(outDir, name), buf, 0o600);
    entries.push({ name, sha256: sha256(buf), bytes: buf.length });
  }
  const manifest: Manifest = {
    format: 'ifood-links-backup',
    version: 1,
    createdAt: (opts.now?.() ?? new Date()).toISOString(),
    linkCount: Object.keys(snap.records).length,
    files: entries,
  };
  await writeFileDurable(join(outDir, MANIFEST_FILE), JSON.stringify(manifest, null, 2), 0o600);
  return { linkCount: manifest.linkCount, fileCount: entries.length, missingTokenFiles: snap.missingTokenFiles };
}

/** Confere um backup contra o manifesto (hash e tamanho de cada arquivo) e a validade de links.json. */
export async function verifyBackup(backupDir: string): Promise<{ linkCount: number; fileCount: number }> {
  const mBuf = await readIfExists(join(backupDir, MANIFEST_FILE));
  if (!mBuf) throw new LinksAdminError('MANIFEST_MISSING');
  let m: Manifest;
  try {
    m = JSON.parse(mBuf.toString('utf8')) as Manifest;
  } catch {
    throw new LinksAdminError('MANIFEST_CORRUPT');
  }
  if (m.format !== 'ifood-links-backup' || m.version !== 1 || !Array.isArray(m.files)) throw new LinksAdminError('MANIFEST_UNSUPPORTED');
  for (const f of m.files) {
    if (f.name !== LINKS_FILE && !TOKEN_FILE_RE.test(f.name)) throw new LinksAdminError('MANIFEST_BAD_NAME');
    const buf = await readIfExists(join(backupDir, f.name));
    if (!buf || buf.length !== f.bytes || sha256(buf) !== f.sha256) throw new LinksAdminError('BACKUP_FILE_MISMATCH');
  }
  const linksEntry = m.files.find((f) => f.name === LINKS_FILE);
  if (!linksEntry) throw new LinksAdminError('BACKUP_WITHOUT_LINKS');
  try {
    const records = parseLinksFile((await readFile(join(backupDir, LINKS_FILE))).toString('utf8'));
    if (Object.keys(records).length !== m.linkCount) throw new LinksAdminError('BACKUP_COUNT_MISMATCH');
    return { linkCount: m.linkCount, fileCount: m.files.length };
  } catch (e) {
    if (e instanceof LinkStorageError) throw new LinksAdminError(e.code);
    throw e;
  }
}

/**
 * Restaura um backup verificado num diretório vazio ou inexistente (700/600, gravação durável).
 * Nunca sobrescreve vínculos existentes: para substituir, mova o diretório atual antes, manualmente.
 */
export async function restoreLinks(backupDir: string, targetDir: string): Promise<{ linkCount: number; fileCount: number }> {
  const v = await verifyBackup(backupDir);
  if (!(await isEmptyOrMissing(targetDir))) throw new LinksAdminError('TARGET_NOT_EMPTY');
  const m = JSON.parse((await readFile(join(backupDir, MANIFEST_FILE))).toString('utf8')) as Manifest;
  await mkdir(targetDir, { recursive: true, mode: 0o700 });
  await chmod(targetDir, 0o700);
  const names = m.files.map((f) => f.name).sort((a, b) => (a === LINKS_FILE ? 1 : b === LINKS_FILE ? -1 : a.localeCompare(b)));
  for (const name of names) {
    const buf = await readFile(join(backupDir, name));
    await writeFileDurable(join(targetDir, name), buf, 0o600);
  }
  const after = await inspectLinksDir(targetDir);
  if (after.linkCount !== v.linkCount || after.missingTokenFiles !== 0) throw new LinksAdminError('RESTORE_VERIFY_FAILED');
  return v;
}

export interface DirInspection {
  dirMode: number | null;
  linkCount: number;
  missingTokenFiles: number;
  looseFileModes: number;
}

/** Verifica um diretório de vínculos em uso: formato, tokens referenciados e permissões. */
export async function inspectLinksDir(dir: string): Promise<DirInspection> {
  let dirMode: number | null = null;
  try {
    const s = await stat(dir);
    if (!s.isDirectory()) throw new LinksAdminError('NOT_A_DIRECTORY');
    if (process.platform !== 'win32') dirMode = s.mode & 0o777;
  } catch (e) {
    if (e instanceof LinksAdminError) throw e;
    throw new LinksAdminError('DIR_MISSING');
  }
  let snap: Awaited<ReturnType<typeof snapshot>>;
  try {
    snap = await snapshot(dir);
  } catch (e) {
    if (e instanceof LinkStorageError) throw new LinksAdminError(e.code);
    throw e;
  }
  let looseFileModes = 0;
  if (process.platform !== 'win32') {
    for (const name of snap.files.keys()) {
      if (((await stat(join(dir, name))).mode & 0o077) !== 0) looseFileModes++;
    }
  }
  return { dirMode, linkCount: Object.keys(snap.records).length, missingTokenFiles: snap.missingTokenFiles, looseFileModes };
}
