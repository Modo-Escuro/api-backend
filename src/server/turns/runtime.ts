// Um processo da API: executor limitado, abort cooperativo e fencing persistido.
import { randomBytes } from 'node:crypto';
import { ContractError, type AdapterPrincipal } from '../contracts/guards.js';
import type { ConversationEvent, Operation, Snapshot } from '../contracts/conversation.js';
import { nextPurchase, type DomainChange, type PurchaseState } from '../domain/purchase.js';
import { scopeKey, TurnStore, type CancelCommand, type Job } from './store.js';

export interface TurnResult {
  snapshot: Snapshot;
  completeness: 'PARTIAL' | 'COMPLETE';
  paths: Operation['changes'][number]['paths'];
  cause?: 'USER' | 'DERIVED';
  /**
   * DATA-01: operações tipadas sobre a compra. O armazenamento recalcula o estado a partir do persistido,
   * na mesma transação do snapshot; um estado pronto nunca é aceito.
   */
  domain?: DomainChange;
}
export interface TurnContext {
  event: ConversationEvent;
  /** Identidade autenticada pelo adaptador (cópia). Única fonte para consultar o vínculo do organizador. */
  principal: AdapterPrincipal;
  snapshot: Snapshot;
  /** DATA-01: compra ativa no momento do claim (cópia; alterações só via `domain` no resultado). */
  purchase: PurchaseState | null;
  /** Pré-visualiza exatamente o estado que o commit vai gravar (mesmos IDs), para montar o snapshot. */
  previewDomain(change: DomainChange): PurchaseState | null;
  signal: AbortSignal;
  /** DEC-01 D8: demo somente leitura; esta barreira sempre rejeita escrita. */
  beforeExternalWrite(): void;
}
export type TurnProcessor = (context: TurnContext) => Promise<TurnResult>;
export interface RuntimeOptions {
  processor?: TurnProcessor;
  concurrency?: number;
  intervalMs?: number;
}

export class TurnRuntime {
  private readonly owner = randomBytes(24).toString('base64url');
  private readonly active = new Map<string, { job: Job; controller: AbortController; abortedAt?: number }>();
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private readonly concurrency: number;
  private readonly intervalMs: number;
  private healthy = true;
  private lastPurge = Number.NEGATIVE_INFINITY;
  /** D7: intervalo entre varreduras de expiração (o banco é a fonte de verdade; perder uma varredura só atrasa). */
  static readonly PURGE_INTERVAL_MS = 60_000;

  constructor(readonly store: TurnStore, private readonly options: RuntimeOptions = {}) {
    this.concurrency = options.concurrency ?? 2;
    this.intervalMs = options.intervalMs ?? 500;
    if (!Number.isSafeInteger(this.concurrency) || this.concurrency < 1 || this.concurrency > 4 ||
        !Number.isSafeInteger(this.intervalMs) || this.intervalMs < 10 ||
        this.intervalMs * 3 >= store.limits.leaseMs) throw new Error('Configuração de worker inválida.');
  }
  accept(p: AdapterPrincipal, event: ConversationEvent) {
    if (this.stopped || !this.healthy) throw new ContractError('UNAVAILABLE');
    return this.store.accept(p, event, Boolean(this.options.processor));
  }
  cancel(p: AdapterPrincipal, command: CancelCommand) {
    const result = this.store.cancel(p, command);
    this.active.get(command.operationId)?.controller.abort();
    return result;
  }
  start() {
    if (this.timer || this.stopped) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.timer.unref();
  }
  /** Público para testes com relógio controlado; não é rota HTTP nem ferramenta de IA. */
  tick() {
    if (this.stopped) return;
    try {
      this.store.recover();
      if (this.store.now() - this.lastPurge >= TurnRuntime.PURGE_INTERVAL_MS) {
        this.lastPurge = this.store.now();
        // Falha de expurgo não derruba a fila: o próximo ciclo tenta de novo (falhas por conversa já são isoladas).
        try { this.store.purge(); } catch { /* sem logar caminho/identidade */ }
      }
      if (!this.healthy) return;
      for (const slot of this.active.values()) {
        if (!this.store.heartbeat(slot.job)) {
          slot.controller.abort();
          if (slot.abortedAt === undefined) slot.abortedAt = this.store.now();
          else if (this.store.now() - slot.abortedAt >= 2000) this.healthy = false;
        }
      }
      if (!this.options.processor || !this.healthy) return;
      while (this.active.size < this.concurrency) {
        const job = this.store.claim(this.owner, [...this.active.keys()]);
        if (!job) break;
        const controller = new AbortController();
        this.active.set(job.operation.operationId, { job, controller });
        void this.execute(job, controller);
      }
    } catch {
      // Fail closed sem logar caminho do banco, payload, identidade ou exceção.
      this.healthy = false;
      for (const { controller } of this.active.values()) controller.abort();
    }
  }
  private async execute(job: Job, controller: AbortController) {
    try {
      const result = await this.options.processor!({
        event: structuredClone(job.event), snapshot: structuredClone(job.snapshot), signal: controller.signal,
        principal: { ...job.principal },
        purchase: structuredClone(job.purchase),
        previewDomain: (change) => {
          const next = nextPurchase(job.purchase, change, {
            seed: scopeKey(job.principal), eventId: job.operation.eventId, maxParticipants: this.store.limits.maxParticipants,
          }).state;
          // Mesma versão que o commit vai gravar (versão do snapshot resultante).
          return next && { ...next, version: job.snapshot.version + 1 };
        },
        beforeExternalWrite: () => {
          // D8 não permite habilitar escrita nem por flag nem por aprovação fictícia.
          throw new ContractError('ACTION_UNAVAILABLE');
        },
      });
      if (!this.stopped) this.store.finish(job, result);
    } catch (error) {
      if (!this.stopped) {
        try { this.store.fail(job, error instanceof ContractError ? error.code : 'INTERNAL'); }
        catch { this.healthy = false; }
      }
    } finally {
      if (this.active.get(job.operation.operationId)?.job.token === job.token) {
        this.active.delete(job.operation.operationId);
      }
    }
  }
  /** Não espera indefinidamente processador não cooperativo; lease permitirá recuperação. */
  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    for (const { controller } of this.active.values()) controller.abort();
    this.store.close();
  }
}
