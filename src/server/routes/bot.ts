// Rotas do vínculo Telegram↔iFood (exigem botAuth) e rotas públicas do navegador (início + callback).
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { organizerOf } from '../botAuth.js';
import type { IfoodLinkService } from '../links/service.js';

const ConfirmBody = z.object({ attemptId: z.string().min(10).max(100), verificationCode: z.string().min(4).max(20) }).strict();

export function registerBotRoutes(app: Hono, links: IfoodLinkService) {
  app.get('/api/bot/ifood/status', async (c) => c.json(await links.status(organizerOf(c))));

  app.post('/api/bot/ifood/connect', async (c) => {
    const r = await links.connect(organizerOf(c));
    return c.json({ ...r.status, authorizationUrl: r.authorizationUrl, attemptExpiresAt: r.expiresAt }, 201);
  });

  app.post('/api/bot/ifood/confirm', async (c) => {
    let json: unknown;
    try {
      json = await c.req.json();
    } catch {
      return c.json({ error: { kind: 'VALIDATION', message: 'Corpo deve ser JSON' } }, 400);
    }
    const parsed = ConfirmBody.safeParse(json);
    if (!parsed.success) return c.json({ error: { kind: 'VALIDATION', message: 'Informe attemptId e verificationCode' } }, 400);
    const r = await links.confirm(organizerOf(c), parsed.data.attemptId, parsed.data.verificationCode);
    return c.json({ ...r.status, previousLinkId: r.previousLinkId });
  });

  app.post('/api/bot/ifood/verify', async (c) => c.json(await links.verify(organizerOf(c))));

  app.delete('/api/bot/ifood/link', async (c) => {
    const r = await links.disconnect(organizerOf(c));
    return c.json({ ...r.status, providerRevocation: r.providerRevocation });
  });
}

// ---------- páginas mínimas do navegador (sem recursos externos, sem dados da conta) ----------
const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

export function browserPage(c: Context, status: 200 | 400 | 404 | 410 | 503, title: string, body: string) {
  c.header('Cache-Control', 'no-store');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'");
  return c.html(
    `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>${esc(title)}</title><style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;color:#222}` +
      `code{font-size:2rem;letter-spacing:.2rem;background:#f3f3f3;padding:.3rem .6rem;border-radius:6px}</style></head>` +
      // Remove o `code` OAuth do histórico/URL visível.
      `<body><script>history.replaceState(null,'',location.pathname)</script><h1>${esc(title)}</h1>${body}</body></html>`,
    status,
  );
}

export function registerBrowserRoutes(app: Hono, links: IfoodLinkService) {
  app.get('/auth/ifood/start', async (c) => {
    const a = c.req.query('a') ?? '';
    const t = c.req.query('t') ?? '';
    try {
      return c.redirect(await links.startAuthorization(a, t));
    } catch (e) {
      const err = e as { httpStatus?: number; message?: string };
      const status = (err.httpStatus === 404 || err.httpStatus === 410 || err.httpStatus === 503 ? err.httpStatus : 400) as 400 | 404 | 410 | 503;
      return browserPage(c, status, 'Não foi possível iniciar', `<p>${esc(err.message ?? 'Erro')}</p>`);
    }
  });
}

/** Trata o callback de vínculo. Retorna null se o state não pertence a nenhuma tentativa de vínculo. */
export async function handleLinkCallback(c: Context, links: IfoodLinkService, isLegacyState: (state: string) => boolean) {
  const { state, code, error } = c.req.query();
  if (state && isLegacyState(state)) return null;
  try {
    const r = await links.handleCallback({ state, code, error });
    return browserPage(
      c,
      200,
      'Autorização recebida',
      `<p>Volte à conversa com o bot no Telegram e envie este código de verificação:</p><p><code>${esc(r.verificationCode)}</code></p>` +
        `<p>Ele vale até ${esc(new Date(r.expiresAt).toLocaleTimeString('pt-BR'))}. Se você não iniciou esta conexão, apenas feche esta página.</p>` +
        `<p>Este login não aprova nenhuma compra.</p>`,
    );
  } catch (e) {
    const err = e as { httpStatus?: number; message?: string };
    const status = (err.httpStatus === 410 || err.httpStatus === 503 ? err.httpStatus : 400) as 400 | 410 | 503;
    return browserPage(c, status, 'Autorização não concluída', `<p>${esc(err.message ?? 'Erro')}</p>`);
  }
}
