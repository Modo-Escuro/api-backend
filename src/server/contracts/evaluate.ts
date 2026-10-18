// Contrato de avaliação/ranking independente do contrato conversacional 1.0.
import { z } from 'zod';
import { CRITERIA, RANKING_CONTRACT_VERSION } from '../domain/ranking.js';

const nonnegative = z.number().finite().nonnegative();
const cents = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable();
const range = z.object({ minCents: cents, maxCents: cents }).strict();
const issue = z.object({ code: z.string(), message: z.string() }).strict();
const criterion = z.object({
  criterion: z.enum(CRITERIA), weight: nonnegative, effectiveWeight: nonnegative,
  status: z.enum(['SCORED', 'NO_DATA']), score: z.number().min(0).max(1).nullable(),
  contribution: nonnegative.nullable(), basis: z.string(), reasons: z.array(z.string()), dataLimitations: z.array(z.string()),
}).strict();
const price = z.object({
  status: z.enum(['ESTIMATED', 'UNCERTAIN', 'UNAVAILABLE']), quantity: z.number().int().positive(),
  unitTotalCents: cents, unitTotalRange: range, estimatedTotalCents: cents, estimatedTotalRange: range,
  itemsAndDeliverySubtotalCents: cents,
  service: z.object({ feeCents: cents, status: z.enum(['KNOWN', 'UNKNOWN']) }).strict(),
}).passthrough().nullable();

export const RecommendationRankingSchema = z.object({
  rank: z.number().int().positive(), score: z.number().min(0).max(1).nullable(), criteria: z.array(criterion).length(CRITERIA.length),
  coverage: z.object({
    scoredCriteria: z.array(z.enum(CRITERIA)), noDataCriteria: z.array(z.enum(CRITERIA)),
    scoredCount: z.number().int().nonnegative(), totalCount: z.literal(CRITERIA.length),
    configuredWeight: nonnegative, scoredWeight: nonnegative, weightedFraction: z.number().min(0).max(1),
  }).strict(),
  orderingKeys: z.object({ estimatedTotalCents: cents, estimatedMinutes: nonnegative.nullable(), preferencesSatisfied: z.number().int().nonnegative().nullable() }).strict(),
  reasons: z.array(z.string()), dataLimitations: z.array(z.string()),
}).strict();

const candidate = z.object({
  itemId: z.string(), merchantId: z.string(), eligible: z.boolean(),
  category: z.enum(['ELIGIBLE', 'BLOCKED', 'NEEDS_VERIFICATION']), blockers: z.array(issue),
  warnings: z.array(issue), dataLimitations: z.array(z.string()),
  pricing: z.object({ minimumConfigurable: price, selected: price, confirmedTotalCents: z.null() }).strict(),
}).passthrough();

/** Campos fora do recorte do ranking são preservados pelos consumidores; não são descartados. */
export const EvaluateResponseSchema = z.object({
  contractVersion: z.literal(RANKING_CONTRACT_VERSION),
  money: z.object({ currency: z.literal('BRL'), unit: z.literal('CENTS') }).strict(),
  ranking: z.object({
    contractVersion: z.literal(RANKING_CONTRACT_VERSION), status: z.enum(['RANKED', 'PRIORITY_REQUIRED']),
    orderingPolicy: z.literal('DEC_01_D9'), scoreInterpretation: z.literal('RELATIVE_DIAGNOSTIC_NOT_PROBABILITY'),
    missingDataPolicy: z.literal('UNKNOWN_LAST_SCORE_DIAGNOSTIC_ONLY'), clarification: z.string().nullable(),
    priority: z.enum(['ECONOMY', 'SPEED', 'PREFERENCES']).nullable(),
    weights: z.object({ PREFERENCES: nonnegative, CONTEXT: nonnegative, PRICE: nonnegative, DELIVERY: nonnegative, RATING: nonnegative }).strict(),
    maxRecommendations: z.literal(4), eligibleConsidered: z.number().int().nonnegative(), eligibleScored: z.number().int().nonnegative(), notes: z.array(z.string()),
  }).strict(),
  recommendations: z.array(candidate.extend({ ranking: RecommendationRankingSchema })).max(4),
  eligible: z.array(candidate), blocked: z.array(candidate), needsVerification: z.array(candidate),
  summary: z.object({ candidates: z.number().int(), eligible: z.number().int(), blocked: z.number().int(), needsVerification: z.number().int(), recommendations: z.number().int(), blockerCounts: z.record(z.string(), z.number().int()) }).strict(),
  notes: z.array(z.string()),
}).passthrough();
