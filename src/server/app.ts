import { Hono, type Context } from 'hono';
import { auth as defaultAuth, AuthError, type IfoodAuth } from './auth.js';
import { CartError } from './cart/contracts.js';
import { CartService } from './cart/service.js';
import { registerCartRoutes } from './routes/cart.js';
import { botAuth, organizerOf } from './botAuth.js';
import { config as defaultConfig, mask, type AppConfig } from './config.js';
import { IfoodLinkService, LinkError, type SessionFactory } from './links/service.js';
import { realSessionFactory } from './links/session.js';
import { getMcpClient, resetMcpClient } from './mcp/client.js';
import { McpToolError } from './mcp/errors.js';
import { ALLOWED_TOOLS, listAddresses, searchOffers } from './mcp/tools.js';
import type { Address } from './mcp/types.js';
import { handleLinkCallback, registerBotRoutes, registerBrowserRoutes } from './routes/bot.js';
import { registerEvaluate } from './routes/evaluate.js';
import { registerConversationRoutes } from './routes/conversation.js';
import type { TurnRuntime } from './turns/runtime.js';
import { runEvaluation } from './services/evaluate.js';

type ErrStatus = 400 | 401 | 403 | 404 | 409 | 410 | 423 | 500 | 502 | 503;

export function errorBody(err: unknown): { status: ErrStatus; body: Record<string, unknown> } {
  if (err instanceof CartError) {
    return { status: err.status, body: { error: { kind: err.code, message: err.message, providerCode: err.providerCode ?? null, retryable: false }, purchaseAuthorized: false } };
  }
  if (err instanceof LinkError) {
    return { status: err.httpStatus, body: { error: { kind: err.code, message: err.message, state: err.state ?? null, reason: err.reason ?? null } } };
  }
  if (err instanceof McpToolError) {
    return {
      status: 502,
      body: { error: { kind: 'MCP_TOOL_ERROR', tool: err.tool, message: err.message, code: err.code ?? null, retryable: err.retryable, errors: err.errors } },
    };
  }
  if (err instanceof AuthError) {
    const status = err.code === 'LOGIN_REQUIRED' || err.status === 401 ? 401 : err.status === 400 ? 400 : 502;
    return { status, body: { error: { kind: 'AUTH_ERROR', code: err.code, message: err.message } } };
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

export interface AppOptions {
  config?: AppConfig;
  /** Serviço de vínculos (testes injetam um com sessões falsas). */
  links?: IfoodLinkService;
  sessionFactory?: SessionFactory;
  carts?: CartService;
  conversations?: TurnRuntime;
}

export function createApp(auth: IfoodAuth = defaultAuth, opts: AppOptions = {}) {
  const cfg = opts.config ?? defaultConfig;
  const links = opts.links ?? new IfoodLinkService({ cfg, sessionFactory: opts.sessionFactory ?? realSessionFactory });
  const app = new Hono();
  const carts = opts.carts ?? new CartService(links, cfg.cartEnabled);

  // Log mínimo: método, caminho (sem query — o callback OAuth carrega `code`), status, duração. Sem identidades.
  app.use('*', async (c, next) => {
    const t0 = Date.now();
    await next();
    const path = new URL(c.req.url).pathname;
    console.log(`${c.req.method} ${path.startsWith('/api/bot/v1/') ? '/api/bot/v1/[redigido]' : path} ${c.res.status} ${Date.now() - t0}ms`);
  });

  app.onError((err, c) => {
    const { status, body } = errorBody(err);
    if (status === 500) console.error('[error]', err instanceof Error ? err.message : err);
    return c.json(body, status);
  });

  // Liveness: sempre 200. linksStorage resume o armazenamento de vínculos sem caminhos nem identidades (OPS-01).
  app.get('/api/health', async (c) => c.json({ ok: true, linksStorage: await links.storageHealth() }));
  // Readiness para healthcheck do deploy: 503 se os vínculos não podem ser lidos ou se o disco é sabidamente efêmero.
  app.get('/api/health/ready', async (c) => {
    const storage = await links.storageHealth();
    const ready = storage.state !== 'UNAVAILABLE' && storage.acceptingNewLinks;
    return c.json({ ready, linksStorage: storage }, ready ? 200 : 503);
  });

  // ---------- Bot → API (autenticado; identidade do organizador vem do adaptador) ----------
  const requireBot = botAuth({ token: cfg.botApiToken, allowedOrganizerIds: cfg.allowedOrganizerIds, passwordAccess: cfg.botPasswordAccess });
  app.use('/api/bot/v1/*', async (c, next) => { c.header('Cache-Control', 'no-store'); await next(); });
  app.use('/api/bot/*', requireBot);
  app.use('/api/addresses', requireBot);
  app.use('/api/evaluate', requireBot);
  registerBotRoutes(app as unknown as Hono, links);
  registerCartRoutes(app, carts);
  registerConversationRoutes(app as unknown as Hono, opts.conversations, cfg.conversationRuntime?.botId);

  // ---------- Navegador: início do login e callback OAuth (redirect registrado: http://localhost:8000) ----------
  // Callback localhost ⇒ só conexões da própria máquina abrem o início/retorno do login (anti link encaminhado).
  const host = new URL(cfg.publicBaseUrl).hostname;
  const requireLoopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(host);
  registerBrowserRoutes(app as unknown as Hono, links, { requireLoopback });

  const devCallback = async (c: Context) => {
    const { code, state, error, error_description } = c.req.query();
    const back = new URL(cfg.webOrigin);
    if (error) {
      back.searchParams.set('auth', 'error');
      back.searchParams.set('reason', String(error_description ?? error).slice(0, 200));
      return c.redirect(back.toString());
    }
    try {
      await auth.handleCallback(code ?? '', state ?? '');
      await resetMcpClient();
      back.searchParams.set('auth', 'ok');
    } catch (e) {
      back.searchParams.set('auth', 'error');
      back.searchParams.set('reason', e instanceof Error ? e.message.slice(0, 200) : 'falha');
    }
    return c.redirect(back.toString());
  };
  const callback = async (c: Context) => {
    const q = c.req.query();
    if (!q.state && !q.code && !q.error) return null;
    const isDev = (s: string) => cfg.devGlobalSession && auth.hasPendingState(s);
    return (await handleLinkCallback(c, links, isDev, { requireLoopback })) ?? devCallback(c);
  };
  app.get('/callback', async (c) => (await callback(c)) ?? c.text('callback sem state', 400));
  app.get('/', async (c) => (await callback(c)) ?? c.redirect(cfg.webOrigin));

  // ---------- Operações da conta: só com vínculo confirmado e operacional ----------
  app.get('/api/addresses', async (c) =>
    c.json(
      await links.withOperational(organizerOf(c), 'ADDRESSES_READ', async (ctx) => {
        const { results } = await ctx.deps.listAddresses();
        return {
          linkId: ctx.linkId,
          addresses: (results ?? []).map((a) => ({
            addressId: a.addressId,
            alias: a.alias ?? null,
            formattedAddress: a.formattedAddress ?? null,
            isLastUsedAddress: a.isLastUsedAddress ?? null,
            isMostUsedAddress30d: a.isMostUsedAddress30d ?? null,
          })),
        };
      }),
    ),
  );
  registerEvaluate(app as unknown as Hono, (c, req) =>
    links.withOperational(organizerOf(c), 'OFFERS_EVALUATE', (ctx) => runEvaluation(req, ctx.deps, ctx.cache)),
  );

  // ---------- Diagnóstico (sem tokens, segredos, identidades ou endereço) ----------
  app.get('/api/diagnostics', async (c) => {
    const result: Record<string, unknown> = {
      config: {
        mcpUrl: cfg.mcpUrl,
        clientId: mask(cfg.clientId),
        clientSecretSet: Boolean(cfg.clientSecret),
        redirectUri: cfg.redirectUri,
        botApiConfigured: Boolean(cfg.botApiToken && (cfg.allowedOrganizerIds.length || cfg.botPasswordAccess)),
        allowedOrganizers: cfg.allowedOrganizerIds.length,
        devGlobalSession: cfg.devGlobalSession,
      },
      links: await links.summary(),
    };
    if (!cfg.devGlobalSession) return c.json(result);
    result.devAuth = await auth.status();
    const t0 = Date.now();
    try {
      const client = await getMcpClient(auth);
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      result.mcp = {
        connected: true,
        note: 'Lista de ferramentas não prova escopo nem sessão operacional.',
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

  // ---------- Sessão global de desenvolvimento (desligada por padrão; nunca vira vínculo Telegram) ----------
  if (cfg.devGlobalSession) {
    app.get('/api/auth/status', async (c) => c.json({ ...(await auth.status()), note: 'Sessão de desenvolvimento; token presente ≠ sessão operacional' }));
    app.get('/api/auth/login', async (c) => c.redirect(await auth.startLogin()));
    app.post('/api/auth/logout', async (c) => {
      await auth.logout();
      await resetMcpClient();
      return c.json({ ok: true });
    });
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
          merchantName: i.merchant?.merchantName ?? null,
          isOpen: i.merchant?.isOpen ?? null,
        })),
        note: 'Preços de listagem não são definitivos — usar getItem antes de recomendar.',
      });
    });
  }

  return app;
}
