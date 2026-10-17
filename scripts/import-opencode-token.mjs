// Bootstrap opcional: copia o token OAuth já obtido pelo OpenCode (mesmo client) para .tokens.json,
// permitindo testar o backend sem novo login no navegador. Não imprime tokens.
// Uso: npm run auth:import-opencode [-- <entrada>]   (padrão: "ifood")
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const entry = process.argv[2] ?? 'ifood';
const store = JSON.parse(readFileSync(join(homedir(), '.local/share/opencode/mcp-auth.json'), 'utf8'));
const t = store?.[entry]?.tokens;
if (!t?.accessToken) {
  console.error(`Sem tokens para "${entry}" em mcp-auth.json — faça login pelo app (/api/auth/login).`);
  process.exit(1);
}
const clientId = process.env.IFOOD_CLIENT_ID;
const out = {
  clientId: clientId ?? null,
  accessToken: t.accessToken,
  refreshToken: t.refreshToken ?? null,
  // OpenCode guarda expiresAt em segundos.
  expiresAt: typeof t.expiresAt === 'number' ? Math.round(t.expiresAt * 1000) : null,
  scope: t.scope ?? null,
  source: `opencode:${entry}`,
  obtainedAt: Date.now(),
};
writeFileSync(join(process.cwd(), '.tokens.json'), JSON.stringify(out, null, 2), { mode: 0o600 });
const exp = out.expiresAt ? new Date(out.expiresAt).toISOString() : 'desconhecido';
console.log(`Token importado de OpenCode/${entry} (expira ${exp}, refresh ${out.refreshToken ? 'sim' : 'não'}).`);
