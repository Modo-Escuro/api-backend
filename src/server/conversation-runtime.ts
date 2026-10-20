// Mesmo serviço de vínculos para login e assistente; modelo instalado apenas por opt-in explícito.
import type { AppConfig } from './config.js';
import type { IfoodLinkService } from './links/service.js';
import { createGeminiJsonModel } from './ai/gemini.js';
import { createAssistantProcessor } from './assistant/processor.js';
import { ASSISTANT_PROMPT, AssistantStepSchema, type AssistantInput } from './assistant/protocol.js';
import { AUDIENCE_PROMPT, AudienceSchema, type AudienceInput } from './assistant/audience.js';
import type { SpendBudget } from './ops/budget.js';
import { TurnRuntime } from './turns/runtime.js';
import { TurnStore } from './turns/store.js';
import { accountSession } from './turns/account-session.js';
import { DeliveryAddresses } from './services/delivery-addresses.js';

export function createConversationRuntime(cfg: AppConfig, links: Pick<IfoodLinkService, 'status' | 'withOperational'>, transport?: typeof fetch,
  budget?: SpendBudget) {
  if (!cfg.conversationRuntime) return undefined;
  const store = new TurnStore(cfg.conversationRuntime.dbFile);
  const addresses = new DeliveryAddresses(store, links);
  const model = cfg.conversationModel;
  const modelOptions = model ? { apiKey: model.apiKey, maxRequests: model.maxRequests, maxRequestsPerConversation: model.maxRequestsPerConversation,
    budgetMicroUsd: model.budgetMicroUsd, timeoutMs: model.timeoutMs, ...(transport ? { fetch: transport } : {}),
    accounting: { calls: 0, charged: 0, scopes: new Map<string, number>() } } : undefined;
  const processor = model && modelOptions
    ? createAssistantProcessor({
      model: createGeminiJsonModel(modelOptions, { prompt: ASSISTANT_PROMPT, schema: AssistantStepSchema,
        project: (input: AssistantInput) => ({ message: input.message, context: {
          people: input.context.people, targets: input.context.targets, writableSubjects: input.context.writableSubjects,
          purpose: input.context.purpose, budget: input.context.budget, previous: input.context.previous },
          tools: input.tools, results: input.results, round: input.round, remainingCalls: input.remainingCalls }),
        maxPromptBytes: 24_000, maxRequestBytes: 64_000 }),
      audienceModel: createGeminiJsonModel(modelOptions, { prompt: AUDIENCE_PROMPT, schema: AudienceSchema,
        project: (input: AudienceInput) => ({ message: input.message, recipients: input.recipients,
          previousTargets: input.previousTargets, previousPurpose: input.previousPurpose }), maxPromptBytes: 24_000, maxRequestBytes: 48_000 }),
      links, maxOutputTokens: model.maxOutputTokens,
      selectedAddress: (organizerId, linkId) => addresses.selected({ botId: cfg.conversationRuntime!.botId, organizerId, conversationId: organizerId }, linkId),
      ...(budget ? { budget } : {}),
    }) : undefined;
  return new TurnRuntime(store, { processor,
    // Essência da conta: muda a cada relogin/revogação; o bot copia a referência do /account-context.
    sessionOf: async p => accountSession(p, (await links.status(p.organizerId)).linkId) });
}
