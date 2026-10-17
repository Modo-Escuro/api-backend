// Cliente MCP (Streamable HTTP) independente de Claude Code/OpenCode.
// Injeta Bearer via fetch customizado; em 401 tenta refresh uma vez.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { auth as defaultAuth, type IfoodAuth } from '../auth.js';
import { config } from '../config.js';

export const MCP_TIMEOUT_MS = 15_000;

function authedFetch(auth: IfoodAuth): typeof fetch {
  return async (input, init) => {
    const send = async (token: string) => {
      const headers = new Headers(init?.headers);
      headers.set('Authorization', `Bearer ${token}`);
      return fetch(input, { ...init, headers });
    };
    const res = await send(await auth.getAccessToken());
    if (res.status !== 401) return res;
    // Token rejeitado: renova e tenta de novo uma única vez.
    const t = await auth.refresh();
    return send(t.accessToken);
  };
}

let client: Client | null = null;
let connecting: Promise<Client> | null = null;

export async function getMcpClient(auth: IfoodAuth = defaultAuth): Promise<Client> {
  if (client) return client;
  if (connecting) return connecting;
  connecting = (async () => {
    const c = new Client({ name: 'compra-com-contexto', version: '0.1.0' });
    const transport = new StreamableHTTPClientTransport(new URL(config.mcpUrl), { fetch: authedFetch(auth) });
    transport.onclose = () => {
      if (client === c) client = null;
    };
    await c.connect(transport, { timeout: MCP_TIMEOUT_MS });
    client = c;
    return c;
  })();
  try {
    return await connecting;
  } finally {
    connecting = null;
  }
}

export async function resetMcpClient(): Promise<void> {
  const c = client;
  client = null;
  await c?.close().catch(() => undefined);
}
