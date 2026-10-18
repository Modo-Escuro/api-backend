import { describe, expect, it, vi } from 'vitest';
import { validSimulationApproval, type ReviewBinding, type FutureHumanApproval } from '../../src/server/cart/approval';

const review: ReviewBinding = { organizerId: '111', linkId: 'link-a', reviewId: 'review-a', revision: 3,
  fingerprint: 'snapshot-a', totalCents: 2600, expiresAt: 5000 };
const approved: FutureHumanApproval = { ...review, source: 'TELEGRAM_CALLBACK', callbackId: 'update-validado-1', approvedAt: 1000 };

describe('F7.3 — submitOrder apenas no MCP falso, sem transporte real', () => {
  it('simula submissão única só com aprovação humana correspondente à revisão', async () => {
    const mcp = { submitOrder: vi.fn().mockResolvedValue({ orderId: 'pedido-sintético' }) };
    if (validSimulationApproval(review, approved, 1500)) await mcp.submitOrder({ cartId: 'carrinho-sintético', userConsent: true });
    expect(mcp.submitOrder).toHaveBeenCalledExactlyOnceWith({ cartId: 'carrinho-sintético', userConsent: true });
  });
  it.each([
    null, { ...approved, organizerId: 'outro' }, { ...approved, linkId: 'outra-conta' },
    { ...approved, revision: 2 }, { ...approved, fingerprint: 'outro-total-ou-configuração' },
    { ...approved, totalCents: 2599 }, { ...approved, reviewId: 'outra-revisão' },
    { ...approved, callbackId: '' }, { ...approved, source: 'LLM' }, { ...approved, approvedAt: 6000 },
  ])('não simula compra com evidência ausente ou obsoleta: %j', (approval) => {
    const submitOrder = vi.fn();
    if (validSimulationApproval(review, approval as FutureHumanApproval | null, 1500)) submitOrder();
    expect(submitOrder).not.toHaveBeenCalled();
  });
  it('revisão expirada não autoriza a simulação', () => {
    expect(validSimulationApproval(review, approved, 5000)).toBe(false);
  });
});
