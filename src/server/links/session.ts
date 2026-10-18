// Sessão MCP real de um vínculo: cliente MCP próprio + wrappers de leitura ligados a ele.
import type { IfoodAuth } from '../auth.js';
import { cartGateway } from '../mcp/cart.js';
import { McpSession } from '../mcp/client.js';
import { getItem, getUser, listAddresses, searchOffers } from '../mcp/tools.js';
import type { LinkMcpSession } from './service.js';

export function realSessionFactory(auth: IfoodAuth): LinkMcpSession {
  const s = new McpSession(auth);
  const cartSession = new McpSession(auth, undefined, false);
  return {
    cart: cartGateway(() => cartSession.getClient()),
    deps: {
      listAddresses: async () => listAddresses(await s.getClient()),
      searchOffers: async (args, opts) => searchOffers(args, await s.getClient(), opts),
      getItem: async (args, opts) => getItem(args, await s.getClient(), opts),
    },
    getUser: async () => getUser(await s.getClient(), { timeoutMs: 10_000 }),
    close: async () => { await Promise.all([s.close(), cartSession.close()]); },
  };
}
