// Diagnóstico de metadados, sem generateContent e sem registrar mensagens privadas de erro.
if (process.argv.includes('--minimal-request')) {
  const start = performance.now();
  const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY ?? '' },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Retorne apenas o JSON {"ok":true}.' }] }],
      generationConfig: { maxOutputTokens: 128, responseMimeType: 'application/json' } }), redirect: 'error', signal: AbortSignal.timeout(15_000),
  });
  const body = await res.json() as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
  const text = body.candidates?.[0]?.content?.parts?.map(p => p.text ?? '').join('') ?? '';
  let ok = false; try { ok = (JSON.parse(text) as {ok?: unknown}).ok === true; } catch { /* sem texto bruto */ }
  console.log(JSON.stringify({ audit: 'AI-01', operation: 'MINIMAL_SYNTHETIC_DIAGNOSTIC', httpStatus: res.status, validOkJson: ok, latencyMs: Math.round(performance.now()-start), rawOutputPrinted: false }));
} else if (process.argv.includes('--diagnose-request')) {
  const { createEvaluationInvoker, EvaluationFailure } = await import('../src/server/ai/evaluation-provider.js');
  const { EVALUATION_CORPUS } = await import('../src/server/ai/evaluation-corpus.js');
  const diagnosticFetch: typeof fetch = async (input, init) => {
    const request = JSON.parse(String(init?.body)) as { generationConfig?: Record<string, unknown> };
    const configFields = ['temperature','maxOutputTokens','responseMimeType','responseSchema','responseJsonSchema','thinkingConfig'];
    console.log(JSON.stringify({ audit: 'AI-01', operation: 'REQUEST_CONFIGURATION_PROFILE',
      fields: configFields.filter(k => k in (request.generationConfig ?? {})), thinkingRemoved: process.argv.includes('--without-thinking') }));
    if (process.argv.includes('--without-thinking') && request.generationConfig) {
      delete request.generationConfig.thinkingConfig;
      init = { ...init, body: JSON.stringify(request) };
    }
    if (process.argv.includes('--common-schema') && request.generationConfig) {
      const project = (schema: unknown): unknown => {
        if (Array.isArray(schema)) return schema.map(project);
        if (!schema || typeof schema !== 'object') return schema;
        return Object.fromEntries(Object.entries(schema).filter(([key]) => ['type','properties','required','additionalProperties','items','enum','anyOf'].includes(key))
          .map(([key,value]) => [key,key === 'properties' && value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k,v]) => [k,project(v)])) : project(value)]));
      };
      request.generationConfig.responseJsonSchema = project(request.generationConfig.responseJsonSchema);
      init = { ...init, body: JSON.stringify(request) };
    }
    // Diagnóstico separado do benchmark: esperar até 15 s pelo status, sem alterar o timeout do ensaio.
    const res = await fetch(input, { ...init, signal: AbortSignal.timeout(15_000) });
    if (res.ok) console.log(JSON.stringify({ audit: 'AI-01', operation: 'REQUEST_ACCEPTED', httpStatus: res.status, rawOutputPrinted: false }));
    if (!res.ok) {
      const error = (await res.clone().json() as { error?: { status?: string; message?: string } }).error;
      const text = typeof error?.message === 'string' ? error.message : '';
      // Só palavras de um vocabulário estático, jamais a mensagem/valores recebidos.
      const fields = ['responseJsonSchema','response_json_schema','responseSchema','response_schema','thinkingConfig','thinking_config','temperature',
        'maxOutputTokens','max_output_tokens','additionalProperties','$schema','minimum','maximum','pattern','anyOf','nullable','enum','format','propertyOrdering'];
      const issues = ['unsupported','not supported','Unknown name','Invalid JSON','not found','not available','too large','too many','API key'];
      const concepts = ['thinking','reasoning','schema','json','token','temperature','quota','limit','system','instruction','model','output','budget','parameter','argument','invalid','required','support','allowed','enabled','greater','less','minimum','maximum'];
      console.log(JSON.stringify({ audit: 'AI-01', operation: 'SANITIZED_CONFIGURATION_DIAGNOSIS', httpStatus: res.status,
        status: ['INVALID_ARGUMENT','NOT_FOUND','PERMISSION_DENIED','RESOURCE_EXHAUSTED'].includes(error?.status ?? '') ? error!.status : null,
        fieldMentions: fields.filter(f => text.includes(f)), issueMentions: issues.filter(f => text.includes(f)),
        conceptMentions: concepts.filter(f => text.toLowerCase().includes(f)), messagePresent: Boolean(text), rawErrorPrinted: false }));
    }
    return res;
  };
  try { await createEvaluationInvoker('google', process.env, diagnosticFetch)(EVALUATION_CORPUS[0]!, AbortSignal.timeout(6000)); }
  catch (error) { console.log(JSON.stringify({ audit: 'AI-01', operation: 'SANITIZED_FAILURE_CLASSIFICATION',
    code: error instanceof EvaluationFailure ? error.code : 'UNKNOWN', detail: error instanceof EvaluationFailure ? error.detail ?? null : null })); }
} else {
const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000', {
  headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY ?? '' }, redirect: 'error', signal: AbortSignal.timeout(10_000),
});
const body = await response.json() as { error?: { status?: string; details?: { reason?: string }[] }; models?: { name?: string; supportedGenerationMethods?: string[] }[] };
const allowedStatus = new Set(['INVALID_ARGUMENT','NOT_FOUND','PERMISSION_DENIED','UNAUTHENTICATED','RESOURCE_EXHAUSTED']);
const allowedReasons = new Set(['API_KEY_INVALID','API_KEY_SERVICE_BLOCKED','SERVICE_DISABLED','BILLING_DISABLED','CONSUMER_INVALID']);
const flashModels = Array.isArray(body.models) ? body.models.filter(m => typeof m.name === 'string' &&
  /^models\/gemini-[0-9][a-zA-Z0-9.-]*flash[a-zA-Z0-9.-]*$/.test(m.name) && !/image|audio|tts|live/.test(m.name) &&
  m.supportedGenerationMethods?.includes('generateContent')).map(m => m.name) : [];
console.log(JSON.stringify({ audit: 'AI-01', operation: 'models/list', httpStatus: response.status,
  errorStatus: allowedStatus.has(body.error?.status ?? '') ? body.error!.status : null,
  errorReasons: (body.error?.details ?? []).map(d => d.reason).filter(r => allowedReasons.has(r ?? '')),
  requestedModelListed: flashModels.includes('models/gemini-3.8-flash'), flashModels,
  catalogMayBePaginated: true, inferenceCalled: false }));
}
export {};
