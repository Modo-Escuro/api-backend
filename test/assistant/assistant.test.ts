// IA, OAuth, MCP e Telegram sintéticos; runtime/SQLite/HTTP e adaptador Gemini reais.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/server/app';
import { createAssistantProcessor, narration } from '../../src/server/assistant/processor';
import { ASSISTANT_TOOLS, AssistantStepSchema, type AssistantInput, type AssistantModel, type AssistantStep } from '../../src/server/assistant/protocol';
import { AssistantTools } from '../../src/server/assistant/tools';
import type { AudienceModel } from '../../src/server/assistant/audience';
import { recipient } from '../../src/server/assistant/memory';
import { loadConfig } from '../../src/server/config';
import { contentHash } from '../../src/server/contracts/guards';
import { createConversationRuntime } from '../../src/server/conversation-runtime';
import type { OperationalContext } from '../../src/server/links/service';
import { SpendBudget } from '../../src/server/ops/budget';
import { DeliveryAddresses } from '../../src/server/services/delivery-addresses';
import { TurnRuntime } from '../../src/server/turns/runtime';
import { TurnStore } from '../../src/server/turns/store';
import { ADDRESS, BOT_TOKEN, ITEMS, ORG_A, connectAndConfirm, fx, setup } from '../helpers/fakes';
import { geminiReply } from '../helpers/gemini';
import { deferred, event, flush, principal, temporary } from '../turns/helpers';

const initial = 'Que lindo! Que tal um bolo acompanhado de uma flor? Vou procurar algumas opções.';
const step = (over: Partial<AssistantStep> = {}): AssistantStep => ({ message: initial, requests: [], itemRefs: [], ...over });
const listed = fx('searchOffers-pizza.json').results.filter((r: { itemId: string }) => ITEMS.has(r.itemId)).slice(0, 2);
const cake = { ...listed[0], itemName: 'Bolo de chocolate (sintético)' };
const flower = { ...listed[1], itemName: 'Rosa (sintética)' };
const listing = (item = cake) => ({ results: [item], resultKind: 'ITEM', hasMore: false });
const detail = (itemId: string) => ({ ...structuredClone(ITEMS.get(itemId) as object),
  itemName: itemId === cake.itemId ? cake.itemName : flower.itemName });
const search = (query: string, type: 'RESTAURANT' | 'SHOPPING' = 'RESTAURANT') => ({ name: 'searchOffers' as const, arguments: { query, merchantType: type } });

