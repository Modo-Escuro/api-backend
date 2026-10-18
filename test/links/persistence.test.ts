// OPS-01: persistência durável dos vínculos — reinício, rotação de refresh token, arquivos inválidos (fail closed),
// gravação interrompida, falha de disco, concorrência, disco efêmero e endpoints de saúde.
import { chmodSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/server/app';
import { IfoodAuth, type StoredTokens } from '../../src/server/auth';
import { resolveLinksStorage, type AppConfig } from '../../src/server/config';
import { IfoodLinkService } from '../../src/server/links/service';
import { LinkStore, type LinkRecord } from '../../src/server/links/store';
import { ORG_A, ORG_B, connectAndConfirm, setup } from '../helpers/fakes';

const POSIX = process.platform !== 'win32';
const ROOT = typeof process.getuid === 'function' && process.getuid() === 0;
/** chmod não bloqueia root nem funciona assim no Windows. */
const itPerm = POSIX && !ROOT ? it : it.skip;

const restore: string[] = [];
afterEach(() => {
  for (const p of restore.splice(0)) {
    try {
      chmodSync(p, 0o700);
    } catch {
      /* já removido */
    }
  }
});

type Env = ReturnType<typeof setup>;
const restart = (env: Env, cfg: AppConfig = env.cfg) =>
  new IfoodLinkService({ cfg, sessionFactory: env.mcp.factory, fetchImpl: env.as.fetch, now: env.clock.now });
const linksFile = (env: Env) => join(env.cfg.linksDir, 'links.json');
const tokenFile = (env: Env, linkId: string) => join(env.cfg.linksDir, `${linkId}.tokens.json`);
const readTokens = (env: Env, linkId: string) => JSON.parse(readFileSync(tokenFile(env, linkId), 'utf8')) as StoredTokens;
const tmpFiles = (dir: string) => readdirSync(dir).filter((f) => f.endsWith('.tmp'));
const ephemeral = (cfg: AppConfig, allowEphemeral = false): AppConfig => ({
  ...cfg,
  linksStorage: { durability: 'EPHEMERAL', platform: 'RAILWAY', explicitDir: true, allowEphemeral },
});

describe('reinício e recuperação', () => {
  it('vínculo confirmado sobrevive ao reinício, associado ao mesmo organizador, e volta a operar após verificação', async () => {
    const env = setup();
    const a = await connectAndConfirm(env, ORG_A);
    const b = await connectAndConfirm(env, ORG_B);

    const after = restart(env);
    const sa = await after.status(ORG_A);
    const sb = await after.status(ORG_B);
    expect(sa).toMatchObject({ state: 'CONNECTED', linkId: a.status.linkId, operational: false, reason: 'VERIFICATION_PENDING' });
    expect(sb.linkId).toBe(b.status.linkId);
    expect(sa.linkId).not.toBe(sb.linkId);
    expect(await after.verify(ORG_A)).toMatchObject({ state: 'CONNECTED', operational: true });
    expect((await after.withOperational(ORG_A, 'ADDRESSES_READ', (ctx) => ctx.deps.listAddresses())).results).toHaveLength(1);
  });

  it('refresh token rotacionado é gravado e usado depois do reinício', async () => {
    const env = setup();
    const r = await connectAndConfirm(env, ORG_A);
    const linkId = r.status.linkId!;
    const before = readTokens(env, linkId).refreshToken;

    env.clock.advance(2 * 3600_000); // access token vencido ⇒ refresh
    await env.links.verify(ORG_A);
    const rotated = readTokens(env, linkId).refreshToken;
    expect(rotated).not.toBe(before);

    env.clock.advance(2 * 3600_000);
    const after = restart(env);
    await after.verify(ORG_A);
    const lastRefresh = env.as.calls.filter((c) => c.body.get('grant_type') === 'refresh_token').at(-1)!;
    expect(lastRefresh.body.get('refresh_token')).toBe(rotated); // nunca o refresh token já rotacionado
    expect(await after.status(ORG_A)).toMatchObject({ state: 'CONNECTED', operational: true });
  });

  it('organizador fora da allowlist não é carregado, mas seu registro continua no disco após nova gravação', async () => {
    const env = setup();
    await connectAndConfirm(env, ORG_A);
    const b = await connectAndConfirm(env, ORG_B);
    const onlyA = restart(env, { ...env.cfg, allowedOrganizerIds: [ORG_A] });
    expect((await onlyA.status(ORG_B)).state).toBe('DISCONNECTED');
    await onlyA.disconnect(ORG_A); // força gravação do links.json
    const back = restart(env);
    expect((await back.status(ORG_B)).linkId).toBe(b.status.linkId);
  });

  it('arquivo de tokens ausente ⇒ RECONNECT_REQUIRED (TOKENS_MISSING), sem apagar o registro', async () => {
    const env = setup();
    const r = await connectAndConfirm(env, ORG_A);
    writeFileSync(tokenFile(env, r.status.linkId!), ''); // simula perda: arquivo vazio/corrompido
    const after = restart(env);
    expect(await after.status(ORG_A)).toMatchObject({ state: 'RECONNECT_REQUIRED', reason: 'TOKENS_MISSING', linkId: r.status.linkId });
    expect(JSON.parse(readFileSync(linksFile(env), 'utf8')).links[ORG_A].linkId).toBe(r.status.linkId);
  });
});

describe('links.json inválido: falha fechada, sem sobrescrever', () => {
  const cases: [string, string][] = [
    ['JSON corrompido', '{"version":1,"links":{'],
    ['versão desconhecida', JSON.stringify({ version: 2, links: {} })],
    ['registro sem campos obrigatórios', JSON.stringify({ version: 1, links: { [ORG_A]: { linkId: 'x' } } })],
    [
      'tokenFileName com caminho (traversal)',
      JSON.stringify({
        version: 1,
        links: { [ORG_A]: { linkId: 'x', organizerId: ORG_A, confirmedAt: 1, tokenFileName: '../fora.tokens.json', reconnectReason: null } },
      }),
    ],
    [
      'chave diferente do organizerId',
      JSON.stringify({
        version: 1,
        links: { [ORG_A]: { linkId: 'x', organizerId: ORG_B, confirmedAt: 1, tokenFileName: 'x.tokens.json', reconnectReason: null } },
      }),
    ],
  ];

  it.each(cases)('%s ⇒ 503 LINK_STORAGE_UNAVAILABLE em status/connect; arquivo intacto', async (_name, content) => {
    const env = setup();
    writeFileSync(linksFile(env), content, { mode: 0o600 });
    const svc = restart(env);
    await expect(svc.status(ORG_A)).rejects.toMatchObject({ code: 'LINK_STORAGE_UNAVAILABLE', httpStatus: 503 });
    await expect(svc.connect(ORG_A)).rejects.toMatchObject({ code: 'LINK_STORAGE_UNAVAILABLE' });
    expect(readFileSync(linksFile(env), 'utf8')).toBe(content);
  });

  it('depois de corrigir o arquivo, a próxima chamada carrega sem reiniciar o processo', async () => {
    const env = setup();
    const r = await connectAndConfirm(env, ORG_A);
    const good = readFileSync(linksFile(env), 'utf8');
    writeFileSync(linksFile(env), 'lixo');
    const svc = restart(env);
    await expect(svc.status(ORG_A)).rejects.toMatchObject({ code: 'LINK_STORAGE_UNAVAILABLE' });
    writeFileSync(linksFile(env), good);
    expect((await svc.status(ORG_A)).linkId).toBe(r.status.linkId);
  });

  itPerm('links.json sem permissão de leitura ⇒ 503, nada gravado', async () => {
    const env = setup();
    await connectAndConfirm(env, ORG_A);
    const before = readFileSync(linksFile(env), 'utf8');
    chmodSync(linksFile(env), 0o000);
    try {
      const svc = restart(env);
      await expect(svc.status(ORG_A)).rejects.toMatchObject({ code: 'LINK_STORAGE_UNAVAILABLE' });
    } finally {
      chmodSync(linksFile(env), 0o600);
    }
    expect(readFileSync(linksFile(env), 'utf8')).toBe(before);
  });

  it('mensagem de erro não expõe caminho nem conteúdo', async () => {
    const env = setup();
    writeFileSync(linksFile(env), 'segredo-nao-vazar');
    const err = await restart(env).status(ORG_A).catch((e) => e);
    expect(JSON.stringify({ m: err.message, c: err.code })).not.toMatch(/segredo|links-|\//);
  });
});

describe('gravação durável', () => {
  it('temporários órfãos de uma queda são removidos e o estado anterior permanece válido', async () => {
    const env = setup();
    const r = await connectAndConfirm(env, ORG_A);
    writeFileSync(join(env.cfg.linksDir, '.links.json.4242.0123456789ab.tmp'), '{"truncado');
    writeFileSync(join(env.cfg.linksDir, 'links.json.4242.tmp'), '{"formato antigo');
    const after = restart(env);
    expect((await after.status(ORG_A)).linkId).toBe(r.status.linkId);
    expect(tmpFiles(env.cfg.linksDir)).toEqual([]);
  });

  it('gravações não deixam temporários e mantêm 600', async () => {
    const env = setup();
    const r = await connectAndConfirm(env, ORG_A);
    env.clock.advance(2 * 3600_000);
    await env.links.verify(ORG_A); // regrava tokens
    expect(tmpFiles(env.cfg.linksDir)).toEqual([]);
    if (POSIX) {
      expect(statSync(linksFile(env)).mode & 0o777).toBe(0o600);
      expect(statSync(tokenFile(env, r.status.linkId!)).mode & 0o777).toBe(0o600);
    }
  });

  it('20 gravações concorrentes do LinkStore: arquivo final é a última, íntegro', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'links-conc-'));
    const store = new LinkStore(dir);
    const rec = (i: number): Record<string, LinkRecord> => ({
      [ORG_A]: { linkId: `l${i}`, organizerId: ORG_A, confirmedAt: i, tokenFileName: `l${i}.tokens.json`, reconnectReason: null },
    });
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.save(rec(i))));
    expect((await store.load())[ORG_A]!.linkId).toBe('l19');
    expect(tmpFiles(dir)).toEqual([]);
  });

  it('logout enfileirado depois de uma gravação não deixa o arquivo de tokens recriado', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tok-order-'));
    const file = join(dir, 'x.tokens.json');
    const env = setup();
    const auth = new IfoodAuth(env.cfg, env.as.fetch, { tokenFile: file });
    const t: StoredTokens = { clientId: 'cid', accessToken: 'at', refreshToken: 'rt', expiresAt: null, scope: null, source: 't', obtainedAt: 0 };
    const p1 = auth.setTokens(t);
    const p2 = auth.logout();
    await Promise.all([p1, p2]);
    expect(existsSync(file)).toBe(false);
  });

  itPerm('falha de disco no refresh: operação segue, estado DEGRADED, e a gravação é refeita quando o disco volta', async () => {
    const env = setup();
    const r = await connectAndConfirm(env, ORG_A);
    const linkId = r.status.linkId!;
    const onDisk = readTokens(env, linkId).refreshToken;

    chmodSync(env.cfg.linksDir, 0o500); // sem escrita: não dá para criar o temporário
    restore.push(env.cfg.linksDir);
    env.clock.advance(2 * 3600_000);
    expect(await env.links.verify(ORG_A)).toMatchObject({ state: 'CONNECTED', operational: true });
    expect(readTokens(env, linkId).refreshToken).toBe(onDisk); // disco ainda com o antigo
    expect(await env.links.storageHealth()).toMatchObject({ state: 'DEGRADED', unpersistedLinks: 1 });

    chmodSync(env.cfg.linksDir, 0o700);
    await env.links.verify(ORG_A); // próximo uso do token refaz a gravação pendente
    expect(readTokens(env, linkId).refreshToken).not.toBe(onDisk);
    expect(await env.links.storageHealth()).toMatchObject({ state: 'OK', unpersistedLinks: 0 });
  });
  // Falha de disco na confirmação (rollback + reinício com o vínculo anterior): coberto em storage.test.ts.
});

