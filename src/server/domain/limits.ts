import { val } from './fields.js';
import type { TriState } from './constraints.js';
import type { NormalizedListingItem, NormalizedPromotion } from './normalize.js';
import { cents } from './money.js';

/** Frete em centavos; tempo em minutos, distância em km e avaliação em 0–5. */
export interface CandidateLimits {
  maxDeliveryTimeMinutes?: number;
  maxDeliveryFee?: number;
  maxDistanceKm?: number;
  minRating?: number;
  onlyWithPromotion?: boolean;
}

export interface LimitCheck {
  metric: keyof CandidateLimits;
  requirement: 'MANDATORY' | 'PREFERENCE';
  status: TriState;
  limit: number | boolean;
  observed: { min: number | null; max: number | null } | boolean | null;
}

const nonnegative = (n: number | undefined) => n !== undefined && Number.isFinite(n) && n >= 0 ? n : null;

export function evaluateLimits(listing: NormalizedListingItem, limits: CandidateLimits = {},
  requirement: LimitCheck['requirement'] = 'MANDATORY', promotion: NormalizedPromotion = listing.price): LimitCheck[] {
  const delivery = val(listing.merchant.delivery);
  const time = { min: nonnegative(delivery ? val(delivery.etaMinutes.min) : undefined),
    max: nonnegative(delivery ? val(delivery.etaMinutes.max) : undefined) };
  const invalidTime = delivery && [delivery.etaMinutes.min, delivery.etaMinutes.max]
    .some((field) => field.state === 'INVALID' || (field.state === 'PRESENT' && field.value < 0));
  const exact = (n: number | undefined | null) => ({ min: nonnegative(n ?? undefined), max: nonnegative(n ?? undefined) });
  const observations = {
    maxDeliveryTimeMinutes: time,
    maxDeliveryFee: exact(delivery?.effectiveFee),
    maxDistanceKm: exact(val(listing.merchant.distanceKm)),
    minRating: exact(val(listing.merchant.rating.rawValue)),
  };
  const checks: LimitCheck[] = [];
  for (const metric of ['maxDeliveryTimeMinutes', 'maxDeliveryFee', 'maxDistanceKm', 'minRating'] as const) {
    const limit = limits[metric];
    if (limit === undefined) continue;
    if (!Number.isFinite(limit) || limit < 0 || (metric === 'minRating' && limit > 5)) throw new RangeError('Limite inválido');
    if (metric === 'maxDeliveryFee') cents(limit);
    const observed = observations[metric];
    const valid = !(observed.min !== null && observed.max !== null && observed.min > observed.max)
      && !(metric === 'maxDeliveryTimeMinutes' && invalidTime)
      && !(metric === 'minRating' && observed.max !== null && observed.max > 5);
    let status: TriState = 'UNKNOWN';
    if (valid) {
      if (metric === 'minRating') {
        if (observed.min !== null) status = observed.min >= limit ? 'PASS' : 'FAIL';
      } else if (observed.min !== null && observed.min > limit) status = 'FAIL';
      else if (observed.max !== null && observed.max <= limit) status = 'PASS';
    }
    checks.push({ metric, requirement, status, limit, observed });
  }
  if (limits.onlyWithPromotion === true) {
    const p = promotion;
    const known = p.unitPrice.state === 'PRESENT' && p.promotionalUnitPrice.state !== 'INVALID';
    checks.push({ metric: 'onlyWithPromotion', requirement, limit: true,
      observed: known ? p.hasPromotion : null, status: !known ? 'UNKNOWN' : p.hasPromotion ? 'PASS' : 'FAIL' });
  }
  return checks;
}