describe('assistente conversacional orientado por consultas', () => {
  const cleanup: (() => void)[] = [];
  afterEach(() => { cleanup.splice(0).forEach(fn => fn()); vi.restoreAllMocks(); });

  async function environment(replies: (input: AssistantInput) => Promise<AssistantStep>, overrides = {}) {
    const env = setup();
    await connectAndConfirm(env, ORG_A);
    const dir = temporary(), store = new TurnStore(dir.file);
    const addresses = new DeliveryAddresses(store, env.links);
    const choices = await addresses.review(principal);
    await addresses.select(principal, choices.options[0]!.choiceRef);
    const seen: AssistantInput[] = [];
    const model: AssistantModel = { id: 'scripted', propose: async r => { seen.push(structuredClone(r.input)); return replies(r.input); } };
    const audienceModel: AudienceModel = { id: 'scripted-audience', propose: async ({ input }) => {
      const label = input.message.includes('Ana') ? 'Ana' : input.message.includes('namorada') ? 'namorada'
        : /^Ela\b/.test(input.message) ? input.previousTargets.find(p => p.kind === 'RECIPIENT')?.label : undefined;
      const who = label ? { kind: 'RECIPIENT' as const, label, evidenceQuote: input.message.includes(label) ? label : 'Ela' } : { kind: 'SELF' as const };
      return { targets: [who], mentioned: [who], purpose: 'FOOD', ambiguous: false };
    } };
    const processor = createAssistantProcessor({ model, audienceModel, links: env.links, selectedAddress: (_, linkId) => addresses.selected(principal, linkId), ...overrides });
    const runtime = new TurnRuntime(store, { processor });
    cleanup.push(() => { runtime.stop(); dir.clean(); });
    let n = 0;
    const send = async (text = 'Hoje é um dia especial, quero comprar um bolo pra minha namorada') => {
      let version = 0;
      try { version = store.snapshot(principal).version; } catch { /* primeira mensagem */ }
      const e = event(++n, version); e.input = { kind: 'TEXT', text };
      const accepted = runtime.accept(principal, e);
      for (let i = 0; i < 150; i++) {
        runtime.tick(); await flush();
        const operation = store.operation(principal, accepted.operation.operationId);
        if (!['ACCEPTED', 'RUNNING'].includes(operation.status)) return { operation, event: e };
        await new Promise(resolve => setTimeout(resolve, 2));
      }
      throw new Error('operação não terminou');
    };
    return { env, dir, store, addresses, runtime, seen, send };
  }

  it('bolo + flor: modelo escolhe buscas paralelas, detalha e apresenta ofertas sem formulário', async () => {
    const gate = deferred<void>(), started: string[] = [];
    const e = await environment(async input => input.round === 1 ? step({ requests: [search('bolo'), search('flor', 'SHOPPING')] })
      : input.round === 2 ? step({ message: '', requests: [
        { name: 'getItem', arguments: { itemRef: 'item_1' } }, { name: 'getItem', arguments: { itemRef: 'item_2' } },
      ] }) : step({ message: 'Separei estas ideias para esse momento especial. Qual combina mais com ela?', itemRefs: ['item_1', 'item_2'] }));
    // A mesma sessão falsa fornece preços/opções com IDs provenientes das fixtures reais.
    const original = e.env.links.withOperational.bind(e.env.links);
    vi.spyOn(e.env.links, 'withOperational').mockImplementation((org, op, fn) => original(org, op, async ctx => fn({ ...ctx, deps: { ...ctx.deps,
      searchOffers: async args => { started.push(args.query); if (started.length === 2) gate.resolve(); await gate.promise; return listing(args.query === 'bolo' ? cake : flower); },
      getItem: async args => detail(args.itemId),
    } })));
    const result = await e.send();
    expect(result.operation.status).toBe('SUCCEEDED');
    expect(started.sort()).toEqual(['bolo', 'flor']);
    const texts = result.operation.snapshot!.blocks.flatMap(b => b.kind === 'TEXT' ? [b.text] : []);
    expect(texts.join('\n')).toContain(cake.itemName);
    expect(texts.join('\n')).toContain(flower.itemName);
    expect(texts.join('\n')).not.toMatch(/Quem vai participar|Qual é o.*orçamento|economia ou rapidez/);
    expect(result.operation.snapshot!.humanApproval).toBeNull();
    expect(e.seen).toHaveLength(3);
    const json = JSON.stringify(e.seen);
    for (const secret of [ADDRESS.addressId, 'latitude', 'longitude', BOT_TOKEN, cake.itemId, flower.itemId]) expect(json).not.toContain(secret);
    expect(e.runtime.accept(principal, result.event).status).toBe(200);
    expect(e.seen).toHaveLength(3); // replay do evento concluído não chama a IA.
  });

  it('a prévia chega antes do catálogo, é escopada e desaparece ao terminar', async () => {
    const wait = deferred<void>();
    const e = await environment(async input => input.round === 1 ? step({ requests: [search('bolo')] }) : step());
    const original = e.env.links.withOperational.bind(e.env.links);
    vi.spyOn(e.env.links, 'withOperational').mockImplementation((org, op, fn) => original(org, op, async ctx => fn({ ...ctx, deps: { ...ctx.deps, searchOffers: async () => { await wait.promise; return listing(); } } })));
    const accepted = e.runtime.accept(principal, event());
    e.runtime.tick();
    for (let i = 0; i < 30 && e.runtime.progress(principal, accepted.operation.operationId).text === null; i++) { await flush(); await new Promise(r => setTimeout(r, 2)); }
    expect(e.runtime.progress(principal, accepted.operation.operationId).text).toBe(initial);
    expect(() => e.runtime.progress({ ...principal, organizerId: '222222222', conversationId: '222222222' }, accepted.operation.operationId)).toThrow();
    wait.resolve();
    for (let i = 0; i < 20; i++) { e.runtime.tick(); await flush(); }
    expect(e.runtime.progress(principal, accepted.operation.operationId).text).toBeNull();
  });

  it('referência inventada não dispara getItem nem aparece como oferta; listagem sem detalhe também não', async () => {
    const e = await environment(async input => input.round === 1 ? step({ requests: [search('bolo')] })
      : input.round === 2 ? step({ requests: [{ name: 'getItem', arguments: { itemRef: 'item_999' } }] })
        : step({ itemRefs: ['item_1', 'item_999'] }));
    const result = await e.send();
    expect(result.operation.status).toBe('SUCCEEDED');
    expect(e.env.mcp.used.filter(r => r.op === 'getItem')).toHaveLength(0);
    expect(result.operation.snapshot!.blocks.filter(b => b.kind === 'TEXT' && b.source === 'SERVER')).toHaveLength(0);
    expect(JSON.stringify(e.seen)).toContain('UNOBSERVED_REFERENCE');
  });

  it('sem endereço selecionado explica a pendência, sem consultar ofertas', async () => {
    const e = await environment(async input => input.round === 1 ? step({ requests: [search('bolo')] }) : step({ message: 'Escolha onde deseja receber para eu consultar as opções.' }));
    e.store.db.prepare('DELETE FROM delivery_address_selected').run();
    const { operation } = await e.send();
    expect(operation.status).toBe('SUCCEEDED');
    expect(operation.snapshot!.pending.join(' ')).toContain('Confirme seu endereço');
    expect(e.env.mcp.searchArgs).toHaveLength(0);
  });

  it('chave de escrita ou aprovação na saída invalida o passo inteiro', async () => {
    // eslint-disable-next-line no-restricted-syntax -- entrada adversária: comprova rejeição, nunca chama escrita.
    const e = await environment(async () => ({ ...step(), requests: [{ name: 'submitOrder', arguments: {} }] }) as never);
    const { operation } = await e.send();
    expect(operation).toMatchObject({ status: 'FAILED', error: { code: 'UNAVAILABLE' } });
    expect(e.env.mcp.searchArgs).toHaveLength(0);
    expect(e.store.snapshot(principal).version).toBe(0);
  });

  it('orçamento de chamadas interrompe antes do modelo e preserva a revisão', async () => {
    const budget = new SpendBudget({ maxCallsPerConversation: 1 });
    const e = await environment(async () => step({ requests: [search('bolo')] }), { budget });
    const { operation } = await e.send();
    expect(operation).toMatchObject({ status: 'FAILED', error: { code: 'LIMIT_EXCEEDED' } });
    expect(e.seen).toHaveLength(0); // o roteador também respeita o orçamento, antes de carregar fatos.
    expect(e.store.snapshot(principal).version).toBe(0);
  });

  it('limita ciclos e deduplica a mesma consulta proposta repetidamente', async () => {
    const e = await environment(async () => step({ requests: [search('bolo')] }), { maxRounds: 2 });
    const { operation } = await e.send();
    expect(operation).toMatchObject({ status: 'SUCCEEDED', completeness: 'PARTIAL' });
    expect(e.env.mcp.searchArgs).toHaveLength(1);
    expect(operation.snapshot!.pending.join(' ')).toContain('limite deste turno');
  });

  it('uma referência à destinatária mantém o foco sem copiar texto bruto da resposta anterior', async () => {
    const e = await environment(async input => step({ message: input.message.includes('chocolate') ? 'Chocolate é uma boa ideia para esse presente.' : 'Um bolo pode combinar com esse presente para sua namorada.' }));
    await e.send();
    await e.send('Ela gosta de chocolate');
    expect(e.seen[1]!.context.targets[0]?.label).toBe('namorada');
    expect(e.seen[1]!.context.previous).toEqual([]);
  });

  it('preserva alergia por pessoa e marca o item informativo como não elegível para consumo', async () => {
    const ana = recipient('Ana');
    const e = await environment(async input => input.message === 'Ana não tem restrições'
      ? step({ memoryActions: [{ action: 'DECLARE_NO_RESTRICTIONS', subjectRef: ana.ref, evidenceQuote: 'Ana não tem restrições' }] })
      : input.round === 1 ? step({ requests: [search('bolo')], memoryActions: [
        { action: 'REMEMBER_RESTRICTION', subjectRef: ana.ref, restriction: { kind: 'ALLERGY', code: 'MILK', requirement: 'MANDATORY' }, evidenceQuote: 'Ana, que tem alergia a leite' },
      ] }) : input.round === 2 ? step({ requests: [{ name: 'getItem', arguments: { itemRef: 'item_1' } }] })
        : step({ itemRefs: ['item_1'] }));
    const first = await e.send('Quero um bolo para Ana, que tem alergia a leite');
    expect(first.operation.status).toBe('SUCCEEDED');
    expect(JSON.stringify(first.operation.snapshot!.blocks)).toContain('Não elegível para consumo por Ana');
    const second = await e.send('Ana não tem restrições');
    expect(second.operation.status).toBe('SUCCEEDED');
    expect(second.operation.snapshot!.pending.join(' ')).toContain('confirmação específica');
    const linkId = (await e.env.links.status(ORG_A)).linkId!;
    expect(e.store.memory(principal).retrieve(linkId, [ana], 'FOOD')[0]?.restrictions).toEqual([{ kind: 'ALLERGY', code: 'MILK', requirement: 'MANDATORY' }]);
  });

  it('provedor não cooperativo é interrompido no prazo sem executar consultas posteriores', async () => {
    const e = await environment(async () => new Promise(() => undefined), { timeoutMs: 20 });
    const { operation } = await e.send();
    expect(operation).toMatchObject({ status: 'FAILED', error: { code: 'UNAVAILABLE' } });
    expect(e.env.mcp.searchArgs).toHaveLength(0);
    expect(e.store.snapshot(principal).version).toBe(0);
  });

  it('a montagem única HTTP passa pelo adaptador Gemini com a mesma chave no servidor', async () => {
    expect(loadConfig({ GEMINI_API_KEY: 'incidental' }).conversationModel).toBeUndefined();
    expect(() => loadConfig({ CONVERSATION_AGENT_MODE: 'structured' })).toThrow('CONVERSATION_AGENT_MODE');
    expect(() => loadConfig({ CONVERSATION_AGENT_MODE: 'anything' })).toThrow('CONVERSATION_AGENT_MODE');
    const dir = temporary();
    const cfg = loadConfig({ CONVERSATION_RUNTIME_ENABLED: 'true', BOT_TELEGRAM_ID: principal.botId,
      CONVERSATION_DB_FILE: dir.file, BOT_API_TOKEN: BOT_TOKEN, ALLOWED_ORGANIZER_IDS: ORG_A,
      CONVERSATION_MODEL_ENABLED: 'true', CONVERSATION_MODEL_PROVIDER: 'google', CONVERSATION_MODEL: 'gemini-3.8-flash',
      GEMINI_API_KEY: 'synthetic-assistant-key', CONVERSATION_MODEL_MAX_REQUESTS: '10' });
    const env = setup({ conversationRuntime: cfg.conversationRuntime, conversationModel: cfg.conversationModel });
    await connectAndConfirm(env, ORG_A);
    const transport = vi.fn<typeof fetch>(async (_url, init) => {
      const body = String(init?.body);
      expect(body).toContain('bolo');
      expect(body).not.toContain('synthetic-assistant-key');
      const input = JSON.parse(JSON.parse(body).contents[0].parts[0].text);
      if (input.round === undefined) return geminiReply({ targets: [{ kind: 'RECIPIENT', label: 'namorada', evidenceQuote: 'minha namorada' }], mentioned: [], purpose: 'FOOD', ambiguous: false });
      expect(body).toContain('searchOffers');
      return geminiReply(input.round === 1 ? step({ requests: [search('bolo')] })
        : input.round === 2 ? step({ requests: [{ name: 'getItem', arguments: { itemRef: 'item_1' } }] })
          : step({ itemRefs: ['item_1'] }));
    });
    const runtime = createConversationRuntime(env.cfg, env.links, transport)!;
    cleanup.push(() => { runtime.stop(); dir.clean(); });
    const addresses = new DeliveryAddresses(runtime.store, env.links);
    const choices = await addresses.review(principal);
    await addresses.select(principal, choices.options[0]!.choiceRef);
    const app = createApp({ config: env.cfg, links: env.links, conversations: runtime });
    const headers = { authorization: `Bearer ${BOT_TOKEN}`, 'x-telegram-user-id': ORG_A, 'x-telegram-chat-id': ORG_A, 'content-type': 'application/json' };
    const body = event(); body.input = { kind: 'TEXT', text: 'Quero comprar um bolo para minha namorada' };
    const response = await app.request(`/api/bot/v1/conversations/${ORG_A}/events`, { method: 'POST', headers, body: JSON.stringify(body) });
    expect(response.status).toBe(202);
    const accepted = await response.json();
    for (let i = 0; i < 60; i++) { runtime.tick(); await flush(); if (runtime.store.operation(principal, accepted.operationId).status === 'SUCCEEDED') break; await new Promise(r => setTimeout(r, 2)); }
    expect(runtime.store.operation(principal, accepted.operationId)).toMatchObject({ status: 'SUCCEEDED' });
    expect(transport).toHaveBeenCalledTimes(4);
    expect(runtime.store.snapshot(principal).blocks.some(b => b.kind === 'TEXT' && /Estimativa|Faixa:|A partir/.test(b.text))).toBe(true);
    const progress = await app.request(`/api/bot/v1/conversations/${ORG_A}/operations/${accepted.operationId}/progress`, { headers });
    expect(progress.headers.get('cache-control')).toBe('no-store');
    expect(await progress.json()).toMatchObject({ enabled: true, text: null });
  });
});

