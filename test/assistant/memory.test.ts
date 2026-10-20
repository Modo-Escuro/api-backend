// Persistência/isolamento reais, modelos e MCP inteiramente sintéticos. Nenhuma credencial externa.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAssistantProcessor } from '../../src/server/assistant/processor';
import type { AssistantInput, AssistantModel, AssistantStep } from '../../src/server/assistant/protocol';
import { selectAudience, type AudienceInput, type AudienceModel, type AudienceProposal } from '../../src/server/assistant/audience';
import { recipient, SELF, validateMemoryAction, type MemoryAction } from '../../src/server/assistant/memory';
import { contentHash } from '../../src/server/contracts/guards';
import type { IfoodLinkService, OperationalContext } from '../../src/server/links/service';
import { TurnRuntime } from '../../src/server/turns/runtime';
import { TurnStore, SCHEMA_VERSION } from '../../src/server/turns/store';
import { ADDRESS, fx, ITEMS } from '../helpers/fakes';
import { event, flush, principal, temporary } from '../turns/helpers';

const girlfriend = recipient('namorada');
const mother = recipient('mãe');
const ownAllergy = 'Eu sou alérgico a amendoim.';
const herAllergy = 'Minha namorada é alérgica a leite.';
const herIntolerance = 'Minha namorada é intolerante à lactose.';
const ownRequest = 'Quero uma pizza para mim.';
const herRequest = 'Quero um bolo para minha namorada.';
const flowers = 'Quero flores para minha namorada.';
const self = { kind: 'SELF' as const };
const who = (label: string, evidenceQuote: string) => ({ kind: 'RECIPIENT' as const, label, evidenceQuote });

/** Roteiro de teste, não é fallback de produção nem teste de compreensão de linguagem pelo Gemini. */
function route(input: AudienceInput): AudienceProposal {
  let targets: AudienceProposal['targets'] = [self];
  let ambiguous = false;
  if (input.message.includes('namorada')) targets = [who('namorada', 'namorada')];
  else if (input.message.includes('minha mãe')) targets = [who('mãe', 'minha mãe')];
  else if (input.message.includes('nós dois')) {
    const p = input.previousTargets.filter(p => p.kind === 'RECIPIENT');
    if (p.length === 1) targets = [self, who(p[0]!.label, 'nós dois')]; else ambiguous = true;
  } else if (/\bela\b/iu.test(input.message)) {
    const p = input.previousTargets;
    if (p.length === 1 && p[0]?.kind === 'RECIPIENT') targets = [who(p[0].label, input.message.includes('Ela') ? 'Ela' : 'ela')];
    else ambiguous = true;
  }
  const declaration = /alérgic|intolerante|gosta|sem lactose|sem glúten|restrições/iu.test(input.message);
  return { targets, mentioned: declaration ? targets : [],
    purpose: /flores|rosas|presente/iu.test(input.message) ? 'NON_FOOD' : 'FOOD', ambiguous };
}

function declared(message: string): MemoryAction[] {
  if (message === ownAllergy) return [{ action: 'REMEMBER_RESTRICTION', subjectRef: 'SELF', restriction: { kind: 'ALLERGY', code: 'PEANUT', requirement: 'MANDATORY' }, evidenceQuote: message }];
  if (message === herAllergy) return [{ action: 'REMEMBER_RESTRICTION', subjectRef: girlfriend.ref, restriction: { kind: 'ALLERGY', code: 'MILK', requirement: 'MANDATORY' }, evidenceQuote: message }];
  if (message === herIntolerance) return [{ action: 'REMEMBER_RESTRICTION', subjectRef: girlfriend.ref, restriction: { kind: 'DIETARY', code: 'LACTOSE_FREE', requirement: 'MANDATORY' }, evidenceQuote: message }];
  if (message === 'Ela gosta de chocolate.') return [{ action: 'REMEMBER_PREFERENCE', subjectRef: girlfriend.ref, category: 'FOOD', value: 'chocolate', evidenceQuote: message }];
  if (message === 'Minha namorada gosta de rosas.') return [{ action: 'REMEMBER_PREFERENCE', subjectRef: girlfriend.ref, category: 'GIFT', value: 'rosas', evidenceQuote: message }];
  if (message === 'Eu prefiro sem glúten.') return [{ action: 'REMEMBER_RESTRICTION', subjectRef: 'SELF', restriction: { kind: 'DIETARY', code: 'GLUTEN_FREE', requirement: 'PREFERENCE' }, evidenceQuote: message }];
  return [];
}
const page = fx('searchOffers-pizza.json');
const item = page.results.find((r: { itemId: string }) => ITEMS.has(r.itemId));

