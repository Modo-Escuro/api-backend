import { z } from 'zod';
import { DomainError, type DomainChange, type DomainOp, type PurchaseState } from '../domain/purchase.js';
import { formatCents } from '../domain/money.js';

const cents = z.number().int().min(0).max(10_000_000);
export const ControlSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('SET_LIMIT'), amountCents: cents, kind: z.enum(['MANDATORY', 'PREFERENCE']).optional() }).strict(),
  z.object({ action: z.literal('SET_NO_LIMIT') }).strict(),
  z.object({ action: z.literal('SET_PRIORITY'), value: z.enum(['ECONOMY', 'SPEED']) }).strict(),
  z.object({ action: z.literal('REQUEST_REVIEW') }).strict(),
]);
export type Control = z.infer<typeof ControlSchema>;

/** Continuidade #56: só resolve a pergunta canônica persistida do teto coletivo, nunca outra pessoa. */
export function resolveLimitReply(state: PurchaseState | null, message: string): DomainOp | null {
  const pending = state?.clarifications.filter(c => c.target === 'GROUP' && c.field === 'LIMIT') ?? [];
  if (pending.length !== 1) return null;
  const value = /^R\$ ([0-9]+)\.([0-9]{2}) é um teto máximo ou uma referência\?$/u.exec(pending[0]!.question);
  if (!value) return null;
  const reply = message.normalize('NFD').replace(/\p{M}/gu, '').trim().toLowerCase().replace(/[.!?]$/, '');
  const kind = /^(?:e (?:um |o )?)?(?:valor maximo|teto maximo|maximo|limite maximo)$/u.test(reply) ? 'MANDATORY'
    : /^(?:(?:e )?uma )?(?:referencia|preferencia|valor de referencia)$/u.test(reply) ? 'PREFERENCE' : null;
  const amountCents = Number(BigInt(value[1]!) * 100n + BigInt(value[2]!));
  return kind && cents.safeParse(amountCents).success ? { op: 'SET_LIMIT', target: 'GROUP', value: { amountCents, kind } } : null;
}
export function planControls(actions: readonly Control[], message: string, preview: (change: DomainChange) => PurchaseState | null) {
  const ops: DomainOp[] = [], notes: string[] = [];
  let state = preview({ ops: [] });
  for (const action of actions) {
    let op: DomainOp;
    if (action.action === 'REQUEST_REVIEW') { notes.push('Use Revisar carrinho para conferir a composição e confirmar sua preparação.'); continue; }
    if (action.action === 'SET_PRIORITY') op = { op: 'SET_PRIORITY', value: action.value };
    else if (action.action === 'SET_NO_LIMIT') {
      const folded = message.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
      if (!/\bsem (?:teto|limite|orcamento)\b|\bqualquer valor\b/.test(folded)) { notes.push('Confirme explicitamente se deseja retirar o teto de gastos.'); continue; }
      op = { op: 'SET_LIMIT', target: 'GROUP', value: 'NONE' };
    } else if (!action.kind) {
      op = { op: 'MARK_UNCLEAR', target: 'GROUP', field: 'LIMIT', question: `${formatCents(action.amountCents)} é um teto máximo ou uma referência?` };
      notes.push(op.question);
    }
    else op = { op: 'SET_LIMIT', target: 'GROUP', value: { amountCents: action.amountCents, kind: action.kind } };
    try { state = preview({ ops: [...ops, op] }); ops.push(op); }
    catch (error) { if (!(error instanceof DomainError)) throw error; notes.push('O limite obrigatório existente foi preservado. Essa mudança exige confirmação específica.'); }
  }
  return { ops, notes, state };
}
