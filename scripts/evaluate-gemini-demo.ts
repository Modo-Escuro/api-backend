// Ensaio curto AI-01 (origem: PR #35, Maylon) sobre o contrato real de ações da AI-02. Só dados sintéticos;
// sem runtime, OAuth, MCP ou Telegram. Modo --live usa SOMENTE a chave exclusiva de teste AI_EVAL_GEMINI_API_KEY
// (nunca a chave de produção nem variáveis da Railway).
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AgentProposalSchema, type AgentProposal } from '../src/server/agent/model.js';
import { DEMO_CORPUS, scoreDemo } from '../src/server/agent/demo-corpus.js';
import { GEMINI_BOUNDS, GEMINI_MODEL, GeminiFailure, MODEL_PROMPT, createGeminiModel, geminiWireSchema, type GeminiUsage } from '../src/server/agent/gemini-model.js';

const sha = (v: unknown) => createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex');
const p95 = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return Math.round(s[Math.ceil(s.length * 0.95) - 1]!); };
const LIMITS = { maxRequests: DEMO_CORPUS.length, budgetMicroUsd: 250_000, timeoutMs: GEMINI_BOUNDS.timeoutMs.default, maxOutputTokens: GEMINI_BOUNDS.maxOutputTokens.default };

async function main() {
  const args = process.argv.slice(2);
  if (args.some((a) => a !== '--live')) throw new GeminiFailure('CONFIGURATION');
  const live = args.includes('--live');
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-google-${randomUUID().slice(0, 8)}`;
  const dir = resolve('.ai-eval', runId);
  await mkdir(dir, { recursive: true });
  const manifest = { protocol: 'AI02_DEMO_2', mode: live ? 'LIVE' : 'OFFLINE_STUB', model: GEMINI_MODEL, provider: 'google',
    startedAt: new Date().toISOString(), limits: LIMITS, planned: DEMO_CORPUS.length,
    corpusSha256: sha(DEMO_CORPUS), promptSha256: sha(MODEL_PROMPT), wireSchemaSha256: sha(geminiWireSchema()),
    packageLockSha256: sha(await readFile('package-lock.json', 'utf8')),
    sdkVersions: Object.fromEntries(await Promise.all(['ai', '@ai-sdk/google'].map(async (name) => [name, JSON.parse(await readFile(`node_modules/${name}/package.json`, 'utf8')).version]))),
    credential: live ? 'AI_EVAL_GEMINI_API_KEY' : null, syntheticOnly: true, businessToolsCalled: false, maximumTestUsd: 0.25,
    gate: { criticalPassRate: 1, taskPassRate: 0.9, schemaRate: 1, p95ModelMs: 8000 },
    scope: 'AI02_ACTION_CONTRACT_MODEL_ONLY_NOT_TELEGRAM_MCP_E2E' };
  await writeFile(resolve(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  let observed: GeminiUsage | null;
  const model = live ? createGeminiModel({ apiKey: process.env.AI_EVAL_GEMINI_API_KEY ?? '', maxRequests: LIMITS.maxRequests,
    budgetMicroUsd: LIMITS.budgetMicroUsd, timeoutMs: LIMITS.timeoutMs, onUsage: (u) => { observed = u; } }) : null;
  console.log(JSON.stringify({ audit: 'AI-01', runId, mode: manifest.mode, planned: manifest.planned, budgetUsd: 0.25 }));
  const rows: { id: string; critical: boolean; taskPassed: boolean; schemaValid: boolean; latencyMs: number; proposal: AgentProposal | null; error: string | null; usage: GeminiUsage | null }[] = [];
  let stopReason: string | null = null;
  for (const test of DEMO_CORPUS) {
    observed = null;
    const start = performance.now();
    const row = { id: test.id, critical: test.critical, taskPassed: false, schemaValid: false, latencyMs: 0, proposal: null as AgentProposal | null, error: null as string | null, usage: null as GeminiUsage | null };
    try {
      const raw = model ? await model.propose({ input: test.input, signal: AbortSignal.timeout(LIMITS.timeoutMs), maxOutputTokens: LIMITS.maxOutputTokens, budgetScope: test.id })
        : structuredClone(test.expected[0]);
      row.proposal = AgentProposalSchema.parse(raw);
      row.schemaValid = true;
      row.taskPassed = scoreDemo(test, row.proposal);
    } catch (error) { row.error = error instanceof GeminiFailure ? error.code + (error.detail ? `:${error.detail}` : '') : 'INVALID_OUTPUT'; }
    row.latencyMs = performance.now() - start;
    row.usage = observed;
    rows.push(row);
    await writeFile(resolve(dir, 'google.jsonl'), JSON.stringify(row) + '\n', { flag: 'a' });
    console.log(JSON.stringify({ id: row.id, taskPassed: row.taskPassed, error: row.error, latencyMs: Math.round(row.latencyMs) }));
    if (row.error) { stopReason = row.error; break; } // qualquer erro interrompe: nada de gastar em retries
  }
  const critical = rows.filter((r) => r.critical);
  const metrics = { completed: rows.length, criticalCompleted: critical.length, taskPassed: rows.filter((r) => r.taskPassed).length,
    criticalPassed: critical.filter((r) => r.taskPassed).length, schemaValid: rows.filter((r) => r.schemaValid).length,
    p95Ms: p95(rows.map((r) => r.latencyMs)), inputTokens: rows.reduce((n, r) => n + (r.usage?.inputTokens ?? 0), 0),
    outputTokens: rows.reduce((n, r) => n + (r.usage?.outputTokens ?? 0), 0), chargedMicroUsd: rows.at(-1)?.usage?.chargedMicroUsd ?? null };
  const complete = rows.length === DEMO_CORPUS.length && stopReason === null;
  const quantitativeGate = live && complete && metrics.criticalPassed === critical.length && metrics.taskPassed / rows.length >= 0.9
    && metrics.schemaValid === rows.length && (metrics.p95Ms ?? Infinity) <= 8000;
  const report = { ...manifest, finishedAt: new Date().toISOString(), complete, stopReason, metrics, quantitativeGate, rows };
  await writeFile(resolve(dir, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ audit: 'AI-01', reportFile: resolve(dir, 'report.json'), complete, stopReason, metrics, quantitativeGate }));
  if (!complete) process.exitCode = 2;
}
main().catch((error) => { console.error(JSON.stringify({ audit: 'AI-01', status: 'BLOCKED', reason: error instanceof GeminiFailure ? error.code : 'EVAL_FAILED_NO_PRIVATE_DETAILS' })); process.exitCode = 1; });
