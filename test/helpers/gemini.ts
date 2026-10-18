// Resposta sintética no formato do endpoint generateContent do Gemini (nenhuma chamada real).
import { GEMINI_MODEL } from '../../src/server/agent/gemini-model';

export const geminiReply = (proposal: unknown, finishReason = 'STOP') => Response.json({
  candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify(proposal) }] }, finishReason }],
  modelVersion: GEMINI_MODEL, usageMetadata: { promptTokenCount: 800, candidatesTokenCount: 40, totalTokenCount: 840 } });
