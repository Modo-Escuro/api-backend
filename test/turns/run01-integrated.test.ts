// RUN-01 com o processador real (AI-02 + Gemini com transporte sintético + DATA-01): morte de processo e
// resultado atrasado. Complementa store.test.ts, que cobre as mesmas etapas com resultados sintéticos.
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { offlineAssistant } from '../helpers/assistant';
import { TurnRuntime } from '../../src/server/turns/runtime';
import { TurnStore } from '../../src/server/turns/store';
import { geminiAssistant, geminiReply } from '../helpers/gemini';
import { deferred, event, flush, principal, temporary } from './helpers';

const cleanup: (() => void)[] = [];
// Ordem inversa: fecha o runtime/SQLite antes de apagar a pasta (Windows não remove arquivo aberto).
afterEach(() => { cleanup.splice(0).reverse().forEach((f) => f()); vi.restoreAllMocks(); });

function runtimeAt(file: string, transport: typeof fetch, now: () => number) {
  const runtime = new TurnRuntime(new TurnStore(file, {}, now), { processor: offlineAssistant(geminiAssistant(transport)) });
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

describe('RUN-01 integrado: morte real do processo com o assistente', () => {
  for (const stage of ['accepted', 'running', 'committed'] as const) {
    it(`etapa ${stage}: reinício recupera a mesma operação, aplica uma vez e replay não chama o modelo`, async () => {
      const dir = temporary(); cleanup.push(dir.clean);
      const child = spawnSync(process.execPath, ['--import', 'tsx', 'test/turns/crash-assistant-process.ts', dir.file, stage], { encoding: 'utf8', timeout: 30_000 });
      expect(child.status, child.stderr).toBe(17);
      // Logs do processo (OPS-02 ou outros) não podem misturar-se ao resultado: stdout tem exatamente uma linha JSON.
      expect(child.stdout.trim().split('\n')).toHaveLength(1);
      if (stage !== 'accepted') expect(child.stderr).toContain('synthetic.log');
      const { operationId, calls: childCalls } = JSON.parse(child.stdout) as { operationId: string; calls: number };
      expect(childCalls).toBe(stage === 'accepted' ? 0 : 1);

      const later = Date.now() + 16_000; // lease de 15 s do processo morto já expirou
      const transport = vi.fn<typeof fetch>(async () => geminiReply({ message: 'Vamos organizar o pedido.', requests: [], itemRefs: [], contextActions: [{ action: 'SET_PRIORITY', value: 'ECONOMY' }] }));
      const runtime = runtimeAt(dir.file, transport, () => later);
      runtime.store.recover();
      const e = event(1, 0); e.input = { kind: 'TEXT', text: 'Somos Ana' };
      const replay = runtime.accept(principal, e);
      expect(replay).toMatchObject({ status: 200, operation: { operationId } });
      const op = await settle(runtime, operationId);
      expect(op).toMatchObject({ status: 'SUCCEEDED', resultVersion: 1 });
      // Leitura retomada chama o modelo de novo (sem efeito externo); resultado já gravado nunca é refeito.
      expect(transport).toHaveBeenCalledTimes(stage === 'committed' ? 0 : 1);
      expect(domain(runtime).priority).toMatchObject({ state: 'DECLARED', value: 'ECONOMY' });
      expect(runtime.accept(principal, e).operation.operationId).toBe(operationId);
      runtime.tick(); await flush();
      expect(transport).toHaveBeenCalledTimes(stage === 'committed' ? 0 : 1);
      expect(runtime.store.snapshot(principal).version).toBe(1);
    });
  }
});

describe('RUN-01 integrado: busca atrasada não sobrescreve correção', () => {
  it('planejamento lento e correção de teto na mesma versão: correção vence, planejamento termina STALE_VERSION', async () => {
    const dir = temporary(); cleanup.push(dir.clean);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const search = deferred<void>();
    let searching = false;
    const transport = vi.fn<typeof fetch>(async (_u, init) => {
      const message = JSON.parse(JSON.parse(String(init!.body)).contents[0].parts[0].text).message as string;
      if (message === 'Sugere pizza') { searching = true; await search.promise; }
      return geminiReply({ message: 'Vamos organizar o pedido.', requests: [], itemRefs: [], contextActions: message === 'Sugere pizza' ? []
        : [{ action: 'SET_LIMIT', amountCents: message.includes('150') ? 15000 : 18000, kind: 'MANDATORY' }] });
    });
    const runtime = runtimeAt(dir.file, transport, Date.now);
    const send = (n: number, text: string, version: number) => { const e = event(n, version); e.input = { kind: 'TEXT', text }; return runtime.accept(principal, e).operation.operationId; };

    expect(await settle(runtime, send(1, 'Somos Ana, sem restrições. Teto de R$ 180', 0))).toMatchObject({ status: 'SUCCEEDED', resultVersion: 1 });
    const slow = send(2, 'Sugere pizza', 1);
    for (let i = 0; i < 100 && !searching; i++) { runtime.tick(); await flush(); await new Promise((r) => setTimeout(r, 5)); }
    expect(searching).toBe(true);
    const correction = send(3, 'Na verdade, no máximo R$ 150', 1);
    expect(await settle(runtime, correction)).toMatchObject({ status: 'SUCCEEDED', resultVersion: 2 });
    search.resolve(); // planejamento antigo termina depois
    expect(await settle(runtime, slow)).toMatchObject({ status: 'FAILED', error: { code: 'STALE_VERSION' } });
    expect(runtime.store.snapshot(principal).version).toBe(2);
    expect(domain(runtime).groupLimit).toMatchObject({ state: 'DECLARED', value: { amountCents: 15000, kind: 'MANDATORY' } });
  });
});
