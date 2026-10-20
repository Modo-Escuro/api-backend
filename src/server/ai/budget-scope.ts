import { createHash } from 'node:crypto';
import type { AdapterPrincipal } from '../contracts/guards.js';

export const modelBudgetScope = (p: AdapterPrincipal) => createHash('sha256')
  .update(JSON.stringify(['AI-01-scope', p.botId, p.organizerId, p.conversationId])).digest('base64url').slice(0, 24);
