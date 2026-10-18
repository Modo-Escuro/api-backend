// Ensaio curto pedido pelo usuário para o hackathon. Só dados sintéticos; sem runtime/OAuth/MCP.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { AgentProposalSchema, type AgentProposal } from '../src/server/agent/model.js';
import { CLAUDE_DEMO_CORPUS, scoreClaudeDemo } from '../src/server/ai/claude-demo-corpus.js';
import { CLAUDE_LIMITS, CLAUDE_MODEL, CLAUDE_PROMPT, ClaudeFailure, claudeWireSchema, createClaudeModel, type ClaudeObservation } from '../src/server/ai/claude-model.js';
import { sha } from '../src/server/ai/evaluation-contract.js';
import { percentile95 } from '../src/server/ai/evaluation-runner.js';

async function main() {
  if (process.argv.slice(2).some(a => !['--live','--provider=google','--provider=anthropic'].includes(a))) throw new ClaudeFailure('CONFIGURATION');
  const provider = process.argv.includes('--provider=google') ? 'google' : 'anthropic';
  const modelId = provider === 'google' ? 'gemini-3.8-flash' : CLAUDE_MODEL;
  const live = process.argv.includes('--live');
  const runId = `${new Date().toISOString().replace(/[:.]/g,'-')}-${provider}-${randomUUID().slice(0,8)}`;
  const dir = resolve('.ai-eval', runId);
  await mkdir(dir, { recursive: true });
  const manifest = { protocol: 'AI02_DEMO_1', mode: live ? 'LIVE' : 'OFFLINE_STUB', model: modelId, provider,
    startedAt: new Date().toISOString(), limits: { ...CLAUDE_LIMITS, maxCalls: 16, budgetMicroUsd: 250_000,
      inputMicroUsdPerToken: provider === 'google' ? 0.75 : 2, outputMicroUsdPerToken: provider === 'google' ? 3.75 : 10 }, planned: CLAUDE_DEMO_CORPUS.length,
    corpusSha256: sha(CLAUDE_DEMO_CORPUS), promptSha256: sha(CLAUDE_PROMPT), wireSchemaSha256: sha(claudeWireSchema()),
    packageLockSha256: sha(await readFile('package-lock.json', 'utf8')),
    sdkVersions: Object.fromEntries(await Promise.all(['ai','@ai-sdk/google','@ai-sdk/anthropic'].map(async name => [name, JSON.parse(await readFile(`node_modules/${name}/package.json`,'utf8')).version]))),
    syntheticOnly: true, businessToolsCalled: false, runtimeEnabled: false, maximumTestUsd: 0.25, billingObserved: false,
    priceUsdPerMillionTokens: provider === 'google' ? { input: 0.75, output: 3.75 } : { input: 2, output: 10 },
    gate: { criticalPassRate: 1, taskPassRate: 0.9, schemaRate: 1, p95ModelMs: 8000, textReviewRequired: true },
    scope: 'AI02_ACTION_CONTRACT_MODEL_ONLY_NOT_TELEGRAM_MCP_E2E',
  };
  await writeFile(resolve(dir,'manifest.json'), JSON.stringify(manifest,null,2)+'\n', { flag: 'wx' });
  let observed: ClaudeObservation | null;
  const model = live ? createClaudeModel({ apiKey: process.env[provider === 'google' ? 'GEMINI_API_KEY' : 'ANTHROPIC_API_KEY'] ?? '', provider, maxCalls: 16, budgetMicroUsd: 250_000, onUsage: usage => { observed = usage; } }) : null;
  console.log(JSON.stringify({ audit: 'AI-01', runId, mode: manifest.mode, planned: manifest.planned, budgetUsd: 0.25 }));
  const rows: { id: string; critical: boolean; taskPassed: boolean; schemaValid: boolean; latencyMs: number; proposal: AgentProposal | null; error: string | null; usage: ClaudeObservation | null }[] = [];
  let stopReason: string | null = null;
  for (const test of CLAUDE_DEMO_CORPUS) {
    observed = null; const start = performance.now();
    const row = { id: test.id, critical: test.critical, taskPassed: false, schemaValid: false, latencyMs: 0, proposal: null as AgentProposal | null, error: null as string | null, usage: null as ClaudeObservation | null };
    try {
      const raw = model ? await model.propose({ input: test.input, signal: AbortSignal.timeout(CLAUDE_LIMITS.timeoutMs), maxOutputTokens: CLAUDE_LIMITS.maxOutputTokens, budgetScope: test.id }) : structuredClone(test.expected[0]);
      row.proposal = AgentProposalSchema.parse(raw); row.schemaValid = true;
      row.taskPassed = scoreClaudeDemo(test, row.proposal);
    } catch (error) { row.error = error instanceof ClaudeFailure ? error.code + (error.detail ? `:${error.detail}` : '') : 'INVALID_OUTPUT'; }
    row.latencyMs = performance.now() - start; row.usage = observed;
    rows.push(row);
    await writeFile(resolve(dir,`${provider}.jsonl`), JSON.stringify(row)+'\n', { flag: 'a' });
    console.log(JSON.stringify({ id: row.id, taskPassed: row.taskPassed, error: row.error, latencyMs: Math.round(row.latencyMs) }));
    if (row.error) { stopReason = row.error; break; } // qualquer erro interrompe; nada de gastar em retries
  }
  const critical = rows.filter(r => r.critical);
  const metrics = { completed: rows.length, criticalCompleted: critical.length, taskPassed: rows.filter(r => r.taskPassed).length,
    criticalPassed: critical.filter(r => r.taskPassed).length, schemaValid: rows.filter(r => r.schemaValid).length,
    p95Ms: percentile95(rows.map(r => r.latencyMs)), inputTokens: rows.reduce((n,r) => n+(r.usage?.inputTokens ?? 0),0),
    outputTokens: rows.reduce((n,r) => n+(r.usage?.outputTokens ?? 0),0), chargedMicroUsd: rows.at(-1)?.usage?.chargedMicroUsd ?? null };
  const complete = rows.length === CLAUDE_DEMO_CORPUS.length && stopReason === null;
  const quantitativeGate = live && complete && metrics.criticalPassed === critical.length && metrics.taskPassed / rows.length >= 0.9 && metrics.schemaValid === rows.length && metrics.p95Ms! <= 8000;
  const report = { ...manifest, finishedAt: new Date().toISOString(), complete, stopReason, metrics, quantitativeGate, selected: null,
    selectionReason: 'TEXT_REVIEW_REQUIRED_OR_GATE_FAILED', rows };
  await writeFile(resolve(dir,'report.json'), JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({ audit:'AI-01', reportFile: resolve(dir,'report.json'), complete, stopReason, metrics, quantitativeGate, selected: null }));
  if (!complete) process.exitCode = 2;
}
main().catch(error => { console.error(JSON.stringify({ audit:'AI-01', status:'BLOCKED', reason: error instanceof ClaudeFailure ? error.code : 'CLAUDE_EVAL_FAILED_NO_PRIVATE_DETAILS' })); process.exitCode = 1; });
