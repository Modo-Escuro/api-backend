// OPS-02: métricas agregadas em memória (contadores e histogramas de duração).
// Rótulos só de baixa cardinalidade e sem identidade: rota, método, classe de status, ferramenta, código, resultado.
// Não é histórico pessoal: nenhuma série é por organizador, conversa, vínculo ou operação.
import { safeString } from './log.js';

const LABEL_KEYS = new Set(['route', 'method', 'statusClass', 'tool', 'code', 'outcome', 'kind', 'component']);
/** Limites de duração em ms (cumulativos, estilo Prometheus). */
export const DURATION_BUCKETS_MS = [50, 100, 250, 500, 1000, 2500, 5000, 10_000, 30_000, 60_000, 120_000];
/** Teto de séries: protege memória contra rótulos inesperados. Excesso vai para `droppedSeries`. */
export const MAX_SERIES = 500;

export type Labels = Record<string, string | number | boolean | null | undefined>;

interface Histogram { count: number; sumMs: number; maxMs: number; buckets: number[] }

function seriesKey(name: string, labels: Labels): string {
  const parts = Object.entries(labels)
    .filter(([k, v]) => LABEL_KEYS.has(k) && v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${safeString(String(v))}`);
  return parts.length ? `${safeString(name)}{${parts.join(',')}}` : safeString(name);
}

export class Metrics {
  private counters = new Map<string, number>();
  private histograms = new Map<string, Histogram>();
  private dropped = 0;
  private readonly startedAt: number;

  constructor(private readonly now: () => number = Date.now) {
    this.startedAt = now();
  }

  private room(key: string): boolean {
    if (this.counters.has(key) || this.histograms.has(key)) return true;
    if (this.counters.size + this.histograms.size >= MAX_SERIES) { this.dropped++; return false; }
    return true;
  }

  inc(name: string, labels: Labels = {}, n = 1) {
    if (!Number.isFinite(n) || n < 0) return;
    const key = seriesKey(name, labels);
    if (!this.room(key)) return;
    this.counters.set(key, (this.counters.get(key) ?? 0) + n);
  }

  observe(name: string, labels: Labels, ms: number) {
    if (!Number.isFinite(ms) || ms < 0) return;
    const key = seriesKey(name, labels);
    if (!this.room(key)) return;
    const h = this.histograms.get(key) ?? { count: 0, sumMs: 0, maxMs: 0, buckets: DURATION_BUCKETS_MS.map(() => 0) };
    h.count++;
    h.sumMs += ms;
    h.maxMs = Math.max(h.maxMs, ms);
    DURATION_BUCKETS_MS.forEach((le, i) => { if (ms <= le) h.buckets[i]!++; });
    this.histograms.set(key, h);
  }

  counter(name: string, labels: Labels = {}): number {
    return this.counters.get(seriesKey(name, labels)) ?? 0;
  }

  /** Soma de todas as séries de um contador (qualquer rótulo). */
  total(name: string): number {
    let sum = 0;
    for (const [k, v] of this.counters) if (k === name || k.startsWith(`${name}{`)) sum += v;
    return sum;
  }

  snapshot() {
    return {
      sinceMs: this.now() - this.startedAt,
      counters: Object.fromEntries(this.counters),
      histograms: Object.fromEntries([...this.histograms].map(([k, h]) => [k, {
        count: h.count, sumMs: Math.round(h.sumMs), maxMs: Math.round(h.maxMs),
        buckets: Object.fromEntries(DURATION_BUCKETS_MS.map((le, i) => [`le${le}`, h.buckets[i]])),
      }])),
      droppedSeries: this.dropped,
    };
  }

  reset() {
    this.counters.clear();
    this.histograms.clear();
    this.dropped = 0;
  }
}

/** Instância do processo. Métricas são voláteis: reiniciar o processo zera os contadores. */
export const metrics = new Metrics();

export const statusClass = (status: number) => `${Math.floor(status / 100)}xx`;
