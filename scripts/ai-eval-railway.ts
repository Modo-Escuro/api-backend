// Executar APENAS via `railway run` no checkout local. Nunca imprime valores nem escreve .env.
// Remove o restante das variáveis do serviço antes de importar os adaptadores de modelo.
const scope = {
  projectMatches: process.env.RAILWAY_PROJECT_ID === 'd2af9e6b-0bda-4725-bcc8-9092dc2b5a2e',
  serviceMatches: process.env.RAILWAY_SERVICE_ID === '742172f7-8c6f-415d-8c5b-72757980e427',
  environmentMatches: process.env.RAILWAY_ENVIRONMENT_NAME === 'production',
};
const aliases = { googleApiKeyConfigured: Boolean(process.env.GOOGLE_API_KEY),
  googleSdkKeyConfigured: Boolean(process.env.GOOGLE_GENERATIVE_AI_API_KEY) };
const allow = new Set(['GEMINI_API_KEY','GROQ_API_KEY','AI_EVAL_FREE_TIER_CONFIRMED',
  'PATH','Path','SystemRoot','SYSTEMROOT','TEMP','TMP','COMSPEC','PATHEXT']);
for (const key of Object.keys(process.env)) if (!allow.has(key)) delete process.env[key];
// Confirmação explícita do operador na execução local, alternativa ao marcador persistente.
if (process.argv.includes('--free-tier-confirmed')) {
  process.env.AI_EVAL_FREE_TIER_CONFIRMED = 'true';
  process.env.AI_EVAL_ATTESTATION_SOURCE = 'EXPLICIT_LOCAL_FLAG';
  process.argv = process.argv.filter(arg => arg !== '--free-tier-confirmed');
}
if (process.argv.includes('--check-keys')) {
  console.log(JSON.stringify({ audit: 'AI-01', geminiKeyConfigured: Boolean(process.env.GEMINI_API_KEY),
    groqKeyConfigured: Boolean(process.env.GROQ_API_KEY), freeTierConfirmed: process.env.AI_EVAL_FREE_TIER_CONFIRMED === 'true',
    inferenceCalled: false, scope, aliases }));
} else if (!Object.values(scope).every(Boolean)) {
  console.error(JSON.stringify({ audit: 'AI-01', status: 'BLOCKED', reason: 'RAILWAY_SCOPE_MISMATCH', inferenceCalled: false }));
  process.exitCode = 1;
} else if (process.argv.includes('--check-availability')) {
  try { await import('./check-ai-availability.js'); }
  catch { console.error(JSON.stringify({ audit: 'AI-01', status: 'BLOCKED', reason: 'METADATA_CHECK_FAILED_NO_PRIVATE_DETAILS', inferenceCalled: false })); process.exitCode = 1; }
} else {
  await import('./evaluate-ai.js');
}
export {};
