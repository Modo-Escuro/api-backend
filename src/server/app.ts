import { Hono, type Context } from 'hono';
import { auth as defaultAuth, AuthError, type IfoodAuth } from './auth.js';
import { config, mask } from './config.js';
import { getMcpClient, resetMcpClient } from './mcp/client.js';
import { McpToolError } from './mcp/errors.js';
import { ALLOWED_TOOLS, listAddresses, searchOffers } from './mcp/tools.js';
import type { Address } from './mcp/types.js';

export function errorBody(err: unknown): { status: 401 | 400 | 502 | 500; body: Record<string, unknown> } {
  if (err instanceof McpToolError) {
    return {
      status: 502,
      body: { error: { kind: 'MCP_TOOL_ERROR', tool: err.tool, message: err.message, code: err.code ?? null, retryable: err.retryable, errors: err.errors } },
    };
  }
  if (err instanceof AuthError) {
    const status = err.code === 'LOGIN_REQUIRED' || err.status === 401 ? 401 : err.status === 400 ? 400 : 502;
    return { status, body: { error: { kind: 'AUTH_ERROR', code: err.code, message: err.message, loginUrl: '/api/auth/login' } } };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { status: 500, body: { error: { kind: 'INTERNAL', message } } };
}

/** Escolhe o endereço: id explícito (precisa existir na lista) ou único. Nunca inventa. */
export function pickAddress(addresses: Address[], addressId?: string): Address | { error: string } {
  if (addressId) return addresses.find((a) => a.addressId === addressId) ?? { error: 'addressId não pertence à lista retornada por listAddresses' };
  if (addresses.length === 1) return addresses[0]!;
  if (addresses.length === 0) return { error: 'Nenhum endereço salvo na conta iFood' };
  return { error: 'Múltiplos endereços: informe addressId' };
}

export function createApp(auth: IfoodAuth = defaultAuth) {
  const app = new Hono();

  // Log mínimo: método, caminho (sem query — o callback OAuth carrega `code`), status, duração.
  app.use('*', async (c, next) => {
    const t0 = Date.now();
    await next();
    console.log(`${c.req.method} ${new URL(c.req.url).pathname} ${c.res.status} ${Date.now() - t0}ms`);
  });

  app.onError((err, c) => {
    const { status, body } = errorBody(err);
    if (status === 500) console.error('[error]', err instanceof Error ? err.message : err);
    return c.json(body, status);
  });

  app.get('/api/health', (c) => c.json({ ok: true }));

  // ---------- OAuth ----------
  app.get('/api/auth/status', async (c) => c.json(await auth.status()));
  app.get('/api/auth/login', async (c) => c.redirect(await auth.startLogin()));
  app.post('/api/auth/logout', async (c) => {
    await auth.logout();
    await resetMcpClient();
    return c.json({ ok: true });
  });

  const callback = async (c: Context) => {
    const { code, state, error, error_description } = c.req.query();
    const back = new URL(config.webOrigin);
    if (error) {
      back.searchParams.set('auth', 'error');
      back.searchParams.set('reason', String(error_description ?? error).slice(0, 200));
      return c.redirect(back.toString());
    }
    if (!code || !state) return null;
    try {
      await auth.handleCallback(code, state);
      await resetMcpClient();
      back.searchParams.set('auth', 'ok');
    } catch (e) {
      back.searchParams.set('auth', 'error');
      back.searchParams.set('reason', e instanceof Error ? e.message.slice(0, 200) : 'falha');
    }
    return c.redirect(back.toString());
  };
  // O redirect registrado no client é a raiz (http://localhost:8000); /callback também é aceito.
  app.get('/callback', async (c) => (await callback(c)) ?? c.text('callback sem code/state', 400));
  app.get('/', async (c) => (await callback(c)) ?? c.redirect(config.webOrigin));

  // ---------- Diagnóstico (nunca retorna tokens, segredos ou endereço) ----------
  app.get('/api/diagnostics', async (c) => {
    const authStatus = await auth.status();
    const result: Record<string, unknown> = {
      config: {
        mcpUrl: config.mcpUrl,
        clientId: mask(config.clientId),
        clientSecretSet: Boolean(config.clientSecret),
        redirectUri: config.redirectUri,
      },
      auth: authStatus,
    };
    const t0 = Date.now();
    try {
      const client = await getMcpClient(auth);
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      result.mcp = {
        connected: true,
        server: client.getServerVersion()?.name ?? null,
        serverVersion: client.getServerVersion()?.version ?? null,
        toolCount: names.length,
        tools: names,
        mvpToolsAvailable: [...ALLOWED_TOOLS].filter((n) => names.includes(n)),
        mvpToolsMissing: [...ALLOWED_TOOLS].filter((n) => !names.includes(n)),
        latencyMs: Date.now() - t0,
      };
    } catch (e) {
      result.mcp = { connected: false, latencyMs: Date.now() - t0, ...errorBody(e).body };
    }
    return c.json(result);
  });

  /** Teste de busca real ponta a ponta: listAddresses → searchOffers(ITEM). */
  app.get('/api/diagnostics/search', async (c) => {
    const query = c.req.query('q') || 'pizza';
    const { results: addresses } = await listAddresses();
    const addr = pickAddress(addresses ?? [], c.req.query('addressId'));
    if ('error' in addr) return c.json({ error: { kind: 'ADDRESS', message: addr.error }, addressCount: addresses?.length ?? 0 }, 400);
    if (!addr.coordinates) return c.json({ error: { kind: 'ADDRESS', message: 'Endereço sem coordinates no MCP' } }, 400);
    const t0 = Date.now();
    const r = await searchOffers({ query, userLocation: addr.coordinates, resultKind: 'ITEM', pageSize: 5 });
    return c.json({
      query,
      interpretedQuery: r.interpretedQuery ?? null,
      addressCount: addresses.length,
      latencyMs: Date.now() - t0,
      hasMore: r.hasMore ?? null,
      resultCount: r.results?.length ?? 0,
      sample: (r.results ?? []).map((i) => ({
        itemId: i.itemId,
        itemName: i.itemName ?? null,
        unitPrice: i.unitPrice ?? null,
        promotionalUnitPrice: i.promotionalUnitPrice ?? null,
        merchantId: i.merchant?.merchantId ?? null,
        merchantName: i.merchant?.merchantName ?? null,
        isOpen: i.merchant?.isOpen ?? null,
      })),
      note: 'Preços de listagem não são definitivos — usar getItem antes de recomendar.',
    });
  });

  // ---------- Endereços (FR-2) ----------
  app.get('/api/addresses', async (c) => {
    const { results } = await listAddresses();
    return c.json({
      addresses: (results ?? []).map((a) => ({
        addressId: a.addressId,
        alias: a.alias ?? null,
        formattedAddress: a.formattedAddress ?? null,
        isLastUsedAddress: a.isLastUsedAddress ?? null,
        isMostUsedAddress30d: a.isMostUsedAddress30d ?? null,
      })),
    });
  });

  return app;
}
