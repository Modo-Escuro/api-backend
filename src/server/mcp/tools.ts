// Wrappers tipados das tools do MVP. Somente leitura: tools de carrinho/pedido/escrita são bloqueadas.

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getMcpClient, MCP_TIMEOUT_MS } from './client.js';
import { extractErrors, McpToolError } from './errors.js';
import type {
  GetItemResult,
  LatLng,
  ListAddressesResult,
  SearchOffersArgs,
  SearchOffersResult,
} from './types.js';

/** Únicas tools que o app pode chamar (CLAUDE.md / requirements §2). */
export const ALLOWED_TOOLS = new Set([
  'listAddresses',
  'searchOffers',
  'browseOffers',
  'getRecommendations',
  'getItem',
  'getMerchant',
]);

export interface RawToolResult {
  content?: unknown;
  structuredContent?: unknown;
  isError?: boolean;
}

/** Converte o resultado do callTool em payload JSON, lançando McpToolError se houver erro inline. */
export function parseToolResult(tool: string, r: RawToolResult): unknown {
  let payload: unknown = r.structuredContent;
  if (payload === undefined && Array.isArray(r.content)) {
    const text = (r.content as Array<{ type?: string; text?: string }>).find((c) => c.type === 'text')?.text;
    if (text !== undefined) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = r.isError ? { error: text } : text;
      }
    }
  }
  const errors = extractErrors(payload);
  if (r.isError || errors.length) {
    throw new McpToolError(tool, errors.length ? errors : [{ message: `Erro sem detalhes em ${tool}` }]);
  }
  return payload;
}

export async function callReadTool<T>(
  name: string,
  args: Record<string, unknown>,
  client?: Client,
): Promise<T> {
  if (!ALLOWED_TOOLS.has(name)) throw new Error(`Tool não permitida no MVP: ${name}`);
  const c = client ?? (await getMcpClient());
  const r = (await c.callTool({ name, arguments: args }, undefined, { timeout: MCP_TIMEOUT_MS })) as RawToolResult;
  return parseToolResult(name, r) as T;
}

export const listAddresses = (client?: Client) => callReadTool<ListAddressesResult>('listAddresses', {}, client);

export function searchOffers(args: SearchOffersArgs, client?: Client) {
  if (!args.query.trim()) throw new Error('searchOffers exige `query` descritivo (qualificadores vão em refinements)');
  return callReadTool<SearchOffersResult>('searchOffers', { ...args }, client);
}

export const getItem = (a: { itemId: string; merchantId: string; userLocation: LatLng }, client?: Client) =>
  callReadTool<GetItemResult>('getItem', { ...a }, client);

export const getMerchant = (a: { merchantId: string; userLocation: LatLng }, client?: Client) =>
  callReadTool<Record<string, unknown>>('getMerchant', { ...a }, client);
