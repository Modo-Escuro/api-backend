// CLI isolado: corpus fixo, inferência direta; não carrega config/OAuth/MCP/runtime da aplicação.
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sha } from '../src/server/ai/evaluation-contract.js';
import { evaluationManifest, runEvaluation, selectCandidate, type ModelEvaluation } from '../src/server/ai/evaluation-runner.js';
import { createEvaluationInvoker, EvaluationFailure, type EvaluationProvider, type Invoker } from '../src/server/ai/evaluation-provider.js';

async function main() {
  const args = process.argv.slice(2);
  if (args.some(a => !['--manifest','--live','--offline','--provider=google','--provider=groq','--provider=both'].includes(a)) ||
    (args.includes('--live') && args.includes('--offline')) || args.filter(a => a.startsWith('--provider=')).length > 1) throw new EvaluationFailure('PROVIDER_CONFIGURATION');
  if (args.includes('--manifest')) { console.log(JSON.stringify(evaluationManifest(), null, 2)); return; }
  const mode = args.includes('--live') ? 'LIVE' : 'OFFLINE_STUB';
  const which = args.find(a => a.startsWith('--provider='))?.slice('--provider='.length) ?? 'both';
  const providers: EvaluationProvider[] = which === 'both' ? ['google','groq'] : [which as EvaluationProvider];
  // Validar TODAS as credenciais antes da primeira inferência. Nada é escrito num .env local.
  const invokers = providers.map(provider => mode === 'LIVE' ? createEvaluationInvoker(provider, process.env) : (async test => ({
    output: { ...structuredClone(test.expected), message: 'Saída sintética do stub; precisamos esclarecer?' },
    inputTokens: null, outputTokens: null, reasoningTokens: null, resolvedModel: 'OFFLINE_STUB', finishReason: 'stop',
  })) as Invoker);
  const runId = `${new Date().toISOString().replace(/[:.]/g,'-')}-${randomUUID().slice(0,8)}`;
  const dir = resolve('.ai-eval', runId);
  await mkdir(dir, { recursive: true });
  const manifest = { ...evaluationManifest(), startedAt: new Date().toISOString(), mode,
    freeTierAttested: mode === 'LIVE', observedBillingUsd: null,
    freeTierAttestationSource: mode !== 'LIVE' ? null : process.env.AI_EVAL_ATTESTATION_SOURCE === 'EXPLICIT_LOCAL_FLAG' ? 'EXPLICIT_LOCAL_FLAG' : 'EXPLICIT_ENVIRONMENT_MARKER',
    sdkVersions: Object.fromEntries(await Promise.all(['ai','@ai-sdk/google','@ai-sdk/groq'].map(async name =>
      [name, (JSON.parse(await readFile(resolve('node_modules',name,'package.json'),'utf8')) as { version: string }).version]))),
    packageLockSha256: sha(await readFile(resolve('package-lock.json'),'utf8')),
    execution: { node: process.version, platform: process.platform },
    design: 'TEACHER_FORCED_SYNTHETIC_CONTEXTS_NOT_CHAINED_MODEL_CONVERSATIONS',
    scope: 'MODEL_ONLY_NO_TELEGRAM_MCP_OR_DOMAIN_MUTATIONS' };
  await writeFile(resolve(dir, 'manifest.json'), JSON.stringify(manifest,null,2)+'\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ audit: 'AI-01', mode, reportDirectory: dir, callsPerModel: manifest.callsPerModel }));
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  let results: ModelEvaluation[];
  try {
    results = await Promise.all(providers.map((provider, index) => runEvaluation({ mode, provider, invoke: invokers[index]!, signal: controller.signal,
      onRow: async row => {
        await writeFile(resolve(dir, `${provider}.jsonl`), JSON.stringify(row)+'\n', { flag: 'a', mode: 0o600 });
        console.log(JSON.stringify({ provider, caseId: row.caseId, repetition: row.repetition, status: row.status,
          error: row.error, safe: row.safe, taskPassed: row.taskPassed, latencyMs: Math.round(row.latencyMs) }));
      },
    })));
  } finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
  const report = { ...manifest, finishedAt: new Date().toISOString(), results, selection: selectCandidate(results),
    runtimeEnabled: false, billingVerified: false, endToEndMeasured: false };
  await writeFile(resolve(dir, 'report.json'), JSON.stringify(report,null,2)+'\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ audit: 'AI-01', mode, results: results.map(({ rows: _rows, ...summary }) => summary), selection: report.selection, reportFile: resolve(dir,'report.json') }));
  if (mode === 'LIVE' && results.some(r => !r.complete)) process.exitCode = 2;
}
main().catch(error => {
  console.error(JSON.stringify({ audit: 'AI-01', status: 'BLOCKED', reason: error instanceof EvaluationFailure ? error.code : 'EVALUATION_FAILED_NO_PRIVATE_DETAILS', businessToolsCalled: false }));
  process.exitCode = 1;
});
