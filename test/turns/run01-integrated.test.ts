// RUN-01 com o processador real (AI-02 + Gemini com transporte sintético + DATA-01): morte de processo e
// resultado atrasado. Complementa store.test.ts, que cobre as mesmas etapas com resultados sintéticos.
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGeminiModel } from '../../src/server/agent/gemini-model';
import { createAgentProcessor } from '../../src/server/agent/processor';
import type { GroupResult } from '../../src/server/domain/group';
import { TurnRuntime } from '../../src/server/turns/runtime';
import { TurnStore } from '../../src/server/turns/store';
import { geminiReply } from '../helpers/gemini';
import { deferred, event, flush, principal, temporary } from './helpers';

const cleanup: (() => void)[] = [];
afterEach(() => { cleanup.splice(0).forEach((f) => f()); vi.restoreAllMocks(); });

function runtimeAt(file: string, transport: typeof fetch, now: () => number, proposals?: Parameters<typeof createAgentProcessor>[0]['proposals']) {
  const runtime = new TurnRuntime(new TurnStore(file, {}, now), { processor: createAgentProcessor({
    model: createGeminiModel({ apiKey: 'synthetic-key', maxRequests: 20, fetch: transport }), linkOf: async () => null, timeoutMs: 10_000,
    ...(proposals ? { proposals } : {}),
  }) });
  cleanup.push(() => runtime.stop());
  return runtime;
}
async function settle(runtime: TurnRuntime, operationId: string) {
  for (let i = 0; i < 400; i++) {
    runtime.tick(); await flush();
    const op = runtime.store.operation(principal, operationId);
    if (!['ACCEPTED', 'RUNNING'].includes(op.status)) return op;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('operação não terminou');
}
const domain = (runtime: TurnRuntime) => JSON.parse(String(runtime.store.db.prepare('SELECT domain FROM conversations').get()!['domain']));

describe('RUN-01 integrado: morte real do processo com o agente da AI-02', () => {
  for (const stage of ['accepted', 'running', 'committed'] as const) {
    it(`etapa ${stage}: reinício recupera a mesma operação, aplica uma vez e replay não chama o modelo`, async () => {
      const dir = temporary(); cleanup.push(dir.clean);
      const child = spawnSync(process.execPath, ['--import', 'tsx', 'test/turns/crash-agent-process.ts', dir.file, stage], { encoding: 'utf8', timeout: 30_000 });
      expect(child.status, child.stderr).toBe(17);
      const { operationId, calls: childCalls } = JSON.parse(child.stdout) as { operationId: string; calls: number };
      expect(childCalls).toBe(stage === 'accepted' ? 0 : 1);

      const later = Date.now() + 16_000; // lease de 15 s do processo morto já expirou
      const transport = vi.fn<typeof fetch>(async () => geminiReply({ actions: [{ action: 'ADD_PARTICIPANT', name: 'Ana' }] }));
      const runtime = runtimeAt(dir.file, transport, () => later);
      runtime.store.recover();
      const e = event(1, 0); e.input = { kind: 'TEXT', text: 'Somos Ana' };
      const replay = runtime.accept(principal, e);
      expect(replay).toMatchObject({ status: 200, operation: { operationId } });
      const op = await settle(runtime, operationId);
      expect(op).toMatchObject({ status: 'SUCCEEDED', resultVersion: 1 });
      // Leitura retomada chama o modelo de novo (sem efeito externo); resultado já gravado nunca é refeito.
      expect(transport).toHaveBeenCalledTimes(stage === 'committed' ? 0 : 1);
      expect(domain(runtime).participants.map((p: { displayName: string }) => p.displayName)).toEqual(['Ana']);
      expect(runtime.accept(principal, e).operation.operationId).toBe(operationId);
      runtime.tick(); await flush();
      expect(transport).toHaveBeenCalledTimes(stage === 'committed' ? 0 : 1);
      expect(runtime.store.snapshot(principal).version).toBe(1);
    });
  }
});

describe('RUN-01 integrado: busca atrasada não sobrescreve correção', () => {
  it('sugestão lenta (GRP-01) e correção de teto na mesma versão: correção vence, busca termina STALE_VERSION', async () => {
    const dir = temporary(); cleanup.push(dir.clean);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const replies: Record<string, unknown[]> = {
      'Somos Ana, sem restrições. Teto de R$ 180': [{ action: 'ADD_PARTICIPANT', name: 'Ana' }, { action: 'SET_NO_RESTRICTIONS', participant: { name: 'Ana' } },
        { action: 'SET_LIMIT', target: 'GROUP', amountCents: 18000, kind: 'MANDATORY' }],
      'Sugere pizza': [{ action: 'SUGGEST_PROPOSALS', query: 'pizza' }],
      'Na verdade, no máximo R$ 150': [{ action: 'SET_LIMIT', target: 'GROUP', amountCents: 15000, kind: 'MANDATORY' }],
    };
    const transport = vi.fn<typeof fetch>(async (_u, init) => {
      const message = JSON.parse(JSON.parse(String(init!.body)).contents[0].parts[0].text).message as string;
      return geminiReply({ actions: replies[message] });
    });
    const search = deferred<GroupResult>();
    const proposals = vi.fn(async () => search.promise);
    const runtime = runtimeAt(dir.file, transport, Date.now, proposals);
    const send = (n: number, text: string, version: number) => { const e = event(n, version); e.input = { kind: 'TEXT', text }; return runtime.accept(principal, e).operation.operationId; };

    expect(await settle(runtime, send(1, 'Somos Ana, sem restrições. Teto de R$ 180', 0))).toMatchObject({ status: 'SUCCEEDED', resultVersion: 1 });
    const slow = send(2, 'Sugere pizza', 1);
    for (let i = 0; i < 100 && !proposals.mock.calls.length; i++) { runtime.tick(); await flush(); await new Promise((r) => setTimeout(r, 5)); }
    expect(proposals).toHaveBeenCalledOnce(); // busca em andamento
    const correction = send(3, 'Na verdade, no máximo R$ 150', 1);
    expect(await settle(runtime, correction)).toMatchObject({ status: 'SUCCEEDED', resultVersion: 2 });
    search.resolve({ proposals: [], explanation: [] } as unknown as GroupResult); // busca antiga termina depois
    expect(await settle(runtime, slow)).toMatchObject({ status: 'FAILED', error: { code: 'STALE_VERSION' } });
    expect(runtime.store.snapshot(principal).version).toBe(2);
    expect(domain(runtime).groupLimit).toMatchObject({ state: 'DECLARED', value: { amountCents: 15000, kind: 'MANDATORY' } });
  });
});
