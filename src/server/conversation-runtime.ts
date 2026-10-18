// Mesmo serviço de vínculos para login e agente; nenhum modelo determinístico como fallback de produção.
import type { AppConfig } from './config.js';
import type { IfoodLinkService } from './links/service.js';
import { ContractError } from './contracts/guards.js';
import { OpenAIConversationModel } from './agent/openai-model.js';
import { createAgentProcessor } from './agent/processor.js';
import { TurnRuntime } from './turns/runtime.js';
import { TurnStore } from './turns/store.js';

export function createConversationRuntime(cfg: AppConfig, links: Pick<IfoodLinkService, 'status'>, transport?: typeof fetch) {
  if (!cfg.conversationRuntime) return undefined;
  const model = cfg.conversationModel;
  const processor = model ? createAgentProcessor({
    model: new OpenAIConversationModel(model, transport),
    timeoutMs: model.timeoutMs,
    maxOutputTokens: model.maxOutputTokens,
    linkOf: async (organizerId) => {
      const status = await links.status(organizerId);
      if (status.state === 'UNAVAILABLE') throw new ContractError('UNAVAILABLE');
      // Coleta antes do login é permitida; somente o vínculo confirmado vem do serviço autenticado.
      return status.linkId;
    },
  }) : undefined;
  return new TurnRuntime(new TurnStore(cfg.conversationRuntime.dbFile), { processor });
}
