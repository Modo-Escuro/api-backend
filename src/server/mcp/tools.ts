// Wrappers tipados das tools do MVP. Somente leitura: tools de carrinho/pedido/escrita são bloqueadas.

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getMcpClient, MCP_TIMEOUT_MS } from './client.js';
import { extractErrors, McpToolError } from './errors.js';
import { metrics } from '../ops/metrics.js';
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
  // Exceção (F3.5): só para exibir a identidade mascarada da conta na confirmação do vínculo.
  // Contrato observado em 2026-10-17: { success, data: { fullName, email, phone } }; readOnlyHint=true; escopo mcp.user.basic.read.
  'getUser',
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

export interface CallOptions {
  /** Limite desta chamada (ms); nunca acima de MCP_TIMEOUT_MS. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export async function callReadTool<T>(
  name: string,
  args: Record<string, unknown>,
  client?: Client,
  opts: CallOptions = {},
): Promise<T> {
  if (!ALLOWED_TOOLS.has(name)) throw new Error(`Tool não permitida no MVP: ${name}`);
  const c = client ?? (await getMcpClient());
  const timeout = Math.max(1, Math.min(opts.timeoutMs ?? MCP_TIMEOUT_MS, MCP_TIMEOUT_MS));
  const t0 = Date.now();
  // OPS-02: só ferramenta, resultado e código do erro (nunca argumentos, coordenadas ou payload).
  let outcome = 'OK', code: string | undefined;
  try {
    const r = (await c.callTool({ name, arguments: args }, undefined, { timeout, signal: opts.signal })) as RawToolResult;
    return parseToolResult(name, r) as T;
  } catch (e) {
    outcome = e instanceof McpToolError ? 'TOOL_ERROR' : 'TRANSPORT_ERROR';
    code = e instanceof McpToolError ? (e.code ?? 'UNSPECIFIED') : undefined;
    throw e;
  } finally {
    metrics.inc('mcp_tool_calls_total', { tool: name, outcome, code });
    metrics.observe('mcp_tool_duration_ms', { tool: name }, Date.now() - t0);
  }
}

export const listAddresses = (client?: Client) => callReadTool<ListAddressesResult>('listAddresses', {}, client);

export function searchOffers(args: SearchOffersArgs, client?: Client, opts?: CallOptions) {
  if (!args.query.trim()) throw new Error('searchOffers exige `query` descritivo (qualificadores vão em refinements)');
  return callReadTool<SearchOffersResult>('searchOffers', { ...args }, client, opts);
}

export const getItem = (a: { itemId: string; merchantId: string; userLocation: LatLng }, client?: Client, opts?: CallOptions) =>
  callReadTool<GetItemResult>('getItem', { ...a }, client, opts);

/** Perfil básico. Nunca pede profileData (comportamental). */
export const getUser = (client?: Client, opts?: CallOptions) => callReadTool<unknown>('getUser', { includeProfileData: false }, client, opts);

export const getMerchant = (a: { merchantId: string; userLocation: LatLng }, client?: Client) =>
  callReadTool<Record<string, unknown>>('getMerchant', { ...a }, client);
