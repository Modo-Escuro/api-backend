// Processo filho de teste: sai sem close/commit adicional, nunca acessa .env/MCP.
import { TurnStore } from '../../src/server/turns/store.js';
import { event, principal, result } from './helpers.js';
const [file, stage] = process.argv.slice(2);
const store = new TurnStore(file!, {}, () => 1_800_000_000_000);
const accepted = store.accept(principal, event());
if (stage === 'running' || stage === 'effect' || stage === 'committed') {
  const job = store.claim('synthetic-crashed-process')!;
  if (stage === 'effect') store.beginExternalEffect(job, () => { /* autorização sintética, nenhum envio */ });
  if (stage === 'committed') store.finish(job, result(job));
}
process.stdout.write(JSON.stringify({ operationId: accepted.operation.operationId }));
process.exit(17);