describe('disco efêmero', () => {
  it('EPHEMERAL sem opt-in recusa novas conexões antes do OAuth', async () => {
    const env = setup();
    const svc = restart(env, ephemeral(env.cfg));
    await expect(svc.connect(ORG_A)).rejects.toMatchObject({ code: 'LINK_STORAGE_NOT_DURABLE', httpStatus: 503 });
    expect(env.as.calls).toHaveLength(0);
  });

  it('EPHEMERAL não impede ler vínculos que existem; IFOOD_LINKS_ALLOW_EPHEMERAL=true aceita novos', async () => {
    const env = setup();
    const r = await connectAndConfirm(env, ORG_A);
    expect((await restart(env, ephemeral(env.cfg)).status(ORG_A)).linkId).toBe(r.status.linkId);
    const allowed = restart(env, ephemeral(env.cfg, true));
    await expect(allowed.connect(ORG_B)).resolves.toMatchObject({ attemptId: expect.any(String) });
  });

  it.each([
    [{ RAILWAY_ENVIRONMENT: 'production' }, 'EPHEMERAL', 'RAILWAY'],
    [{ RAILWAY_ENVIRONMENT: 'production', RAILWAY_VOLUME_MOUNT_PATH: '/data' }, 'VOLUME', 'RAILWAY'],
    [{ RAILWAY_ENVIRONMENT: 'production', RAILWAY_VOLUME_MOUNT_PATH: '/data', IFOOD_LINKS_DIR: '/data/ifood-links' }, 'VOLUME', 'RAILWAY'],
    [{ RAILWAY_ENVIRONMENT: 'production', RAILWAY_VOLUME_MOUNT_PATH: '/data', IFOOD_LINKS_DIR: '.ifood-links' }, 'EPHEMERAL', 'RAILWAY'],
    [{ RAILWAY_ENVIRONMENT: 'production', RAILWAY_VOLUME_MOUNT_PATH: '/data', IFOOD_LINKS_DIR: '/database/x' }, 'EPHEMERAL', 'RAILWAY'],
    [{ VERCEL: '1', IFOOD_LINKS_DIR: '/tmp/links' }, 'EPHEMERAL', 'VERCEL'],
    [{ NODE_ENV: 'production', IFOOD_LINKS_DIR: '/srv/links' }, 'UNVERIFIED', 'OTHER'],
    [{}, 'LOCAL_DEV', 'LOCAL'],
  ] as const)('%j ⇒ %s', (env, durability, platform) => {
    const r = resolveLinksStorage(env as NodeJS.ProcessEnv);
    expect(r.storage).toMatchObject({ durability, platform });
  });

  it('sem IFOOD_LINKS_DIR e com volume Railway, o padrão fica dentro do volume', () => {
    const r = resolveLinksStorage({ RAILWAY_ENVIRONMENT: 'production', RAILWAY_VOLUME_MOUNT_PATH: '/data' });
    expect(r.dir).toBe(join('/data', 'ifood-links'));
    expect(r.storage.explicitDir).toBe(false);
  });
});