describe('memória da conta, titular e destinatários', () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => { cleanups.splice(0).forEach(f => f()); vi.restoreAllMocks(); });

  function environment(overrides: {
    route?: (input: AudienceInput) => AudienceProposal;
    reply?: (input: AssistantInput) => Promise<AssistantStep>;
  } = {}) {
    const dir = temporary();
    let time = 1_800_000_000_000, linkId = 'synthetic-authenticated-link-A', n = 0;
    let store = new TurnStore(dir.file, {}, () => time);
    const inputs: AssistantInput[] = [], routingInputs: AudienceInput[] = [], searches: unknown[] = [];
    const links: Pick<IfoodLinkService, 'status' | 'withOperational'> = {
      status: vi.fn(async () => ({ state: 'CONNECTED', linkId, operational: true }) as never),
      withOperational: async (_org, _op, fn) => fn({ linkId, cache: {} as never, deps: {
        listAddresses: async () => ({ results: [ADDRESS] }),
        searchOffers: async args => { searches.push(structuredClone(args)); return { results: [item], hasMore: false }; },
        getItem: async args => structuredClone(ITEMS.get(args.itemId)),
      } } as OperationalContext),
    };
    const audienceModel: AudienceModel = { id: 'scripted-router', propose: async r => {
      routingInputs.push(structuredClone(r.input)); return (overrides.route ?? route)(r.input);
    } };
    const model: AssistantModel = { id: 'scripted-planner', propose: async r => {
      const input = structuredClone(r.input); inputs.push(input);
      if (overrides.reply) return overrides.reply(input);
      const facts = declared(input.message);
      if (facts.length) return { message: 'Informação registrada para essa pessoa.', requests: [], itemRefs: [], memoryActions: facts };
      if (input.round === 1) return { message: 'Vou procurar opções para esse pedido.', requests: [{ name: 'searchOffers', arguments: {
        query: input.context.purpose === 'NON_FOOD' ? 'flores' : 'bolo', merchantType: input.context.purpose === 'NON_FOOD' ? 'SHOPPING' : 'RESTAURANT',
      } }], itemRefs: [] };
      if (input.round === 2) return { message: '', requests: [{ name: 'getItem', arguments: { itemRef: 'item_1' } }], itemRefs: [] };
      return { message: 'Estas são as opções consultadas.', requests: [], itemRefs: ['item_1'] };
    } };
    const build = () => new TurnRuntime(store, { processor: createAssistantProcessor({ model, audienceModel, links,
      selectedAddress: () => ({ addressId: ADDRESS.addressId, addressHash: contentHash(ADDRESS) }) }) });
    let runtime = build();
    cleanups.push(() => { runtime.stop(); dir.clean(); });
    const send = async (message: string, p = principal) => {
      let version = 0;
      try { version = store.snapshot(p).version; } catch { /* primeira mensagem */ }
      const e = event(++n, version); e.conversationId = p.conversationId; e.source.conversationId = p.conversationId;
      e.input = { kind: 'TEXT', text: message };
      const accepted = runtime.accept(p, e);
      for (let i = 0; i < 100; i++) {
        runtime.tick(); await flush();
        const op = store.operation(p, accepted.operation.operationId);
        if (!['ACCEPTED', 'RUNNING'].includes(op.status)) return { op, event: e };
        await new Promise(r => setTimeout(r, 2));
      }
      throw new Error('turn did not finish');
    };
    return { send, inputs, routingInputs, searches, dir,
      get store() { return store; }, get runtime() { return runtime; }, get linkId() { return linkId; },
      useAccount: (id: string) => { linkId = id; }, advance: (ms: number) => { time += ms; },
      restart: () => { runtime.stop(); store = new TurnStore(dir.file, {}, () => time); runtime = build(); },
    };
  }

  it('não envia a alergia dela em pedido do titular, inclusive após reinício e com texto histórico contaminado', async () => {
    const e = environment();
    expect((await e.send(ownAllergy)).op.status).toBe('SUCCEEDED');
    expect((await e.send(herAllergy)).op.status).toBe('SUCCEEDED');
    // Mesmo se uma versão anterior deixou a condição no snapshot, não é usado como memória do novo turno.
    const raw = e.store.db.prepare('SELECT scope,snapshot FROM conversations').get()!;
    const old = JSON.parse(String(raw['snapshot']));
    old.blocks.push({ kind: 'TEXT', source: 'MODEL', text: 'Sua namorada tem alergia a leite, MILK.' });
    e.store.db.prepare('UPDATE conversations SET snapshot=? WHERE scope=?').run(JSON.stringify(old), String(raw['scope']));
    e.restart(); e.inputs.length = 0;
    const { op } = await e.send(ownRequest);
    expect(op.status).toBe('SUCCEEDED');
    for (const input of e.inputs) {
      expect(input.context.targets).toEqual([SELF]);
      expect(input.context.people[0]?.restrictions).toEqual([{ kind: 'ALLERGY', code: 'PEANUT', requirement: 'MANDATORY' }]);
      expect(JSON.stringify(input)).not.toMatch(/MILK|namorada|leite/);
      expect(input.context.previous).toEqual([]);
    }
    expect(e.store.db.prepare('SELECT domain FROM conversations').get()!['domain']).toBeNull();
  });

  it('recupera somente o perfil dela quando o pedido volta a ser para ela', async () => {
    const e = environment();
    await e.send(ownAllergy); await e.send(herAllergy); await e.send(ownRequest);
    e.inputs.length = 0;
    const { op } = await e.send(herRequest);
    expect(op.status).toBe('SUCCEEDED');
    for (const input of e.inputs) {
      expect(input.context.people).toHaveLength(1);
      expect(input.context.people[0]).toMatchObject({ ref: girlfriend.ref, kind: 'RECIPIENT', restrictions: [{ code: 'MILK' }] });
      expect(JSON.stringify(input)).not.toContain('PEANUT');
    }
    expect(JSON.stringify(op.snapshot)).toContain('Não elegível para consumo por namorada');
  });

  it('flores recuperam preferências de presente, sem sequer ler os fatos alimentares no SQL', async () => {
    const e = environment();
    await e.send(herAllergy); await e.send('Ela gosta de chocolate.'); await e.send('Minha namorada gosta de rosas.');
    const sql = vi.spyOn(e.store.db, 'prepare');
    e.inputs.length = 0;
    const { op } = await e.send(flowers);
    expect(op.status).toBe('SUCCEEDED');
    for (const input of e.inputs) {
      expect(input.context.people[0]).toEqual({ ...girlfriend, preferences: [{ category: 'GIFT', value: 'rosas' }] });
      expect(JSON.stringify(input)).not.toMatch(/MILK|chocolate|allerg|restrictions/);
      expect(input.context.previous).toEqual([]);
    }
    const reads = sql.mock.calls.map(([statement]) => statement).filter(s => s.startsWith('SELECT fact FROM'));
    expect(reads.length).toBeGreaterThan(0);
    for (const read of reads) { expect(read).not.toMatch(/ALLERGY|DIETARY|NO_RESTRICTIONS|PREFERENCE:FOOD/); }
    expect(JSON.stringify(op.snapshot)).not.toContain('Não elegível para consumo');
  });

  it('“ela” resolve para a destinatária atual; após pedido para mim, pede esclarecimento sem recuperar perfil', async () => {
    const e = environment();
    await e.send(herAllergy);
    expect((await e.send('Ela gosta de chocolate.')).op.status).toBe('SUCCEEDED');
    expect(e.store.memory(principal).retrieve(e.linkId, [girlfriend], 'FOOD')[0]?.preferences).toContainEqual({ category: 'FOOD', value: 'chocolate' });
    await e.send(ownRequest);
    e.inputs.length = 0;
    const read = vi.spyOn(e.store.db, 'prepare');
    const { op } = await e.send('Quero um presente para ela.');
    expect(op.status).toBe('SUCCEEDED');
    expect(JSON.stringify(op.snapshot)).toContain('Para quem é este pedido?');
    expect(e.inputs).toHaveLength(0);
    expect(read.mock.calls.some(([s]) => s.startsWith('SELECT fact FROM'))).toBe(false);
  });

  it('“nós dois” recupera perfis separados e não transforma a alergia dela em condição do titular', async () => {
    const e = environment(); await e.send(ownAllergy); await e.send(herAllergy);
    e.inputs.length = 0;
    expect((await e.send('Quero algo para nós dois.')).op.status).toBe('SUCCEEDED');
    const people = e.inputs[0]!.context.people;
    expect(people.find(p => p.ref === 'SELF')?.restrictions).toEqual([{ kind: 'ALLERGY', code: 'PEANUT', requirement: 'MANDATORY' }]);
    expect(people.find(p => p.ref === girlfriend.ref)?.restrictions).toEqual([{ kind: 'ALLERGY', code: 'MILK', requirement: 'MANDATORY' }]);
  });

  it('trocar a conta ou o organizador não reutiliza fatos, resumo nem foco da conta anterior', async () => {
    const e = environment(); await e.send(herAllergy);
    e.useAccount('synthetic-authenticated-link-B'); e.inputs.length = 0;
    await e.send(ownRequest);
    expect(JSON.stringify(e.inputs)).not.toMatch(/MILK|namorada/);
    expect(e.routingInputs.at(-1)?.recipients).toEqual([]);
    e.useAccount('synthetic-authenticated-link-A'); e.inputs.length = 0;
    await e.send(ownRequest, { ...principal, organizerId: '222222222', conversationId: '222222222' });
    expect(e.routingInputs.at(-1)?.recipients).toEqual([]);
    expect(JSON.stringify(e.inputs)).not.toContain('MILK');
    e.inputs.length = 0;
    await e.send(herRequest);
    expect(JSON.stringify(e.inputs)).toContain('MILK');
    e.useAccount('synthetic-reconnected-link-A2'); e.inputs.length = 0;
    await e.send(herRequest);
    expect(JSON.stringify(e.inputs)).not.toContain('MILK'); // link novo não é prova de mesma conta.
  });

  it('o roteador recebe somente diretório e foco, nunca condições persistidas ou respostas antigas', async () => {
    const e = environment(); await e.send(ownAllergy); await e.send(herAllergy); await e.send(herRequest);
    const input = e.routingInputs.at(-1)!;
    expect(Object.keys(input).sort()).toEqual(['message', 'previousPurpose', 'previousTargets', 'recipients']);
    expect(JSON.stringify(input)).not.toMatch(/PEANUT|MILK|restrictions|preferences|synthetic-authenticated/);
  });

  it('troca de vínculo durante o roteamento bloqueia antes de ler fatos ou chamar a IA de compras', async () => {
    let switchAccount: () => void = () => undefined;
    const e = environment({ route: input => { if (input.message === ownRequest) switchAccount(); return route(input); } });
    await e.send(herAllergy);
    switchAccount = () => e.useAccount('synthetic-switched-link');
    e.inputs.length = 0;
    const sql = vi.spyOn(e.store.db, 'prepare');
    const { op } = await e.send(ownRequest);
    expect(op).toMatchObject({ status: 'FAILED', error: { code: 'LINK_CHANGED' } });
    expect(e.inputs).toHaveLength(0);
    expect(sql.mock.calls.some(([s]) => s.startsWith('SELECT fact FROM'))).toBe(false);
  });

  it('recusa recuperar um destinatário que o roteador inventou em pedido para mim', async () => {
    const e = environment({ route: () => ({ targets: [who('namorada', 'para mim')], mentioned: [], purpose: 'FOOD', ambiguous: false }) });
    const { op } = await e.send(ownRequest);
    expect(op.status).toBe('SUCCEEDED');
    expect(e.inputs).toHaveLength(0);
    expect(JSON.stringify(op.snapshot)).toContain('Para quem é este pedido?');
  });

  it('restrições usam declaração literal e não podem ser transferidas para outra pessoa por saída do modelo', async () => {
    const e = environment({ reply: async () => ({ message: 'Anotado.', requests: [], itemRefs: [], memoryActions: [{
      action: 'REMEMBER_RESTRICTION', subjectRef: 'SELF', restriction: { kind: 'ALLERGY', code: 'MILK', requirement: 'MANDATORY' }, evidenceQuote: herAllergy,
    }] }) });
    const { op } = await e.send(herAllergy);
    expect(op.status).toBe('SUCCEEDED');
    expect(e.store.memory(principal).retrieve(e.linkId, [SELF], 'FOOD')[0]?.restrictions).toEqual([]);
    expect(e.store.memory(principal).retrieve(e.linkId, [girlfriend], 'FOOD')[0]?.restrictions).toEqual([]);
    expect(op.snapshot!.pending.join(' ')).toContain('pessoa e declaração verificáveis');
  });

  it('intolerância sem lactose gera filtro próprio da destinatária e não é aplicada ao titular', async () => {
    const e = environment(); await e.send(herIntolerance);
    await e.send(herRequest);
    expect(e.searches.at(-1)).toMatchObject({ refinements: { itemRestrictions: ['LAC_FREE'] } });
    e.inputs.length = 0;
    await e.send(ownRequest);
    expect((e.searches.at(-1) as { refinements: unknown }).refinements).not.toHaveProperty('itemRestrictions');
    expect(JSON.stringify(e.inputs)).not.toContain('LACTOSE_FREE');
  });

  it('buscar bolo e flor juntos não aplica filtro de lactose à consulta de flores em Shopping', async () => {
    const e = environment({ reply: async input => {
      const facts = declared(input.message);
      if (facts.length) return { message: 'Registrado.', requests: [], itemRefs: [], memoryActions: facts };
      return input.round === 1 ? { message: 'Vou consultar as duas ideias.', requests: [
        { name: 'searchOffers', arguments: { query: 'bolo', merchantType: 'RESTAURANT' } },
        { name: 'searchOffers', arguments: { query: 'flor', merchantType: 'SHOPPING' } },
      ], itemRefs: [] } : { message: 'Consultas concluídas.', requests: [], itemRefs: [] };
    } });
    await e.send(herIntolerance); await e.send(herRequest);
    expect(e.searches.find(s => (s as { query: string }).query === 'bolo')).toMatchObject({ refinements: { itemRestrictions: ['LAC_FREE'] } });
    expect(e.searches.find(s => (s as { query: string }).query === 'flor')).not.toHaveProperty('refinements.itemRestrictions');
  });

  it('preferência não é convertida em filtro obrigatório e o modelo não cria participante genérico', async () => {
    const e = environment(); await e.send('Eu prefiro sem glúten.'); await e.send(ownRequest);
    expect((e.searches.at(-1) as { refinements: unknown }).refinements).not.toHaveProperty('itemRestrictions');
    const domain = JSON.parse(String(e.store.db.prepare('SELECT domain FROM conversations').get()!['domain']));
    expect(domain.participants).toHaveLength(1);
    expect(domain.participants[0]).toMatchObject({ displayName: 'Você',
      restrictions: { state: 'DECLARED', value: [{ key: { kind: 'DIETARY', code: 'GLUTEN_FREE', requirement: 'PREFERENCE' } }] } });
    expect(domain.bag).toBeUndefined();
    expect(domain.proposals).toHaveLength(1);
    expect(domain.proposals[0]).toMatchObject({ lines: [{ name: 'Promoção pizza grande', optionIds: expect.anything() }],
      coverage: [{ status: 'COVERED' }] });
    const account = e.store.memory(principal).directory(e.linkId);
    expect(account.recipients).toEqual([]);
    expect(e.inputs.at(-1)!.context.people[0]).toMatchObject({ ref: 'SELF', label: 'Você', kind: 'SELF' });
  });

  it('falha posterior ao planejamento não grava fatos, perfil ou revisão parcial', async () => {
    const e = environment({ reply: async input => {
      if (input.round > 1) throw new Error('synthetic provider failure');
      return { message: 'Vou consultar.', requests: [{ name: 'searchOffers', arguments: { query: 'bolo' } }], itemRefs: [], memoryActions: declared(herAllergy) };
    } });
    const { op } = await e.send(herAllergy);
    expect(op).toMatchObject({ status: 'FAILED', error: { code: 'UNAVAILABLE' } });
    expect(e.store.snapshot(principal).version).toBe(0);
    expect(e.store.memory(principal).directory(e.linkId)).toMatchObject({ revision: 0, recipients: [], previous: null });
    expect(e.store.db.prepare('SELECT count(*) AS n FROM assistant_memory_facts').get()!['n']).toBe(0);
  });

  it('replay não reaplica memória e o armazenamento guarda origem/hash sem o trecho bruto declarado', async () => {
    const e = environment(); const { event: saved, op } = await e.send(herAllergy);
    expect(op.status).toBe('SUCCEEDED');
    const before = e.store.memory(principal).directory(e.linkId).revision;
    e.runtime.accept(principal, saved); e.runtime.tick(); await flush();
    expect(e.store.memory(principal).directory(e.linkId).revision).toBe(before);
    const fact = JSON.parse(String(e.store.db.prepare('SELECT fact FROM assistant_memory_facts').get()!['fact']));
    expect(fact).toMatchObject({ originEventId: saved.eventId, action: { subjectRef: girlfriend.ref, restriction: { code: 'MILK' } } });
    expect(fact.evidenceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(fact)).not.toContain(herAllergy);
    expect(fact.action).not.toHaveProperty('evidenceQuote');
  });

  it('limpar perfil e expiração D7 removem memória pessoal, com schema atualizado', async () => {
    const e = environment(); await e.send(herAllergy);
    expect((await e.send('Confirmo: apagar todos os dados deste pedido.')).op.status).toBe('SUCCEEDED');
    expect(e.store.memory(principal).directory(e.linkId).recipients).toEqual([]);
    await e.send(herAllergy);
    e.advance(24 * 60 * 60_000 + 1); e.runtime.tick(); await flush();
    expect(e.store.memory(principal).directory(e.linkId).recipients).toEqual([]);
    expect(e.store.db.prepare('SELECT count(*) AS n FROM assistant_memory_facts').get()!['n']).toBe(0);
    expect(Number(e.store.db.prepare('PRAGMA user_version').get()!['user_version'])).toBe(SCHEMA_VERSION);
  });

  it('não reusa pronome depois de expirar o foco curto e mantém apenas o diretório de destinatários', async () => {
    const e = environment(); await e.send(herAllergy);
    e.advance(16 * 60_000); e.inputs.length = 0;
    const { op } = await e.send('Quero algo para ela.');
    expect(e.inputs).toHaveLength(0);
    expect(JSON.stringify(op.snapshot)).toContain('Para quem é este pedido?');
  });

  it('confirmação digitada removedora apaga a destinatária com o conteúdo dela, antes dos modelos', async () => {
    const e = environment();
    await e.send(herAllergy);
    e.inputs.length = 0; e.routingInputs.length = 0;
    const { op } = await e.send('Confirmo: remover namorada do pedido.');
    expect(op.status).toBe('SUCCEEDED');
    expect(JSON.stringify(op.snapshot)).toContain('Removi namorada e seus dados da memória.');
    expect(e.routingInputs).toHaveLength(0);
    expect(e.inputs).toHaveLength(0);
    const directory = e.store.memory(principal).directory(e.linkId);
    expect(directory.recipients).toEqual([]);
    // A memória do vínculo anterior não vaza; uma nova declaração recomeça do zero.
    const { op: readd } = await e.send(herAllergy);
    expect(readd.status).toBe('SUCCEEDED');
    expect(e.store.memory(principal).retrieve(e.linkId, [girlfriend], 'FOOD')[0]?.restrictions)
      .toEqual([{ kind: 'ALLERGY', code: 'MILK', requirement: 'MANDATORY' }]);
  });

  it('confirmação digitada do titular apaga só os dados dele, mantendo o vínculo e a persona', async () => {
    const e = environment();
    await e.send(ownAllergy); await e.send(herAllergy);
    const { op } = await e.send('Confirmo: apagar meus dados da memória.');
    expect(op.status).toBe('SUCCEEDED');
    expect(JSON.stringify(op.snapshot)).toContain('Apaguei seus dados desta memória. Você continua como titular.');
    expect(e.store.memory(principal).retrieve(e.linkId, [SELF], 'FOOD')[0]?.restrictions).toEqual([]);
    expect(e.store.memory(principal).retrieve(e.linkId, [girlfriend], 'FOOD')[0]?.restrictions)
      .toEqual([{ kind: 'ALLERGY', code: 'MILK', requirement: 'MANDATORY' }]);
    const again = await e.send('Confirmo: apagar meus dados da memória.');
    expect(JSON.stringify(again.op.snapshot)).toContain('Não há dados seus registrados nesta memória.');
  });

  it('nome inexistente na confirmação digitada não altera a memória', async () => {
    const e = environment();
    await e.send(herAllergy);
    const { op } = await e.send('Confirmo: remover prima do pedido.');
    expect(op.status).toBe('SUCCEEDED');
    expect(JSON.stringify(op.snapshot)).toContain('Não encontrei prima nesta memória; nada foi alterado.');
    expect(e.store.memory(principal).retrieve(e.linkId, [girlfriend], 'FOOD')[0]?.restrictions)
      .toEqual([{ kind: 'ALLERGY', code: 'MILK', requirement: 'MANDATORY' }]);
    expect(e.store.memory(principal).directory(e.linkId).recipients).toEqual([girlfriend]);
  });
});

