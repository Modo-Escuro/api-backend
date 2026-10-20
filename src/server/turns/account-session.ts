import { createHash } from 'node:crypto';
import type { AdapterPrincipal } from '../contracts/guards.js';

export interface AccountSession { ref: string; linkId: string | null }
/** Referência técnica do vínculo atual da conta (bot+organizador), por relogin muda; não é userId iFood nem entra no contexto do modelo. */
export function accountSession(p: AdapterPrincipal, linkId: string | null): AccountSession {
  return { linkId, ref: createHash('sha256').update(JSON.stringify(['ACCOUNT_SESSION_V1', p.botId, p.organizerId, linkId])).digest('hex') };
}
