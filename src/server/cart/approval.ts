// Política pura para testes de F7.3. Não emite aprovação, não é chamada por rotas e não envia pedidos.
// Evidência humana futura deve vir do adaptador Telegram autenticado, nunca de texto/LLM.
export interface ReviewBinding {
  organizerId: string;
  linkId: string;
  reviewId: string;
  revision: number;
  fingerprint: string;
  totalCents: number;
  expiresAt: number;
}
export interface FutureHumanApproval extends ReviewBinding {
  source: 'TELEGRAM_CALLBACK';
  callbackId: string;
  approvedAt: number;
}
export function validSimulationApproval(review: ReviewBinding, approval: FutureHumanApproval | null, now: number): boolean {
  if (!approval || approval.source !== 'TELEGRAM_CALLBACK' || !approval.callbackId ||
    !Number.isSafeInteger(review.totalCents) || review.totalCents < 0 || review.expiresAt <= now ||
    approval.approvedAt > now || approval.approvedAt >= review.expiresAt) return false;
  return (Object.keys(review) as (keyof ReviewBinding)[]).every((key) => review[key] === approval[key]);
}
