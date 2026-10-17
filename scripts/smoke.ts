// Smoke test real (rede): tools/list + listAddresses + searchOffers('pizza') pelo cliente do backend.
// Imprime apenas contagens/nomes de itens — nada de token ou endereço.
import { getMcpClient } from '../src/server/mcp/client.js';
import { listAddresses, searchOffers } from '../src/server/mcp/tools.js';

async function main() {
  const c = await getMcpClient();
  const { tools } = await c.listTools();
  console.log(`tools/list: ${tools.length} tools (${c.getServerVersion()?.name} v${c.getServerVersion()?.version})`);
  const { results } = await listAddresses();
  console.log(`listAddresses: ${results.length} endereço(s)`);
  const loc = results[0]?.coordinates;
  if (!loc) throw new Error('Sem endereço com coordinates para testar a busca');
  const r = await searchOffers({ query: 'pizza', userLocation: loc, resultKind: 'ITEM', pageSize: 5 });
  console.log(`searchOffers('pizza'): ${r.results.length} itens, hasMore=${r.hasMore}`);
  for (const i of r.results) console.log(`  - ${i.itemName} · R$ ${i.promotionalUnitPrice ?? i.unitPrice} · ${i.merchant.merchantName}`);
  await c.close();
}
main().catch((e) => {
  console.error('SMOKE FALHOU:', e instanceof Error ? e.message : e);
  process.exit(1);
});
