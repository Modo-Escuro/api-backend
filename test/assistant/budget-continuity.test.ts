import { describe, expect, it } from 'vitest';
import { resolveLimitReply } from '../../src/server/assistant/controls';
import { applyPatch, type PurchaseState } from '../../src/server/domain/purchase';
import { TurnRuntime } from '../../src/server/turns/runtime';
import { TurnStore } from '../../src/server/turns/store';
import { offlineAssistant } from '../helpers/assistant';
import { event, flush, principal, temporary } from '../turns/helpers';

describe('continuidade do orçamento #56 no assistente', () => {
  it.each(['valor máximo', 'referência'])('60 reais → reinício → %s conserva valor sem nova inferência', async reply => {
    const dir = temporary(); let calls = 0;
    const processor = () => offlineAssistant({ id: 'synthetic-budget', propose: async () => {
      calls++;
      return { message: 'Preciso saber o tipo desse orçamento.', requests: [], itemRefs: [], contextActions: [{ action: 'SET_LIMIT', amountCents: 6000 }] };
    } });
    let runtime = new TurnRuntime(new TurnStore(dir.file), { processor: processor() });
    const send = async (n: number, text: string) => {
      const input = event(n, n - 1); input.input = { kind: 'TEXT', text };
      const accepted = runtime.accept(principal, input);
      for (let i = 0; i < 80; i++) {
        runtime.tick(); await flush();
        const op = runtime.store.operation(principal, accepted.operation.operationId);
        if (!['ACCEPTED', 'RUNNING'].includes(op.status)) return op;
      }
      throw new Error('turno não concluiu');
    };
    try {
      expect(await send(1, '60 reais')).toMatchObject({ status: 'SUCCEEDED' });
      expect(runtime.store.snapshot(principal).pending).toContain('R$ 60.00 é um teto máximo ou uma referência?');
      runtime.stop(); runtime = new TurnRuntime(new TurnStore(dir.file), { processor: processor() });
      expect(await send(2, reply)).toMatchObject({ status: 'SUCCEEDED' });
      const domain = JSON.parse(String(runtime.store.db.prepare('SELECT domain FROM conversations').get()!['domain'])) as PurchaseState;
      expect(domain.groupLimit).toMatchObject({ state: 'DECLARED', value: { amountCents: 6000, kind: reply === 'referência' ? 'PREFERENCE' : 'MANDATORY' } });
      expect(domain.clarifications).toHaveLength(0);
      expect(calls).toBe(1);
      if (reply === 'valor máximo') {
        await send(3, '60 reais');
        expect(await send(4, 'referência')).toMatchObject({ status: 'SUCCEEDED', completeness: 'PARTIAL' });
        const preserved = JSON.parse(String(runtime.store.db.prepare('SELECT domain FROM conversations').get()!['domain'])) as PurchaseState;
        expect(preserved.groupLimit).toMatchObject({ state: 'DECLARED', value: { amountCents: 6000, kind: 'MANDATORY' } });
        expect(calls).toBe(2);
      }
    } finally { runtime.stop(); dir.clean(); }
  });
  it('sem pergunta canônica coletiva não atribui teto por resposta curta', () => {
    const s = applyPatch(null, [{ op: 'ADD_PARTICIPANT', displayName: 'Ana' }], { seed: 'budget', eventId: '1' }).state;
    expect(resolveLimitReply(s, 'valor máximo')).toBeNull();
    const changed = applyPatch(s, [{ op: 'MARK_UNCLEAR', target: s.participants[0]!.participantId, field: 'LIMIT', question: 'R$ 60.00 é um teto máximo ou uma referência?' }], { seed: 'budget', eventId: '2' }).state;
    expect(resolveLimitReply(changed, 'valor máximo')).toBeNull();
  });
});
