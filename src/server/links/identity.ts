// Identidade da conta iFood para a confirmação consciente do vínculo (F3.5).
// Fonte: getUser (includeProfileData=false), contrato observado: { success, data: { fullName, email, phone } }.
// Só sai do backend uma versão MASCARADA de nome e e-mail; telefone nunca. Nada é inventado.

export interface AccountIdentity {
  /** VERIFIED: getUser respondeu com nome/e-mail; NOT_PROVIDED: respondeu sem esses campos; UNAVAILABLE: falhou. */
  status: 'VERIFIED' | 'NOT_PROVIDED' | 'UNAVAILABLE';
  displayName: string | null;
  emailMasked: string | null;
  source: 'getUser';
}

/** "Maria Clara Souza" → "Maria S." */
export function maskName(full: string): string | null {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return null;
  const first = parts[0]!;
  return parts.length > 1 ? `${first} ${parts.at(-1)![0]!.toUpperCase()}.` : first;
}

/** "maria.souza@gmail.com" → "m***@gmail.com" */
export function maskEmail(email: string): string | null {
  const m = /^([^@\s]+)@([^@\s]+\.[^@\s]+)$/.exec(email.trim());
  if (!m) return null;
  return `${m[1]![0]}***@${m[2]!.toLowerCase()}`;
}

export function identityFromGetUser(payload: unknown): AccountIdentity {
  const data = (payload as { data?: unknown } | null)?.data;
  const d = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  const displayName = typeof d.fullName === 'string' ? maskName(d.fullName) : null;
  const emailMasked = typeof d.email === 'string' ? maskEmail(d.email) : null;
  return { status: displayName || emailMasked ? 'VERIFIED' : 'NOT_PROVIDED', displayName, emailMasked, source: 'getUser' };
}

export const UNAVAILABLE_IDENTITY: AccountIdentity = { status: 'UNAVAILABLE', displayName: null, emailMasked: null, source: 'getUser' };
