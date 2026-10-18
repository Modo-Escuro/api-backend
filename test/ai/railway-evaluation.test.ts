import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP,
  RAILWAY_PROJECT_ID: 'd2af9e6b-0bda-4725-bcc8-9092dc2b5a2e', RAILWAY_SERVICE_ID: '742172f7-8c6f-415d-8c5b-72757980e427',
  RAILWAY_ENVIRONMENT_NAME: 'production', GEMINI_API_KEY: 'secret-google-synthetic', GROQ_API_KEY: 'secret-groq-synthetic',
  IFOOD_CLIENT_SECRET: 'secret-ifood-synthetic' };
describe('AI-01: ambiente Railway só no subprocesso de avaliação', () => {
  it('confere presença sem imprimir valores; confirmação explícita só vale para o subprocesso', () => {
    const run = spawnSync(process.execPath,['--import','tsx','scripts/ai-eval-railway.ts','--check-keys','--free-tier-confirmed'],{ env, encoding: 'utf8' });
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ geminiKeyConfigured: true, groqKeyConfigured: true, freeTierConfirmed: true,
      inferenceCalled: false, scope: { projectMatches: true, serviceMatches: true, environmentMatches: true } });
    expect(run.stdout + run.stderr).not.toMatch(/secret-google|secret-groq|secret-ifood/);
    expect('AI_EVAL_FREE_TIER_CONFIRMED' in env).toBe(false);
  });
  it('escopo divergente bloqueia antes de importar o avaliador ou fazer inferência', () => {
    const run = spawnSync(process.execPath,['--import','tsx','scripts/ai-eval-railway.ts','--live','--free-tier-confirmed'],{
      env: { ...env, RAILWAY_SERVICE_ID: 'other-service' }, encoding: 'utf8' });
    expect(run.status).toBe(1);
    expect(JSON.parse(run.stderr)).toMatchObject({ status: 'BLOCKED', reason: 'RAILWAY_SCOPE_MISMATCH', inferenceCalled: false });
    expect(run.stdout + run.stderr).not.toMatch(/secret-google|secret-groq|secret-ifood/);
  });
});
