// Gateway exclusivo por vínculo. Não aceita cliente global e nunca expõe submitOrder.
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { CartGateway, CartTool } from '../cart/contracts.js';
import { WRITES, assertMutationConfirmation, parseCreatedCart, payload } from '../cart/contracts.js';
import { MCP_TIMEOUT_MS } from './client.js';
import { McpToolError } from './errors.js';
import { parseToolResult, type RawToolResult } from './tools.js';

const READS = new Set(['getCart', 'getCartDeliveryMethods', 'listPaymentMethods', 'listVouchers']);
export function cartGateway(getClient: () => Promise<Client>): CartGateway {
  const dispatch = async (tool: CartTool, args: Record<string, unknown>) => {
    const client = await getClient();
    const result = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: MCP_TIMEOUT_MS });
    const parsed = parseToolResult(tool, result as RawToolResult);
    if (parsed && typeof parsed === 'object' && 'success' in parsed && parsed.success === false)
      throw new McpToolError(tool, [{ code: 'UNCONFIRMED', message: 'O MCP não confirmou a operação.' }]);
    payload(parsed);
    if (tool === 'createCart') parseCreatedCart(parsed);
    else if (WRITES.has(tool)) assertMutationConfirmation(parsed);
    return parsed;
  };
  return { async describe() {
    const client = await getClient(), tools: { name: string; inputSchema: unknown }[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined);
      tools.push(...page.tools);
      cursor = page.nextCursor;
      if (cursor && seen.has(cursor)) throw new Error('Paginação de metadados inválida');
      if (cursor) seen.add(cursor);
      if (tools.length > 200) throw new Error('Catálogo MCP excede limite');
    } while (cursor);
    return tools;
  }, async call(tool: CartTool, args: Record<string, unknown>) {
    if (!READS.has(tool)) throw new Error('Escrita legada proibida; exige confirmação CART-01');
    return dispatch(tool, args);
  }, async writeConfirmed(tool, args) {
    if (!new Set(['createCart','addItemToCart','updateCartItem','removeItemFromCart']).has(tool))
      throw new Error('Operação fora do escopo CART-01; pagamento e envio proibidos');
    return dispatch(tool, args);
  } };
}
