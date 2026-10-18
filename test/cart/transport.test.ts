import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IfoodAuth } from '../../src/server/auth';
import { McpSession } from '../../src/server/mcp/client';

const captured = vi.hoisted(() => ({ fetch: null as typeof fetch | null }));
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({ Client: class {
  async connect() {}
  async close() {}
} }));
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({ StreamableHTTPClientTransport: class {
  constructor(_url: URL, options: { fetch: typeof fetch }) { captured.fetch = options.fetch; }
} }));
afterEach(() => vi.unstubAllGlobals());

describe('transporte exclusivo de carrinho', () => {
  it('não repete uma requisição que recebeu 401, mesmo tendo refresh token', async () => {
    const network = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));
    vi.stubGlobal('fetch', network);
    const auth = { getAccessToken: vi.fn().mockResolvedValue('token-do-vínculo'), refresh: vi.fn() };
    const session = new McpSession(auth as unknown as IfoodAuth, 'https://mcp.test', false);
    await session.getClient();
    const response = await captured.fetch!('https://mcp.test', { method: 'POST', body: 'mutação-sintética' });
    expect(response.status).toBe(401);
    expect(network).toHaveBeenCalledTimes(1);
    expect(auth.refresh).not.toHaveBeenCalled();
  });
  it('preserva o comportamento anterior das sessões de leitura', async () => {
    const network = vi.fn().mockResolvedValueOnce(new Response(null, { status: 401 })).mockResolvedValueOnce(new Response('{}'));
    vi.stubGlobal('fetch', network);
    const auth = { getAccessToken: vi.fn().mockResolvedValue('expirado'), refresh: vi.fn().mockResolvedValue({ accessToken: 'renovado' }) };
    await new McpSession(auth as unknown as IfoodAuth, 'https://mcp.test').getClient();
    expect((await captured.fetch!('https://mcp.test')).status).toBe(200);
    expect(network).toHaveBeenCalledTimes(2);
    expect(auth.refresh).toHaveBeenCalledTimes(1);
  });
});
