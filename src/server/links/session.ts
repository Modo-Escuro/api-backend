// Sessão MCP real de um vínculo: cliente MCP próprio + wrappers de leitura ligados a ele.
import type { IfoodAuth } from '../auth.js';
import { McpSession } from '../mcp/client.js';
import { getItem, listAddresses, searchOffers } from '../mcp/tools.js';
import type { LinkMcpSession } from './service.js';

export function realSessionFactory(auth: IfoodAuth): LinkMcpSession {
  const s = new McpSession(auth);
  return {
    deps: {
      listAddresses: async () => listAddresses(await s.getClient()),
      searchOffers: async (args, opts) => searchOffers(args, await s.getClient(), opts),
      getItem: async (args, opts) => getItem(args, await s.getClient(), opts),
    },
    close: () => s.close(),
  };
}
