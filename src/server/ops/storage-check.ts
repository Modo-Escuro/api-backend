// OPS-02: verificação de permissões do armazenamento na plataforma em que o processo roda.
// POSIX: confere os bits de modo (sem acesso de grupo/outros). Windows: bits POSIX não representam a ACL NTFS,
// então o resultado é UNVERIFIED_PLATFORM — nunca PRIVATE por omissão. Nenhum caminho sai no resultado.
import { statSync } from 'node:fs';

export type PermissionState = 'PRIVATE' | 'EXPOSED' | 'MISSING' | 'UNVERIFIED_PLATFORM' | 'ERROR';

export interface PermissionCheck {
  state: PermissionState;
  platform: 'POSIX' | 'WINDOWS';
  /** Bits de grupo/outros encontrados (POSIX), em octal; null fora do POSIX. */
  extraBits: string | null;
}

export function checkPrivatePath(path: string, platform: NodeJS.Platform = process.platform): PermissionCheck {
  const kind = platform === 'win32' ? 'WINDOWS' : 'POSIX';
  let mode: number;
  try {
    mode = statSync(path).mode;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    return { state: code === 'ENOENT' ? 'MISSING' : 'ERROR', platform: kind, extraBits: null };
  }
  if (kind === 'WINDOWS') return { state: 'UNVERIFIED_PLATFORM', platform: kind, extraBits: null };
  const extra = mode & 0o077;
  return { state: extra ? 'EXPOSED' : 'PRIVATE', platform: kind, extraBits: extra ? `0${extra.toString(8).padStart(2, '0')}` : null };
}
