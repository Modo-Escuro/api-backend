// OPS-02: orçamento de execução/gasto do modelo, por conversa e global, em janela fixa.
// A reserva é feita ANTES da chamada (teto de saída como estimativa conservadora) e ajustada pelo uso reportado.
// Estourar o orçamento é uma parada clara (LIMIT_EXCEEDED) antes de chamar o provedor: o estado da compra não muda.
//
// Chaves são hashes da conversa; nenhuma identidade fica em memória em texto claro.
// Limitação: em memória por processo. Reiniciar zera as janelas (aceitável para uma instância; ver docs/ops-02).
import { createHash } from 'node:crypto';

export interface BudgetLimits {
  /** Janela de contagem. */
  windowMs: number;
  /** Chamadas ao modelo por conversa na janela. */
  maxCallsPerConversation: number;
  /** Tokens (entrada + saída; reserva se o provedor não reportar) por conversa na janela. */
  maxTokensPerConversation: number;
  /** Chamadas somadas de todas as conversas na janela. */
  maxCallsGlobal: number;
  /** Tokens somados de todas as conversas na janela. */
  maxTokensGlobal: number;
  /** Conversas distintas acompanhadas; cheio após limpeza ⇒ recusa (fail closed, sem apagar contagem). */
  maxConversations: number;
}

export const DEFAULT_BUDGET: BudgetLimits = {
  windowMs: 60 * 60_000,
  maxCallsPerConversation: 60,
  maxTokensPerConversation: 200_000,
  maxCallsGlobal: 2_000,
  maxTokensGlobal: 4_000_000,
  maxConversations: 5_000,
};

export type BudgetDenial = 'INVALID_RESERVATION' | 'CONVERSATION_CALLS' | 'CONVERSATION_TOKENS' | 'GLOBAL_CALLS' | 'GLOBAL_TOKENS' | 'TRACKING_FULL';

interface Window { start: number; calls: number; tokens: number }

export interface Reservation {
  /** Ajusta a reserva ao uso real reportado (entrada + saída). Sem uso reportado, mantém a reserva. */
  settle(usedTokens: number | null): void;
}

export const conversationKey = (scope: string) => createHash('sha256').update(`ops02:${scope}`).digest('base64url');

export class SpendBudget {
  readonly limits: BudgetLimits;
  private conversations = new Map<string, Window>();
  private global: Window;

  constructor(limits: Partial<BudgetLimits> = {}, private readonly now: () => number = Date.now) {
    this.limits = { ...DEFAULT_BUDGET, ...limits };
    for (const n of Object.values(this.limits)) {
      if (!Number.isSafeInteger(n) || n <= 0) throw new Error('Orçamento de execução inválido.');
    }
    this.global = { start: now(), calls: 0, tokens: 0 };
  }

  private fresh(w: Window | undefined): Window {
    const t = this.now();
    return w && t - w.start < this.limits.windowMs ? w : { start: t, calls: 0, tokens: 0 };
  }

  /** Remove janelas vencidas (limpeza de referências). Retorna quantas saíram. */
  sweep(): number {
    const t = this.now();
    let removed = 0;
    for (const [k, w] of this.conversations) {
      if (t - w.start >= this.limits.windowMs) { this.conversations.delete(k); removed++; }
    }
    return removed;
  }

  get tracked() { return this.conversations.size; }

  /** Reserva uma chamada com `reservedTokens`. Recusa sem alterar contagens. */
  reserve(key: string, reservedTokens: number): { ok: true; reservation: Reservation } | { ok: false; denial: BudgetDenial } {
    // Reserva não finita/negativa desligaria os tetos (comparações com NaN são falsas): recusa sem alterar contagens.
    if (!Number.isFinite(reservedTokens) || reservedTokens < 0) return { ok: false, denial: 'INVALID_RESERVATION' };
    const reserved = Math.ceil(reservedTokens);
    this.global = this.fresh(this.global);
    if (!this.conversations.has(key) && this.conversations.size >= this.limits.maxConversations) this.sweep();
    if (!this.conversations.has(key) && this.conversations.size >= this.limits.maxConversations) return { ok: false, denial: 'TRACKING_FULL' };
    const conv = this.fresh(this.conversations.get(key));
    const l = this.limits;
    if (conv.calls + 1 > l.maxCallsPerConversation) return { ok: false, denial: 'CONVERSATION_CALLS' };
    if (conv.tokens + reserved > l.maxTokensPerConversation) return { ok: false, denial: 'CONVERSATION_TOKENS' };
    if (this.global.calls + 1 > l.maxCallsGlobal) return { ok: false, denial: 'GLOBAL_CALLS' };
    if (this.global.tokens + reserved > l.maxTokensGlobal) return { ok: false, denial: 'GLOBAL_TOKENS' };
    conv.calls++; conv.tokens += reserved;
    this.global.calls++; this.global.tokens += reserved;
    this.conversations.set(key, conv);
    const global = this.global;
    let settled = false;
    return {
      ok: true,
      reservation: {
        settle: (used) => {
          if (settled || used === null || !Number.isFinite(used) || used < 0) return;
          settled = true;
          // Só ajusta se a janela da reserva ainda é a atual; uso maior que a reserva também é cobrado.
          const delta = Math.ceil(used) - reserved;
          if (this.conversations.get(key) === conv) conv.tokens = Math.max(0, conv.tokens + delta);
          if (this.global === global) global.tokens = Math.max(0, global.tokens + delta);
        },
      },
    };
  }

  summary() {
    const g = this.fresh(this.global);
    return {
      windowMs: this.limits.windowMs,
      trackedConversations: this.conversations.size,
      global: { calls: g.calls, tokens: g.tokens, maxCalls: this.limits.maxCallsGlobal, maxTokens: this.limits.maxTokensGlobal },
      perConversation: { maxCalls: this.limits.maxCallsPerConversation, maxTokens: this.limits.maxTokensPerConversation },
    };
  }
}
