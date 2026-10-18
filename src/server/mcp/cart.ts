// Gateway exclusivo por vínculo. Não aceita cliente global e nunca expõe submitOrder.
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { CartGateway, CartTool } from '../cart/contracts.js';
import { WRITES } from '../cart/contracts.js';
import { MCP_TIMEOUT_MS } from './client.js';
import { McpToolError } from './errors.js';
import { parseToolResult, type RawToolResult } from './tools.js';

const READS = new Set(['getCart', 'getCartDeliveryMethods', 'listPaymentMethods', 'listVouchers']);
export function cartGateway(getClient: () => Promise<Client>): CartGateway {
  return { async call(tool: CartTool, args: Record<string, unknown>) {
    if (!READS.has(tool) && !WRITES.has(tool)) throw new Error('Tool fora do escopo F7');
    const client = await getClient();
    // Sem retry de aplicação. A sessão deste gateway também desliga replay automático em 401.
    const result = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: MCP_TIMEOUT_MS });
    const parsed = parseToolResult(tool, result as RawToolResult);
    if (parsed && typeof parsed === 'object' && 'success' in parsed && parsed.success === false)
      throw new McpToolError(tool, [{ code: 'UNCONFIRMED', message: 'O MCP não confirmou a operação.' }]);
    return parsed;
  } };
}
