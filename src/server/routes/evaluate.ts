// POST /api/evaluate — avaliação read-only (ranking dos elegíveis, sem carrinho).
// Contrato do bot e domínio em centavos inteiros; BRL apenas na fronteira MCP.

import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { ALLERGENS, DIETARY } from '../domain/constraints.js';
import { PRIORITIES } from '../domain/ranking.js';
import { SORTS } from '../mcp/types.js';
import { EvaluateInputError, type EvaluateOutcome, type EvaluateRequest } from '../services/evaluate.js';
import { evaluateView } from '../services/evaluate-view.js';
import { evaluateViewCents } from '../services/cents.js';

/** Centavos inteiros (≤ R$ 10.000,00). */
const cents = z.number().int().positive().max(1_000_000);

/** Texto curto de preferência (nunca vira restrição obrigatória). */
const prefText = z.string().trim().min(1).max(40);

export const EvaluateBody = z
  .object({
    query: z.string().trim().min(1).max(80),
    // Formato não verificado em resposta real: só exige texto; a existência é checada contra listAddresses.
    addressId: z.string().min(1).max(100).optional(),
    userLocation: z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) }).strict().optional(),
    restrictions: z
      .array(
        z.discriminatedUnion('kind', [
          z.object({ kind: z.literal('DIETARY'), code: z.enum(DIETARY), requirement: z.enum(['MANDATORY', 'PREFERENCE']).optional() }).strict(),
          // Alergia é sempre obrigatória: PREFERENCE é rejeitado na validação.
          z.object({ kind: z.literal('ALLERGY'), code: z.enum(ALLERGENS), requirement: z.literal('MANDATORY').optional() }).strict(),
        ]),
      )
      .max(15)
      .default([]),
    budget: z.object({ maxItemPriceCents: cents.optional(), maxOrderTotalCents: cents.optional() }).strict().optional(),
    quantity: z.number().int().min(1).max(20).optional(),
    merchantType: z.enum(['RESTAURANT', 'GROCERIES', 'LIQUORSTORE', 'DRUGSTORE', 'PETSTORE', 'SHOPPING']).optional(),
    refinements: z
      .object({
        maxDistanceKm: z.number().positive().max(100).optional(),
        maxDeliveryTimeMinutes: z.number().int().positive().max(300).optional(),
        maxDeliveryFeeCents: z.number().int().min(0).max(100_000).optional(),
        minRating: z.number().min(0).max(5).optional(),
        onlyWithPromotion: z.boolean().optional(),
        sort: z.enum(SORTS).optional(),
      })
      .strict()
      .optional(),
    // Preferências: alteram só a pontuação do ranking — nunca a elegibilidade (restrições são `restrictions`).
    preferences: z
      .object({
        foodTypes: z.array(prefText).max(10).optional(),
        likedIngredients: z.array(prefText).max(20).optional(),
        avoidedIngredients: z.array(prefText).max(20).optional(),
        occasion: z.string().trim().min(1).max(60).optional(),
        priority: z.enum(PRIORITIES).optional(),
      })
      .strict()
      .optional(),
    // Alvos flexíveis são avaliados localmente; nunca filtram a busca.
    softLimits: z.object({
      maxDistanceKm: z.number().positive().max(100).optional(),
      maxDeliveryTimeMinutes: z.number().int().positive().max(300).optional(),
      maxDeliveryFeeCents: z.number().int().min(0).max(100_000).optional(),
      minRating: z.number().min(0).max(5).optional(),
      onlyWithPromotion: z.boolean().optional(),
    }).strict().optional(),
    limits: z
      .object({
        maxPages: z.number().int().min(1).max(3).optional(),
        pageSize: z.number().int().min(1).max(25).optional(),
        maxCandidates: z.number().int().min(1).max(60).optional(),
        maxDetails: z.number().int().min(0).max(20).optional(),
        concurrency: z.number().int().min(1).max(6).optional(),
        deadlineMs: z.number().int().min(2_000).max(45_000).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((b) => !(b.addressId && b.userLocation), { message: 'Informe addressId OU userLocation, não ambos' });

type Body = z.infer<typeof EvaluateBody>;

/** Preserva centavos no domínio; só renomeia campos do contrato HTTP. */
export function toDomainRequest(b: Body): EvaluateRequest {
  const { budget, refinements, softLimits, ...rest } = b;
  const req: EvaluateRequest = { ...(rest as Omit<EvaluateRequest, 'budget' | 'refinements'>) };
  if (budget) {
    req.budget = {};
    if (budget.maxItemPriceCents !== undefined) req.budget.maxItemPrice = budget.maxItemPriceCents;
    if (budget.maxOrderTotalCents !== undefined) req.budget.maxOrderTotal = budget.maxOrderTotalCents;
  }
  if (refinements) {
    const { maxDeliveryFeeCents, ...r } = refinements;
    req.refinements = { ...r, ...(maxDeliveryFeeCents !== undefined ? { maxDeliveryFee: maxDeliveryFeeCents } : {}) };
  }
  if (softLimits) {
    const { maxDeliveryFeeCents, ...r } = softLimits;
    req.softLimits = { ...r, ...(maxDeliveryFeeCents !== undefined ? { maxDeliveryFee: maxDeliveryFeeCents } : {}) };
  }
  return req;
}

const INPUT_STATUS: Record<string, 400 | 409> = { ADDRESS_AMBIGUOUS: 409, NO_ADDRESS: 409 };

/** `run` executa a avaliação na sessão do vínculo do organizador (definido pelo app). */
export function registerEvaluate(app: Hono, run: (c: Context, req: EvaluateRequest) => Promise<EvaluateOutcome>) {
  app.post('/api/evaluate', async (c) => {
    let json: unknown;
    try {
      json = await c.req.json();
    } catch {
      return c.json({ error: { kind: 'VALIDATION', message: 'Corpo deve ser JSON' } }, 400);
    }
    const parsed = EvaluateBody.safeParse(json);
    if (!parsed.success) {
      return c.json({ error: { kind: 'VALIDATION', message: 'Requisição inválida', issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) } }, 400);
    }
    try {
      const outcome = await run(c, toDomainRequest(parsed.data));
      return c.json(evaluateViewCents(evaluateView(outcome)));
    } catch (e) {
      if (e instanceof EvaluateInputError) return c.json({ error: { kind: 'INPUT', code: e.code, message: e.message } }, INPUT_STATUS[e.code] ?? 400);
      throw e; // McpToolError/AuthError → app.onError (502/401)
    }
  });
}