describe('validação de referência de pessoa antes da recuperação', () => {
  it('não transfere frase em terceira pessoa para SELF nem disfarça condição alimentar como preferência', () => {
    const quote = 'Ela é alérgica a leite.';
    expect(validateMemoryAction({ action: 'REMEMBER_RESTRICTION', subjectRef: 'SELF', restriction: { kind: 'ALLERGY', code: 'MILK', requirement: 'MANDATORY' }, evidenceQuote: quote },
      quote, [SELF, girlfriend], 'FOOD')).toContain('não foi atribuída ao titular');
    expect(validateMemoryAction({ action: 'REMEMBER_PREFERENCE', subjectRef: girlfriend.ref, category: 'FOOD', value: 'leite', evidenceQuote: herAllergy },
      herAllergy, [girlfriend], 'FOOD')).toContain('não é uma preferência');
    expect(validateMemoryAction({ action: 'REMEMBER_RESTRICTION', subjectRef: girlfriend.ref, restriction: { kind: 'DIETARY', code: 'LACTOSE_FREE', requirement: 'PREFERENCE' }, evidenceQuote: herIntolerance },
      herIntolerance, [girlfriend], 'FOOD')).toContain('não foi registrada como preferência');
    expect(validateMemoryAction({ action: 'REMEMBER_RESTRICTION', subjectRef: 'SELF', restriction: { kind: 'DIETARY', code: 'GLUTEN_FREE', requirement: 'MANDATORY' }, evidenceQuote: 'Eu prefiro sem glúten.' },
      'Eu prefiro sem glúten.', [SELF], 'FOOD')).toContain('não foi convertida em obrigação');
  });

  it('não usa o nome de outra pessoa ou uma negação como autorização de perfil', () => {
    const directory = { revision: 1, recipients: [girlfriend, mother], previous: null };
    const result = selectAudience({ targets: [who('namorada', 'namorada')], mentioned: [], purpose: 'FOOD', ambiguous: false },
      'Não é para minha namorada, é para mim.', directory);
    expect(result.question).not.toBeNull();
    expect(result.targets).toEqual([]);
  });

  it('não confunde fragmentos de palavras com nomes ou pronomes', () => {
    const ana = recipient('Ana');
    const directory = { revision: 1, recipients: [ana, girlfriend],
      previous: { targets: [girlfriend], purpose: 'FOOD' as const, queries: [] } };
    const banana = selectAudience({ targets: [who('Ana', 'banana')], mentioned: [], purpose: 'FOOD', ambiguous: false },
      'Quero comprar banana.', directory);
    expect(banana.question).not.toBeNull();
    const table = selectAudience({ targets: [who('namorada', 'ela')], mentioned: [], purpose: 'UNKNOWN', ambiguous: false },
      'Quero uma tabela.', directory);
    expect(table.question).not.toBeNull();
  });
});
