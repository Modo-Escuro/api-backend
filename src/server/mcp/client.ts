// Cliente MCP (Streamable HTTP) independente de Claude Code/OpenCode.
// Uma McpSession = um cliente MCP ligado a UM IfoodAuth (um conjunto de tokens). Sessões de
// vínculos diferentes nunca compartilham cliente, sessão HTTP ou token.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { auth as defaultAuth, type IfoodAuth } from '../auth.js';
import { config } from '../config.js';

export const MCP_TIMEOUT_MS = 15_000;

/** Injeta Bearer; em 401 tenta refresh uma vez e repete. */
function authedFetch(auth: IfoodAuth): typeof fetch {
  return async (input, init) => {
    const send = async (token: string) => {
      const headers = new Headers(init?.headers);
      headers.set('Authorization', `Bearer ${token}`);
      return fetch(input, { ...init, headers });
    };
    const res = await send(await auth.getAccessToken());
    if (res.status !== 401) return res;
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
  ) {}

  async getClient(): Promise<Client> {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const c = new Client({ name: 'compra-com-contexto', version: '0.1.0' });
      const transport = new StreamableHTTPClientTransport(new URL(this.url), { fetch: authedFetch(this.auth) });
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

// ---- sessão global (somente login de desenvolvimento / scripts; nunca usada pelas rotas do bot)
const globalSession = new McpSession(defaultAuth);

export async function getMcpClient(auth: IfoodAuth = defaultAuth): Promise<Client> {
  if (auth === defaultAuth) return globalSession.getClient();
  // Chamadas legadas com outro auth: sessão descartável própria.
  return new McpSession(auth).getClient();
}

export async function resetMcpClient(): Promise<void> {
  await globalSession.close();
}
