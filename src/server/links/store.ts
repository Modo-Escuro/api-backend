// Persistência local dos vínculos confirmados (metadados). Tokens ficam em arquivos próprios por vínculo.
// Diretório fora do Git; escrita atômica (tmp + rename), modo 600. Tentativas pendentes nunca são persistidas.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AccountIdentity } from './identity.js';

export interface LinkRecord {
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

export class LinkStore {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(readonly dir: string) {}

  tokenPath(fileName: string): string {
    return join(this.dir, fileName);
  }

  async load(): Promise<Record<string, LinkRecord>> {
    try {
      const raw = JSON.parse(await readFile(join(this.dir, 'links.json'), 'utf8')) as FileShape;
      return raw.version === 1 && raw.links ? raw.links : {};
    } catch {
      return {};
    }
  }

  /** Grava o mapa completo; chamadas são serializadas. */
  save(links: Record<string, LinkRecord>): Promise<void> {
    const snapshot: FileShape = { version: 1, links: structuredClone(links) };
    const run = async () => {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      const tmp = join(this.dir, `links.json.${process.pid}.tmp`);
      await writeFile(tmp, JSON.stringify(snapshot, null, 2), { mode: 0o600 });
      await rename(tmp, join(this.dir, 'links.json'));
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
  }
}