describe('executor de ferramentas e narração', () => {
  it('expõe só leitura e rejeita mensagem com preço inventado ou sucesso externo', () => {
    // eslint-disable-next-line no-restricted-syntax -- verifica ausência de ferramenta de envio.
    expect(ASSISTANT_TOOLS.map(t => t.name)).not.toContain('submitOrder');
    expect(AssistantStepSchema.safeParse({ ...step(), approvalRef: 'invented' }).success).toBe(false);
    expect(narration('Que lindo! Que tal uma flor?')).toContain('Que lindo');
    expect(narration('O bolo custa R$ 10,00')).toBe('');
    expect(narration('Seu pedido foi enviado')).toBe('');
  });

  it('converte filtros monetários uma vez e não passa IDs, endereço ou erros privados à IA', async () => {
    const args: unknown[] = [];
    const ctx: OperationalContext = { linkId: 'link-synthetic', cache: {} as never, deps: {
      listAddresses: async () => ({ results: [ADDRESS] }),
      searchOffers: async a => { args.push(a); return listing(); }, getItem: async () => detail(cake.itemId),
    } };
    const tools = new AssistantTools({ links: {
      withOperational: async (_org, _op, fn) => fn(ctx),
      status: async () => ({ linkId: ctx.linkId, state: 'CONNECTED', operational: true }) as never,
    }, organizerId: ORG_A, linkId: ctx.linkId, signal: new AbortController().signal,
    selectedAddress: () => ({ addressId: ADDRESS.addressId, addressHash: contentHash(ADDRESS) }) });
    const result = await tools.execute({ name: 'searchOffers', arguments: { query: 'bolo', refinements: { maxItemPriceCents: 5990, maxDeliveryFeeCents: 0 } } });
    expect(args[0]).toMatchObject({ refinements: { maxItemPrice: 59.9, maxDeliveryFee: 0 }, pageSize: 6 });
    expect(JSON.stringify(result)).not.toContain(cake.itemId);
    expect(await tools.execute({ name: 'getItem', arguments: { itemRef: 'item_999' } })).toMatchObject({ error: { code: 'UNOBSERVED_REFERENCE' } });
  });
});
