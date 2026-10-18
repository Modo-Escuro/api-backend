import { addCents } from '../../src/server/domain/money';
import type { RankCandidate } from '../../src/server/domain/ranking';
import { runEvaluation } from '../../src/server/services/evaluate';

/** Os testes legados de evidência declaram ECONOMY para isolar a semântica que verificam. */
export const evaluateWithEconomy: typeof runEvaluation = (req, deps, cache) =>
  runEvaluation({ ...req, preferences: { priority: 'ECONOMY', ...req.preferences } }, deps, cache);

/** ESTIMATIVA COMPLETA SINTÉTICA: serviço explicitamente conhecido só no teste.
 * Não representa dado observado no MCP. O catálogo de produção continua serviço UNKNOWN. */
export function completeSyntheticEstimate(candidate: RankCandidate, serviceFeeCents = 0) {
  const price = candidate.evaluation.pricing.selected ?? candidate.evaluation.pricing.minimumConfigurable;
  if (!price || price.status !== 'ESTIMATED' || price.itemsSubtotalRange.min === null ||
    price.itemsSubtotalRange.min !== price.itemsSubtotalRange.max || price.delivery.fee === null) {
    throw new Error('Teste precisa de subtotal de itens e frete conhecidos, de valor único');
  }
  price.service = { fee: serviceFeeCents, status: 'KNOWN' };
  price.estimatedTotal = addCents(price.itemsSubtotalRange.min, price.delivery.fee, serviceFeeCents);
  price.estimatedTotalRange = { min: price.estimatedTotal, max: price.estimatedTotal };
  return candidate;
}
