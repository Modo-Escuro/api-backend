import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { config } from './config.js';
import { TurnRuntime } from './turns/runtime.js';
import { TurnStore } from './turns/store.js';
import { IfoodLinkService } from './links/service.js';
import { realSessionFactory } from './links/session.js';
import { createAgentProcessor } from './agent/processor.js';
import { createGeminiModel, CLAUDE_LIMITS } from './ai/claude-model.js';

const links = new IfoodLinkService({ cfg: config, sessionFactory: realSessionFactory });
const processor = config.conversationModel ? createAgentProcessor({
  model: createGeminiModel({ apiKey: config.conversationModel.apiKey }),
  linkOf: async organizer => { const status = await links.status(organizer); return status.state === 'CONNECTED' ? status.linkId : null; },
  timeoutMs: 9_000, maxOutputTokens: CLAUDE_LIMITS.maxOutputTokens,
}) : undefined;
const conversations = config.conversationRuntime
  ? new TurnRuntime(new TurnStore(config.conversationRuntime.dbFile), { processor }) : undefined;
const app = createApp(undefined, { conversations, links });

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
  if (!config.clientId || !config.clientSecret) {
    console.warn('[api] IFOOD_CLIENT_ID/IFOOD_CLIENT_SECRET ausentes — rode `npm run setup:env` ou crie .env');
  }
});
conversations?.start();
if (conversations) console.warn(processor ? '[turnos] Agente Gemini ativo; propostas validadas pelo servidor; sem envio externo.' : '[turnos] Infraestrutura ativa; processador DATA/IA não habilitado. Novos eventos retornam UNAVAILABLE.');
const shutdown = () => {
  conversations?.stop();
  server.close();
};
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
