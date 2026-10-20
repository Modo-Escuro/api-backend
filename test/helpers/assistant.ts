// Montagem sintética do assistente para testar orçamento e persistência sem catálogo/rede.
import { createAssistantProcessor } from '../../src/server/assistant/processor';
import type { AssistantModel } from '../../src/server/assistant/protocol';
import type { SpendBudget } from '../../src/server/ops/budget';

export function offlineAssistant(model: AssistantModel, budget?: SpendBudget, maxOutputTokens?: number) {
  return createAssistantProcessor({ model, budget, maxOutputTokens, timeoutMs: 2_000,
    audienceModel: { id: 'synthetic-router', propose: async r => {
      r.reportUsage?.({ inputTokens: 0, outputTokens: 0, costMicroUsd: 0 });
      return { targets: [{ kind: 'SELF' }], mentioned: [], purpose: 'FOOD', ambiguous: false };
    } },
    links: { status: async () => ({ state: 'DISCONNECTED', linkId: null }) as never,
      withOperational: async () => { throw new Error('Catálogo não esperado neste ensaio'); } },
    selectedAddress: () => { throw new Error('Endereço não esperado neste ensaio'); },
  });
}
