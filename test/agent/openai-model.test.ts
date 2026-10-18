import { describe, expect, it, vi } from 'vitest';
import { OpenAIConversationModel, OPENAI_PROPOSAL_SCHEMA, type OpenAIModelConfig } from '../../src/server/agent/openai-model';
import { buildModelInput } from '../../src/server/agent/policy';

const cfg: OpenAIModelConfig = { provider: 'openai', model: 'synthetic-model', apiKey: 'synthetic-key', timeoutMs: 1000, maxOutputTokens: 2048, maxRequests: 2 };
const request = () => ({ input: buildModelInput(null, 'COLLECTING', 'Somos Ana'), signal: new AbortController().signal, maxOutputTokens: 1024 });
export const response = (value: unknown = { actions: [], refusal: null }) => ({
  status: 'completed', output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(value) }] }],
});

describe('adaptador OpenAI com transporte sintético, sem rede', () => {
  it('usa endpoint fixo, schema estrito, contexto mínimo, teto, abort e store false', async () => {
    const transport = vi.fn<typeof fetch>(async () => Response.json(response()));
    const model = new OpenAIConversationModel(cfg, transport);
    expect(await model.propose(request())).toEqual({ actions: [] });
    const [url, init] = transport.mock.calls[0]!;
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', signal: expect.any(AbortSignal) });
    const body = JSON.parse(String(init!.body));
    expect(body).toMatchObject({ model: cfg.model, store: false, background: false, max_output_tokens: 1024, text: { format: { strict: true, type: 'json_schema' } } });
    for (const key of ['tools', 'previous_response_id', 'conversation', 'user']) expect(body).not.toHaveProperty(key);
    for (const secret of [cfg.apiKey, 'linkId', 'confirmationId', 'approvalRef']) expect(body.input[0].content).not.toContain(secret);
    expect(body.input[0].role).toBe('user');
  });

  it('todos os objetos do schema têm campos obrigatórios, extras proibidos e raiz objeto', () => {
    const visit = (v: unknown) => {
      if (!v || typeof v !== 'object') return;
      const o = v as Record<string, unknown>;
      if (o.properties) {
        expect(o.required).toEqual(Object.keys(o.properties));
        expect(o.additionalProperties).toBe(false);
      }
      Object.values(o).forEach(visit);
    };
    expect(OPENAI_PROPOSAL_SCHEMA).toMatchObject({ type: 'object' });
    expect(JSON.stringify(OPENAI_PROPOSAL_SCHEMA)).not.toContain('oneOf');
    visit(OPENAI_PROPOSAL_SCHEMA);
  });

  it('null só representa opcionais conhecidos; teto ambíguo não vira autorização', async () => {
    const raw = { refusal: null, actions: [
      { action: 'SET_LIMIT', target: 'GROUP', amountCents: 10000, kind: null },
      { action: 'ADD_RESTRICTION', participant: { name: 'Ana' }, restriction: { kind: 'ALLERGY', code: 'PEANUT', requirement: null } },
      { action: 'ASK_CLARIFICATION', target: 'GROUP', field: 'LIMIT', question: null },
    ] };
    const model = new OpenAIConversationModel(cfg, async () => Response.json(response(raw)));
    expect(await model.propose(request())).toEqual({ actions: [
      { action: 'SET_LIMIT', target: 'GROUP', amountCents: 10000 },
      { action: 'ADD_RESTRICTION', participant: { name: 'Ana' }, restriction: { kind: 'ALLERGY', code: 'PEANUT' } },
      { action: 'ASK_CLARIFICATION', target: 'GROUP', field: 'LIMIT' },
    ] });
  });

  it.each([
    { actions: [], humanConfirmed: null },
    { actions: [{ action: 'ADD_PARTICIPANT', name: null }] },
    { actions: [{ action: 'SET_LIMIT', target: 'GROUP', amountCents: 1.5 }] },
    { actions: [{ action: 'REQUEST_ORDER', approvalRef: 'synthetic' }] },
  ])('recusa proposta inválida sem ecoar conteúdo: %j', async (raw) => {
    const model = new OpenAIConversationModel(cfg, async () => Response.json(response(raw)));
    await expect(model.propose(request())).rejects.toThrow('MODEL_UNAVAILABLE');
  });

  it.each([401, 429, 500, 503])('HTTP %s não repete nem expõe corpo privado', async (status) => {
    const transport = vi.fn<typeof fetch>(async () => new Response('synthetic-private-error', { status }));
    const model = new OpenAIConversationModel(cfg, transport);
    await expect(model.propose(request())).rejects.toThrow(/^MODEL_UNAVAILABLE$/);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each([
    { ...response(), status: 'incomplete' },
    { ...response(), status: 'failed' },
    { status: 'completed', output: [] },
    { status: 'completed', output: [{ type: 'function_call' }] },
    { status: 'completed', output: [...response().output, ...response().output] },
  ])('não aceita saída parcial/ambígua/ferramenta: %j', async (body) => {
    const model = new OpenAIConversationModel(cfg, async () => Response.json(body));
    await expect(model.propose(request())).rejects.toThrow('MODEL_UNAVAILABLE');
  });

  it('recusa explícita vira proposta sem ação; texto da recusa é descartado', async () => {
    const body = response();
    body.output[0]!.content = [{ type: 'refusal', text: 'synthetic-private-refusal' }];
    expect(await new OpenAIConversationModel(cfg, async () => Response.json(body)).propose(request())).toEqual({ actions: [], refusal: true });
  });

  it('limite de tentativas inclui falha e concorrência, sem chamada extra', async () => {
    const transport = vi.fn<typeof fetch>(async () => { throw new Error('synthetic-private-error'); });
    const model = new OpenAIConversationModel(cfg, transport);
    await Promise.allSettled([model.propose(request()), model.propose(request()), model.propose(request())]);
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('corta entrada/resposta grande e entrada cancelada', async () => {
    const transport = vi.fn<typeof fetch>(async () => new Response('x'.repeat(65_537)));
    const model = new OpenAIConversationModel(cfg, transport);
    const large = request(); large.input.message = 'x'.repeat(65_537);
    await expect(model.propose(large)).rejects.toThrow('MODEL_LIMIT');
    await expect(model.propose({ ...request(), signal: AbortSignal.abort() })).rejects.toThrow('MODEL_LIMIT');
    expect(transport).not.toHaveBeenCalled();
    await expect(model.propose(request())).rejects.toThrow('MODEL_UNAVAILABLE');
  });

  it('prazo aborta transporte e não repete', async () => {
    const transport = vi.fn<typeof fetch>(async (_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new Error('synthetic timeout')), { once: true });
    }));
    await expect(new OpenAIConversationModel({ ...cfg, timeoutMs: 10 }, transport).propose(request())).rejects.toThrow('MODEL_UNAVAILABLE');
    expect(transport).toHaveBeenCalledTimes(1);
  });
});
