// Gera .env a partir de ~/.config/opencode/opencode.jsonc sem imprimir segredos.
// Uso: npm run setup:env [-- <entrada>]   (padrão: "ifood")
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const entry = process.argv[2] ?? 'ifood';
const envPath = join(process.cwd(), '.env');
if (existsSync(envPath)) {
  console.error('.env já existe — nada foi alterado.');
  process.exit(1);
}
const raw = readFileSync(join(homedir(), '.config/opencode/opencode.jsonc'), 'utf8');
const json = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, ''));
const cfg = json?.mcp?.[entry];
if (!cfg?.oauth?.clientId || !cfg?.oauth?.clientSecret) {
  console.error(`Entrada mcp.${entry}.oauth não encontrada/incompleta no opencode.jsonc`);
  process.exit(1);
}
const lines = [
  `IFOOD_MCP_URL=${cfg.url}`,
  `IFOOD_CLIENT_ID=${cfg.oauth.clientId}`,
  `IFOOD_CLIENT_SECRET=${cfg.oauth.clientSecret}`,
  `IFOOD_REDIRECT_URI=${cfg.oauth.redirectUri ?? 'http://localhost:8000'}`,
  'IFOOD_SCOPE=',
  'WEB_ORIGIN=http://localhost:5173',
  'PORT=8000',
];
writeFileSync(envPath, lines.join('\n') + '\n', { mode: 0o600 });
console.log(`.env criado a partir de mcp.${entry} (clientId ${cfg.oauth.clientId.slice(0, 4)}…, redirect ${cfg.oauth.redirectUri}).`);
