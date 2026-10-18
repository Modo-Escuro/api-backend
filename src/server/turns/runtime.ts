// Um processo da API: executor limitado, abort cooperativo e fencing persistido.
import { randomBytes } from 'node:crypto';
import { ContractError, type AdapterPrincipal } from '../contracts/guards.js';
import type { ConversationEvent, Operation, Snapshot } from '../contracts/conversation.js';
import { TurnStore, type CancelCommand, type Job } from './store.js';

export interface TurnResult {
  snapshot: Snapshot;
  completeness: 'PARTIAL' | 'COMPLETE';
  paths: Operation['changes'][number]['paths'];
  cause?: 'USER' | 'DERIVED';
}
export interface TurnContext {
  event: ConversationEvent;
  snapshot: Snapshot;
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
        const job = this.store.claim(this.owner);
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
      this.active.delete(job.operation.operationId);
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
