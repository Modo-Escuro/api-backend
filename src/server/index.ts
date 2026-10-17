import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { config } from './config.js';

const app = createApp();

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`[api] http://localhost:${info.port}  (login: /api/auth/login · diagnóstico: /api/diagnostics)`);
  if (!config.clientId || !config.clientSecret) {
    console.warn('[api] IFOOD_CLIENT_ID/IFOOD_CLIENT_SECRET ausentes — rode `npm run setup:env` ou crie .env');
  }
});
