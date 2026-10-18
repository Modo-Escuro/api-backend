import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { config } from './config.js';

const app = createApp();

serve({ fetch: app.fetch, port: config.port }, (info) => {
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
  if (!config.clientId || !config.clientSecret) {
    console.warn('[api] IFOOD_CLIENT_ID/IFOOD_CLIENT_SECRET ausentes — rode `npm run setup:env` ou crie .env');
  }
});