describe('endpoints de saúde', () => {
  const mkApp = (env: Env, cfg: AppConfig = env.cfg) => {
    const links = restart(env, cfg);
    return createApp(new IfoodAuth(cfg, env.as.fetch, { tokenFile: null }), { config: cfg, links });
  };

  it('/api/health resume o armazenamento sem caminhos; /ready é 200 em disco local', async () => {
    const env = setup();
    const app = mkApp(env);
    const h = await app.request('/api/health');
    expect(h.status).toBe(200);
    const body = await h.json();
    expect(body).toMatchObject({ ok: true, linksStorage: { state: 'OK', durability: 'LOCAL_DEV', acceptingNewLinks: true } });
    expect(JSON.stringify(body)).not.toContain(env.cfg.linksDir);
    expect((await app.request('/api/health/ready')).status).toBe(200);
  });

  it('/ready é 503 em disco efêmero e com links.json corrompido; /api/health continua 200', async () => {
    const env = setup();
    expect((await mkApp(env, ephemeral(env.cfg)).request('/api/health/ready')).status).toBe(503);
    writeFileSync(linksFile(env), 'x');
    const app = mkApp(env);
    const ready = await app.request('/api/health/ready');
    expect(ready.status).toBe(503);
    expect(await ready.json()).toMatchObject({ ready: false, linksStorage: { state: 'UNAVAILABLE' } });
    expect((await app.request('/api/health')).status).toBe(200);
  });
});
