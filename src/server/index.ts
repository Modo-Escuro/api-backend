import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { config } from './config.js';
import { TurnRuntime } from './turns/runtime.js';
import { TurnStore } from './turns/store.js';

const conversations = config.conversationRuntime
  ? new TurnRuntime(new TurnStore(config.conversationRuntime.dbFile)) : undefined;
const app = createApp(undefined, { conversations });

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`[api] http://localhost:${info.port}  (login: /api/auth/login · diagnóstico: /api/diagnostics)`);
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
