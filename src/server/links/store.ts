// Persistência dos vínculos confirmados (metadados). Tokens ficam em arquivos próprios por vínculo.
// Diretório fora do Git (700), arquivos 600, gravação durável (tmp + fsync + rename + fsync do diretório).
// Tentativas pendentes nunca são persistidas.
//
// Leitura falha FECHADA: só "arquivo inexistente" significa "nenhum vínculo". Arquivo ilegível, corrompido ou em
// formato desconhecido gera LinkStorageError e nada é sobrescrito — perder vínculos em silêncio seria pior.

import { chmod, mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { removeStaleTemps, writeFileDurable } from '../storage/durableFile.js';
import type { AccountIdentity } from './identity.js';

export interface LinkRecord {
  /** Hash interno issuer/client/sub; nunca enviado ao bot/modelo. */
  accountKey?: string;
  linkId: string;
  organizerId: string;
  confirmedAt: number;
  /** Nome do arquivo de tokens dentro do diretório de vínculos. */
  tokenFileName: string;
  /** Preenchido quando a credencial foi comprovadamente rejeitada; persiste entre reinícios. */
  reconnectReason: string | null;
  /** Identidade MASCARADA mostrada e confirmada pelo organizador (null em registros antigos). */
  accountIdentity?: AccountIdentity | null;
}

interface FileShape {
  version: 1;
  links: Record<string, LinkRecord>;
}

export const LINKS_FILE = 'links.json';
/** Nome de arquivo de tokens aceito: sem separadores de caminho (impede apontar para fora do diretório). */
export const TOKEN_FILE_RE = /^[A-Za-z0-9_-]{1,128}\.tokens\.json$/;

export type LinkStorageErrorCode = 'LINKS_FILE_UNREADABLE' | 'LINKS_FILE_CORRUPT' | 'LINKS_FILE_UNSUPPORTED';

/** Erro de leitura do armazenamento. A mensagem nunca contém caminho, conteúdo ou tokens. */
export class LinkStorageError extends Error {
  constructor(
    readonly code: LinkStorageErrorCode,
    readonly causeCode: string | null = null,
  ) {
    super(`Armazenamento de vínculos inválido: ${code}${causeCode ? ` (${causeCode})` : ''}`);
  }
}

/** Valida o conteúdo de links.json. Exportado para os scripts de backup/restauração. */
export function parseLinksFile(text: string): Record<string, LinkRecord> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new LinkStorageError('LINKS_FILE_CORRUPT', 'JSON_INVALID');
  }
  const shape = raw as Partial<FileShape> | null;
  if (!shape || typeof shape !== 'object' || shape.version !== 1) throw new LinkStorageError('LINKS_FILE_UNSUPPORTED', 'VERSION');
  if (!shape.links || typeof shape.links !== 'object' || Array.isArray(shape.links)) throw new LinkStorageError('LINKS_FILE_CORRUPT', 'LINKS_FIELD');
  for (const [organizerId, r] of Object.entries(shape.links)) {
    const ok =
      r &&
      typeof r === 'object' &&
      typeof r.linkId === 'string' &&
      r.linkId.length > 0 &&
      r.organizerId === organizerId &&
      typeof r.confirmedAt === 'number' &&
      typeof r.tokenFileName === 'string' &&
      TOKEN_FILE_RE.test(r.tokenFileName) &&
      (r.accountKey === undefined || (typeof r.accountKey === 'string' && /^[a-f0-9]{64}$/.test(r.accountKey))) &&
      (r.reconnectReason === null || typeof r.reconnectReason === 'string');
    if (!ok) throw new LinkStorageError('LINKS_FILE_CORRUPT', 'RECORD_INVALID');
  }
  return shape.links;
}

export function serializeLinks(links: Record<string, LinkRecord>): string {
  const snapshot: FileShape = { version: 1, links: structuredClone(links) };
  return JSON.stringify(snapshot, null, 2);
}

export interface StorageInspection {
  dirExists: boolean;
  /** Modo POSIX do diretório (null no Windows ou se ausente). */
  dirMode: number | null;
  linksFile: 'MISSING' | 'OK';
  linkCount: number;
  /** Registros cujo arquivo de tokens não existe (o vínculo aparecerá como RECONNECT_REQUIRED). */
  missingTokenFiles: number;
}

export class LinkStore {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(readonly dir: string) {}

  tokenPath(fileName: string): string {
    if (!TOKEN_FILE_RE.test(fileName)) throw new LinkStorageError('LINKS_FILE_CORRUPT', 'TOKEN_FILE_NAME');
    return join(this.dir, fileName);
  }

  /** Cria o diretório (700) se faltar e corrige a permissão se estiver frouxa. Chamar antes de gravar tokens. */
  async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await chmod(this.dir, 0o700);
  }

  /** Remove temporários órfãos de gravações interrompidas. Chamar uma vez, antes da primeira gravação. */
  async cleanupTemps(): Promise<number> {
    return removeStaleTemps(this.dir);
  }

  /** Lê os vínculos. Inexistente ⇒ {}; ilegível/corrompido ⇒ LinkStorageError (nunca {} em silêncio). */
  async load(): Promise<Record<string, LinkRecord>> {
    let text: string;
    try {
      text = await readFile(join(this.dir, LINKS_FILE), 'utf8');
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      // ENOENT/ENOTDIR: o arquivo comprovadamente não existe. Gravações posteriores falham se o caminho for inválido.
      if (code === 'ENOENT' || code === 'ENOTDIR') return {};
      throw new LinkStorageError('LINKS_FILE_UNREADABLE', code ?? null);
    }
    return parseLinksFile(text);
  }

  /** Grava o mapa completo de forma durável; chamadas são serializadas. */
  save(links: Record<string, LinkRecord>): Promise<void> {
    const data = serializeLinks(links);
    const run = async () => {
      await this.ensureDir();
      await writeFileDurable(join(this.dir, LINKS_FILE), data, 0o600);
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
  }

  /** Diagnóstico sem identidades nem caminhos. Propaga LinkStorageError se links.json for inválido. */
  async inspect(): Promise<StorageInspection> {
    let dirMode: number | null = null;
    let dirExists = false;
    try {
      const s = await stat(this.dir);
      dirExists = s.isDirectory();
      if (process.platform !== 'win32') dirMode = s.mode & 0o777;
    } catch {
      /* ausente */
    }
    let linksFile: StorageInspection['linksFile'] = 'MISSING';
    let records: Record<string, LinkRecord> = {};
    try {
      await stat(join(this.dir, LINKS_FILE));
      linksFile = 'OK';
      records = await this.load();
    } catch (e) {
      if (e instanceof LinkStorageError) throw e;
    }
    let missingTokenFiles = 0;
    for (const r of Object.values(records)) {
      try {
        await stat(this.tokenPath(r.tokenFileName));
      } catch {
        missingTokenFiles++;
      }
    }
    return { dirExists, dirMode, linksFile, linkCount: Object.keys(records).length, missingTokenFiles };
  }
}
