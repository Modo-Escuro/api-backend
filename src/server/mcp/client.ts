// Cliente MCP (Streamable HTTP) independente de Claude Code/OpenCode.
// Uma McpSession = um cliente MCP ligado a UM IfoodAuth (um conjunto de tokens). Sessões de
// vínculos diferentes nunca compartilham cliente, sessão HTTP ou token.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { IfoodAuth } from '../auth.js';
import { config } from '../config.js';

export const MCP_TIMEOUT_MS = 15_000;

/** Injeta Bearer; em 401 tenta refresh uma vez e repete. */
function authedFetch(auth: IfoodAuth, retryUnauthorized = true): typeof fetch {
  return async (input, init) => {
    const send = async (token: string) => {
      const headers = new Headers(init?.headers);
      headers.set('Authorization', `Bearer ${token}`);
      return fetch(input, { ...init, headers });
    };
    const res = await send(await auth.getAccessToken());
    if (res.status !== 401 || !retryUnauthorized) return res;
    const t = await auth.refresh();
    return send(t.accessToken);
  };
}

export class McpSession {
  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;

  constructor(
    readonly auth: IfoodAuth,
    private readonly url = config.mcpUrl,
    private readonly retryUnauthorized = true,
  ) {}

  async getClient(): Promise<Client> {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const c = new Client({ name: 'compra-com-contexto', version: '0.1.0' });
      const transport = new StreamableHTTPClientTransport(new URL(this.url), { fetch: authedFetch(this.auth, this.retryUnauthorized) });
      transport.onclose = () => {
        if (this.client === c) this.client = null;
      };
      await c.connect(transport, { timeout: MCP_TIMEOUT_MS });
      this.client = c;
      return c;
    })();
    try {
      return await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  async close(): Promise<void> {
    const c = this.client;
    this.client = null;
    await c?.close().catch(() => undefined);
  }
}
