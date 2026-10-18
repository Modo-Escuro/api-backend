// Limpar perfil e remover pessoa com confirmação humana explícita (botões do bot), pelo runtime real (RUN-01 + DATA-01).
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConversationEvent, Operation } from '../../src/server/contracts/conversation';
import { DeterministicModel } from '../../src/server/agent/mock-model';
import { createAgentProcessor } from '../../src/server/agent/processor';
import { humanCommand } from '../../src/server/agent/short-reply';
import { applyPatch } from '../../src/server/domain/purchase';
import { TurnRuntime } from '../../src/server/turns/runtime';
import { TurnStore } from '../../src/server/turns/store';
import { ORG_A, connectAndConfirm, setup } from '../helpers/fakes';
import { flush, temporary } from '../turns/helpers';

const BOT = '900001';
const p = { organizerId: ORG_A, botId: BOT, conversationId: ORG_A };
const msg = (n: number, text: string, expectedVersion: number): ConversationEvent => ({ contractVersion: '1.0', eventId: `tg-update-${n}`,
  conversationId: ORG_A, expectedVersion, source: { channel: 'TELEGRAM', botId: BOT, conversationId: ORG_A, kind: 'MESSAGE', messageId: String(n) },
  input: { kind: 'TEXT', text } });

describe('limpar perfil / remover pessoa', () => {
  const cleanup: (() => void)[] = [];
  afterEach(() => { cleanup.splice(0).forEach(f => f()); vi.restoreAllMocks(); });

  async function world() {
    const env = setup();
    await connectAndConfirm(env, ORG_A);
    const dir = temporary();
    const model = new DeterministicModel();
    const propose = vi.spyOn(model, 'propose');
    const make = () => new TurnRuntime(new TurnStore(dir.file), { processor: createAgentProcessor({
      model, linkOf: async (org) => (await env.links.status(org)).linkId, timeoutMs: 5_000 }) });
    let runtime = make();
    cleanup.push(() => { runtime.stop(); dir.clean(); });
    let n = 0;
    const send = async (text: string): Promise<Operation> => {
      const version = (() => { try { return runtime.store.snapshot(p).version; } catch { return 0; } })();
      const a = runtime.accept(p, msg(++n, text, version));
      for (let i = 0; i < 80; i++) {
        runtime.tick(); await flush();
        const op = runtime.store.operation(p, a.operation.operationId);
        if (!['ACCEPTED', 'RUNNING'].includes(op.status)) return op;
        await new Promise(r => setTimeout(r, 5));
      }
      throw new Error('operação não terminou');
    };
    const domain = () => {
      const r = runtime.store.db.prepare('SELECT domain FROM conversations WHERE scope LIKE ?').get(`%"${ORG_A}"%`);
      return r?.['domain'] ? JSON.parse(String(r['domain'])) : null;
    };
    return { send, domain, propose, restart: () => { runtime.stop(); runtime = make(); } };
  }

  it('remove pessoa com alergia só com confirmação explícita, e apagar tudo exclui a compra de forma durável', async () => {
    const w = await world();
    expect((await w.send('Somos Ana e Bia. Ana é alérgica a amendoim. Bia não tem restrições.')).status).toBe('SUCCEEDED');
    expect(w.domain().participants.map((x: { displayName: string }) => x.displayName)).toEqual(['Ana', 'Bia']);

    const calls = w.propose.mock.calls.length;
    const removed = await w.send('Confirmo: remover Ana do pedido.');
    expect(removed.status).toBe('SUCCEEDED');
    expect(w.domain().participants.map((x: { displayName: string }) => x.displayName)).toEqual(['Bia']);
    expect(JSON.stringify(removed.snapshot)).toMatch(/Ana foi removida do pedido/);

    const cleared = await w.send('Confirmo: apagar todos os dados deste pedido.');
    expect(cleared.status).toBe('SUCCEEDED');
    expect(w.domain()).toBeNull();
    expect(w.propose.mock.calls.length).toBe(calls); // confirmações nunca passam pelo modelo
    w.restart();
    expect(w.domain()).toBeNull();

    // Recomeça do zero: uso individual.
    expect((await w.send('É um pedido individual, só para mim.')).status).toBe('SUCCEEDED');
    expect(w.domain().participants.map((x: { displayName: string }) => x.displayName)).toEqual(['Você']);
  });

  it('frase sem a confirmação literal não remove pessoa com alergia', () => {
    const s = applyPatch(null, [{ op: 'ADD_PARTICIPANT', displayName: 'Ana' }], { seed: 'c', eventId: 'e1' }).state;
    expect(humanCommand(s, 'remover Ana')).toBeNull();
    expect(humanCommand(s, 'Confirmo: remover Caio do pedido.')).toEqual({ ops: [], note: expect.stringMatching(/Não encontrei/) });
    expect(humanCommand(null, 'Confirmo: apagar todos os dados deste pedido.')).toEqual({ ops: [], note: expect.stringMatching(/Não há dados/) });
    expect(humanCommand(s, 'confirmo: remover ana do pedido')?.ops).toEqual([{ op: 'REMOVE_PARTICIPANT', participantId: s.participants[0]!.participantId, humanConfirmed: true }]);
  });
});
