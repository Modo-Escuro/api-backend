import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { config } from './config.js';
import { log } from './ops/log.js';
import { checkPrivatePath } from './ops/storage-check.js';
import { TurnRuntime } from './turns/runtime.js';
import { TurnStore } from './turns/store.js';

const conversations = config.conversationRuntime
  ? new TurnRuntime(new TurnStore(config.conversationRuntime.dbFile)) : undefined;
const app = createApp(undefined, { conversations });

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`[api] http://localhost:${info.port}  (login: /api/auth/login · diagnóstico: /api/diagnostics)`);
  const st = config.linksStorage;
  const where = `durabilidade=${st.durability} plataforma=${st.platform} IFOOD_LINKS_DIR=${st.explicitDir ? 'definido' : 'padrão'}`;
  if (st.durability === 'EPHEMERAL') {
    console.error(
      `[links] ARMAZENAMENTO EFÊMERO (${where}): vínculos se perdem no próximo deploy. ` +
        (st.allowEphemeral ? 'IFOOD_LINKS_ALLOW_EPHEMERAL=true — novos vínculos aceitos mesmo assim.' : 'Novos vínculos recusados até montar um volume (docs/ops-01-persistencia.md).'),
    );
  } else if (st.durability === 'UNVERIFIED') {
    console.warn(`[links] persistência não comprovada (${where}): confirme que IFOOD_LINKS_DIR está num disco persistente.`);
  } else {
    console.log(`[links] armazenamento: ${where}`);
  }
  // OPS-02: permissões verificadas na plataforma real; no Windows o resultado é UNVERIFIED_PLATFORM (conferir ACL).
  const perm = checkPrivatePath(config.linksDir);
  log(perm.state === 'PRIVATE' || perm.state === 'MISSING' ? 'info' : 'warn', 'storage.permissions', { component: 'links', state: perm.state, platform: perm.platform });
  if (config.submitFlagIgnored) log('warn', 'config.submit_flag_ignored', { component: 'purchase', reason: 'DEC01_D8_READ_ONLY' });
  if (!config.clientId || !config.clientSecret) {
    console.warn('[api] IFOOD_CLIENT_ID/IFOOD_CLIENT_SECRET ausentes — rode `npm run setup:env` ou crie .env');
  }
});
conversations?.start();
if (conversations) console.warn('[turnos] Infraestrutura ativa; processador DATA/IA ainda não instalado. Novos eventos retornam UNAVAILABLE.');
const shutdown = () => {
  conversations?.stop();
  server.close();
};
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
