// Montagem AI-01 (#36 kujojorin) com o provedor Gemini avaliado no #35 (Maylon) e as propostas da GRP-01.
// Mesmo serviço de vínculos para login, agente e leitura MCP; nenhum modelo determinístico como fallback de produção.
import type { AppConfig } from './config.js';
import type { IfoodLinkService } from './links/service.js';
import { createGeminiModel } from './agent/gemini-model.js';
import { createAgentProcessor } from './agent/processor.js';
import type { SpendBudget } from './ops/budget.js';
import { linkedProposalProvider } from './services/group.js';
import { TurnRuntime } from './turns/runtime.js';
import { TurnStore } from './turns/store.js';
import { DeliveryAddresses } from './services/delivery-addresses.js';

/** Folga do turno além do prazo do modelo, para a consulta local do vínculo não consumir o tempo do modelo. */
const LINK_LOOKUP_MARGIN_MS = 2_000;

export function createConversationRuntime(cfg: AppConfig, links: Pick<IfoodLinkService, 'status' | 'withOperational'> & Partial<Pick<IfoodLinkService, 'withConversationAccount'>>, transport?: typeof fetch,
  budget?: SpendBudget) {
  if (!cfg.conversationRuntime) return undefined;
  const store = new TurnStore(cfg.conversationRuntime.dbFile);
  const addresses = new DeliveryAddresses(store, links);
  const model = cfg.conversationModel;
  const processor = model ? createAgentProcessor({
    model: createGeminiModel({ apiKey: model.apiKey, maxRequests: model.maxRequests, maxRequestsPerConversation: model.maxRequestsPerConversation,
      budgetMicroUsd: model.budgetMicroUsd, timeoutMs: model.timeoutMs, ...(transport ? { fetch: transport } : {}) }),
    timeoutMs: model.timeoutMs + LINK_LOOKUP_MARGIN_MS,
    maxOutputTokens: model.maxOutputTokens,
    // Coleta (participantes, restrições, tetos) não depende do iFood: falha de rede na verificação do vínculo
    // (state UNAVAILABLE) não bloqueia o turno. Só falha de armazenamento lança (exceção de status()).
    // Operações que dependem do MCP (sugestões) passam por withOperational, que exige vínculo operacional.
    linkOf: async (organizerId) => (await links.status(organizerId)).linkId,
    proposals: linkedProposalProvider(links, { addressFor: (organizerId, ctx) => addresses.forSuggestions({
      botId: cfg.conversationRuntime!.botId, organizerId, conversationId: organizerId,
    }, ctx) }),
    // OPS-02: reserva antes do Gemini e ajuste pelos tokens reportados (reportUsage); LIMIT_EXCEEDED antes da chamada.
    ...(budget ? { budget } : {}),
  }) : undefined;
  if (cfg.accountGroups && !links.withConversationAccount) { store.close(); throw new Error('Grupos por conta exigem identidade autenticada.'); }
  return new TurnRuntime(store, { processor, ...(cfg.accountGroups ? { accountScope: links.withConversationAccount!.bind(links) } : {}) });
}
