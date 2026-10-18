import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConversationEvent } from '../../src/server/contracts/conversation';
import type { Job } from '../../src/server/turns/store';
import type { TurnResult } from '../../src/server/turns/runtime';

export const principal = { organizerId: '111111111', botId: '900001', conversationId: '111111111' };
export function event(n = 1, expectedVersion = 0): ConversationEvent {
  return { contractVersion: '1.0', eventId: `tg-update-${n}`, conversationId: principal.conversationId,
    expectedVersion, source: { channel: 'TELEGRAM', botId: principal.botId,
      conversationId: principal.conversationId, kind: 'MESSAGE', messageId: String(n) },
    input: { kind: 'TEXT', text: 'Mensagem sintética; sem dados privados.' } };
}
export function cancelEnvelope(n: number) {
  const e = event(n);
  return { contractVersion: e.contractVersion, eventId: e.eventId, conversationId: e.conversationId,
    expectedVersion: e.expectedVersion, source: e.source };
}
export function result(job: Pick<Job, 'snapshot'>, text = 'Resposta sintética'): TurnResult {
  return { snapshot: { ...structuredClone(job.snapshot), version: job.snapshot.version + 1,
    blocks: [...job.snapshot.blocks.filter(b => b.kind !== 'TEXT'), { kind: 'TEXT', source: 'SERVER', text }] }, completeness: 'COMPLETE', paths: ['PHASE'] };
}
export function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export function temporary() {
  const dir = mkdtempSync(join(tmpdir(), 'run01-test-'));
  return { dir, file: join(dir, 'turns.sqlite'), clean: () => rmSync(dir, { recursive: true, force: true }) };
}
export const flush = () => new Promise<void>(resolve => setImmediate(resolve));
