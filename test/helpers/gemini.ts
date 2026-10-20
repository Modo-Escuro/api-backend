// Resposta sintética no formato do endpoint generateContent do Gemini (nenhuma chamada real).
import { GEMINI_MODEL } from '../../src/server/ai/gemini';
import { createGeminiJsonModel } from '../../src/server/ai/gemini';
import { ASSISTANT_PROMPT, AssistantStepSchema, type AssistantInput } from '../../src/server/assistant/protocol';

export const geminiAssistant = (transport: typeof fetch) => createGeminiJsonModel({
  apiKey: 'synthetic-key', maxRequests: 100, fetch: transport,
}, { prompt: ASSISTANT_PROMPT, schema: AssistantStepSchema, project: (input: AssistantInput) => ({ message: input.message }) });

export const geminiReply = (proposal: unknown, finishReason = 'STOP') => Response.json({
  candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify(proposal) }] }, finishReason }],
  modelVersion: GEMINI_MODEL, usageMetadata: { promptTokenCount: 800, candidatesTokenCount: 40, totalTokenCount: 840 } });
