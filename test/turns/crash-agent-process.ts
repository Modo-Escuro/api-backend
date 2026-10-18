// Processo filho de teste: runtime com o processador real da AI-02 (Gemini com transporte SINTÉTICO, sem rede)
// sobre o domínio da DATA-01. Morre sem stop/close na etapa pedida. Nunca acessa .env, OAuth ou MCP.
import { createGeminiModel } from '../../src/server/agent/gemini-model.js';
import { createAgentProcessor } from '../../src/server/agent/processor.js';
import { TurnRuntime } from '../../src/server/turns/runtime.js';
import { TurnStore } from '../../src/server/turns/store.js';
import { geminiReply } from '../helpers/gemini.js';
import { event, principal } from './helpers.js';

// stdout é só do resultado estruturado lido pelo teste. Logs (inclusive os JSON da OPS-02, que usam console.log)
// vão para stderr.
const toStderr = (...args: unknown[]) => { process.stderr.write(args.map(String).join(' ') + '\n'); };
console.log = console.info = console.debug = console.warn = toStderr;

const [file, stage] = process.argv.slice(2);
let calls = 0;
const transport: typeof fetch = async () => {
  calls++;
  console.log(JSON.stringify({ level: 'info', event: 'synthetic.log', component: 'test' })); // simula log estruturado
  if (stage === 'running') return new Promise<Response>(() => undefined); // modelo em voo quando o processo morre
  return geminiReply({ actions: [{ action: 'ADD_PARTICIPANT', name: 'Ana' }] });
};
const runtime = new TurnRuntime(new TurnStore(file!), { processor: createAgentProcessor({
  model: createGeminiModel({ apiKey: 'synthetic-key', maxRequests: 5, fetch: transport }), linkOf: async () => null, timeoutMs: 10_000,
}) });
const e = event(1, 0); e.input = { kind: 'TEXT', text: 'Somos Ana' };
const accepted = runtime.accept(principal, e);
const die = () => { process.stdout.write(JSON.stringify({ operationId: accepted.operation.operationId, calls })); process.exit(17); };
if (stage === 'accepted') die();
for (let i = 0; i < 400; i++) {
  runtime.tick();
  await new Promise((r) => setTimeout(r, 5));
  const op = runtime.store.operation(principal, accepted.operation.operationId);
  if (stage === 'running' && op.status === 'RUNNING' && calls > 0) die();
  if (stage === 'committed' && op.status === 'SUCCEEDED') die();
}
process.exit(1);
