import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/server/app';
import { loadConfig } from '../../src/server/config';
import { IfoodLinkService } from '../../src/server/links/service';
import { BOT_TOKEN, ORG_A, ORG_B, connectAndConfirm, setup } from '../helpers/fakes';

describe('usuários da demo autenticados por senha no adaptador', () => {
  function env(publicAccess = true) {
    const e = setup({ allowedOrganizerIds: [], botPasswordAccess: publicAccess });
    const app = createApp({ config: e.cfg, links: e.links });
    return { ...e, app };
  }
  const headers = (id: string) => ({ authorization: `Bearer ${BOT_TOKEN}`, 'x-telegram-user-id': id, 'x-telegram-access': 'PASSWORD' });

  it('opt-in não aceita acesso anônimo, senha no corpo nem apenas ID', async () => {
    const e = env();
    const route = '/api/bot/ifood/status';
    expect((await e.app.request(route, { headers: { 'x-telegram-user-id': ORG_A, 'x-telegram-access': 'PASSWORD' } })).status).toBe(401);
    expect((await e.app.request(route, { headers: { authorization: `Bearer ${BOT_TOKEN}`, 'x-telegram-user-id': ORG_A } })).status).toBe(403);
    expect((await e.app.request(route, { headers: headers('invalid') })).status).toBe(400);
    expect((await e.app.request(route, { headers: headers(ORG_A) })).status).toBe(200);
  });
  it('padrão fechado preserva allowlist e exige serviço configurado', async () => {
    const e = env(false);
    expect((await e.app.request('/api/bot/ifood/status', { headers: headers(ORG_A) })).status).toBe(503);
    const configured = setup({ allowedOrganizerIds: [ORG_A], botPasswordAccess: false });
    const app = createApp({ config: configured.cfg, links: configured.links });
    expect((await app.request('/api/bot/ifood/status', { headers: headers(ORG_B) })).status).toBe(403);
    expect((await app.request('/api/bot/ifood/status', { headers: headers(ORG_A) })).status).toBe(200);
  });
  it('duas contas mantêm vínculos distintos e são recarregadas após reinício', async () => {
    const e = env();
    const a = await connectAndConfirm(e, ORG_A);
    const b = await connectAndConfirm(e, ORG_B);
    const after = new IfoodLinkService({ cfg: e.cfg, sessionFactory: e.mcp.factory, fetchImpl: e.as.fetch, now: e.clock.now });
    expect((await after.status(ORG_A)).linkId).toBe(a.status.linkId);
    expect((await after.status(ORG_B)).linkId).toBe(b.status.linkId);
    expect(a.status.linkId).not.toBe(b.status.linkId);
    await after.disconnect(ORG_A);
    expect((await after.status(ORG_B)).linkId).toBe(b.status.linkId);
  });
  it('flag estrita e desligada por padrão', () => {
    expect(loadConfig({}).botPasswordAccess).toBe(false);
    expect(loadConfig({ BOT_PASSWORD_ACCESS_ENABLED: 'true' }).botPasswordAccess).toBe(true);
    expect(() => loadConfig({ BOT_PASSWORD_ACCESS_ENABLED: 'TRUE' })).toThrow('BOT_PASSWORD_ACCESS_ENABLED');
  });
});
