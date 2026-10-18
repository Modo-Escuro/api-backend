// Detalhamento isolado por candidato: uma falha não descarta os demais resultados.
import { classifyFailure } from '../links/classify.js';
import { McpToolError } from '../mcp/errors.js';
import type { LatLng } from '../mcp/types.js';
import type { EvaluateDeps } from '../services/evaluate.js';
import { CartError, parseItem } from './contracts.js';

export const CATALOG_LIMITS = { concurrency: 3, deadlineMs: 25_000, timeoutMs: 15_000, maxItems: 10 } as const;
interface Listing { itemId: string; merchant: { merchantId: string } }
type Detail = ReturnType<typeof parseItem>;
interface DetailFailure { itemId: string; kind: 'TIMEOUT' | 'DETAIL_UNAVAILABLE' | 'INVALID_RESPONSE' | 'SKIPPED_DEADLINE'; code: string | null }
class DetailTimeout extends Error {}

export async function catalogDetails(listings: Listing[], deps: EvaluateDeps, location: LatLng) {
  const started = performance.now();
  const remaining = () => Math.max(0, CATALOG_LIMITS.deadlineMs - (performance.now() - started));
  const stop = new AbortController();
  const details: (Detail | undefined)[] = new Array(listings.length);
  const failures: (DetailFailure | undefined)[] = new Array(listings.length);
  let next = 0, fatal: unknown;

  const read = async (listing: Listing): Promise<unknown> => {
    const timeoutMs = Math.min(CATALOG_LIMITS.timeoutMs, remaining());
    if (timeoutMs <= 0) throw new DetailTimeout();
    const timeout = new AbortController();
    const signal = AbortSignal.any([stop.signal, timeout.signal]);
    let rejectAbort!: () => void;
    const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = () => reject(new DetailTimeout()); });
    signal.addEventListener('abort', rejectAbort, { once: true });
    const timer = setTimeout(() => timeout.abort(), timeoutMs);
    try {
      if (signal.aborted) throw new DetailTimeout();
      return await Promise.race([
        deps.getItem({ itemId: listing.itemId, merchantId: listing.merchant.merchantId, userLocation: location }, { timeoutMs, signal }),
        aborted,
      ]);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', rejectAbort);
    }
  };

  const worker = async () => {
    while (!stop.signal.aborted) {
      const index = next++;
      const listing = listings[index];
      if (!listing) return;
      if (remaining() <= 0) {
        failures[index] = { itemId: listing.itemId, kind: 'SKIPPED_DEADLINE', code: null };
        continue;
      }
      try {
        const detail = parseItem(await read(listing));
        if (detail.itemId !== listing.itemId || detail.merchantId !== listing.merchant.merchantId)
          throw new CartError('ITEM_IDENTITY_MISMATCH', 'Detalhamento não corresponde à listagem.', 502);
        details[index] = detail;
      } catch (error) {
        // Credencial rejeitada é falha do vínculo, não apenas de um produto.
        if (classifyFailure(error).kind === 'RECONNECT') { fatal = error; stop.abort(); return; }
        failures[index] = { itemId: listing.itemId,
          kind: error instanceof DetailTimeout ? 'TIMEOUT' : error instanceof CartError ? 'INVALID_RESPONSE' : 'DETAIL_UNAVAILABLE',
          code: error instanceof McpToolError && /^[A-Z0-9_]{1,80}$/.test(error.code ?? '') ? error.code! : null };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CATALOG_LIMITS.concurrency, listings.length) }, worker));
  if (fatal !== undefined) throw fatal;
  const errors = failures.filter((failure): failure is DetailFailure => failure !== undefined);
  return { details: details.filter((detail): detail is Detail => detail !== undefined), errors,
    summary: { requested: listings.length, detailed: details.filter(Boolean).length,
      failed: errors.filter((error) => error.kind !== 'SKIPPED_DEADLINE').length,
      skippedDeadline: errors.filter((error) => error.kind === 'SKIPPED_DEADLINE').length,
      deadlineReached: remaining() <= 0 } };
}
