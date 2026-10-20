// Fecho da sacola do assistente: composição de propostas, escolha digitada e coexistência com a memória.
// Persistência real no TurnStore, ferramentas e modelos sintéticos, respostas MCP dos fixtures reais.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAssistantProcessor } from '../../src/server/assistant/processor';
import type { AssistantInput, AssistantModel } from '../../src/server/assistant/protocol';
import type { AudienceInput, AudienceModel, AudienceProposal } from '../../src/server/assistant/audience';
import type { MemoryAction } from '../../src/server/assistant/memory';
import { contentHash } from '../../src/server/contracts/guards';
import type { IfoodLinkService, OperationalContext } from '../../src/server/links/service';
import { TurnRuntime } from '../../src/server/turns/runtime';
import { TurnStore } from '../../src/server/turns/store';
import { ADDRESS, fx, ITEMS } from '../helpers/fakes';
import { event, flush, principal, temporary } from '../turns/helpers';

const ownAllergy = 'Eu sou alérgico a amendoim.';
const ownRequest = 'Quero uma pizza para mim.';
const ownPreference = 'Eu prefiro sem glúten.';
const self = { kind: 'SELF' as const };

function route(input: AudienceInput): AudienceProposal {
  const declaration = /alérgic|sem lactose|sem glúten/iu.test(input.message);
  return { targets: [self], mentioned: declaration ? [self] : [], purpose: 'FOOD', ambiguous: false };
}

function declared(message: string): MemoryAction[] {
  if (message === ownAllergy) return [{ action: 'REMEMBER_RESTRICTION', subjectRef: 'SELF',
    restriction: { kind: 'ALLERGY', code: 'PEANUT', requirement: 'MANDATORY' }, evidenceQuote: message }];
  if (message === ownPreference) return [{ action: 'REMEMBER_RESTRICTION', subjectRef: 'SELF',
    restriction: { kind: 'DIETARY', code: 'GLUTEN_FREE', requirement: 'PREFERENCE' }, evidenceQuote: message }];
  return [];
}

type PurchaseJson = {
  proposals?: { proposalId: string; merchantId: string; lines: { name: string; consumerIds: string[]; unitMinCents: number }[]; coverage: { participantId: string; status: string }[] }[];
  bag?: { lines: { name: string }[] }; participants?: unknown[];
};

describe('sacola do assistente (cartões → DATA-01)', () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => { cleanups.splice(0).forEach(f => f()); vi.restoreAllMocks(); });

  function environment(): {
    send(message: string): Promise<{ op: { status: string; snapshot?: { blocks: { kind: string; text?: string }[] } | null }; event: unknown }>;
    inputs: AssistantInput[];
    searches: unknown[];
    domain(): PurchaseJson | null;
    dump(): unknown;
  } {
    const dir = temporary();
    const time = 1_800_000_000_000;
    const linkId = 'synthetic-authenticated-link-A';
    let n = 0;
    const store = new TurnStore(dir.file, {}, () => time);
    const inputs: AssistantInput[] = [], searches: unknown[] = [];
    const links: Pick<IfoodLinkService, 'status' | 'withOperational'> = {
      status: vi.fn(async () => ({ state: 'CONNECTED', linkId, operational: true }) as never),
      withOperational: async (_org, _op, fn) => fn({ linkId, cache: {} as never, deps: {
        listAddresses: async () => ({ results: [ADDRESS] }),
        searchOffers: async args => { searches.push(structuredClone(args)); return { results: [item], hasMore: false }; },
        getItem: async args => structuredClone(ITEMS.get(args.itemId)),
      } } as OperationalContext),
    };
    const audienceModel: AudienceModel = { id: 'scripted-router', propose: async r => route(r.input) };
    const model: AssistantModel = { id: 'scripted-planner', propose: async r => {
      const input = structuredClone(r.input); inputs.push(input);
      const facts = declared(input.message);
      if (facts.length) return { message: 'Registrado para essa pessoa.', requests: [], itemRefs: [], memoryActions: facts };
      if (input.round === 1) return { message: 'Vou procurar opções.', requests: [{ name: 'searchOffers', arguments: {
        query: 'pizza', merchantType: 'RESTAURANT' } }], itemRefs: [] };
      if (input.round === 2) return { message: '', requests: [{ name: 'getItem', arguments: { itemRef: 'item_1' } }], itemRefs: [] };
      return { message: 'Estas são as opções consultadas.', requests: [], itemRefs: ['item_1'] };
    } };
    const build = () => new TurnRuntime(store, { processor: createAssistantProcessor({ model, audienceModel, links,
      selectedAddress: () => ({ addressId: ADDRESS.addressId, addressHash: contentHash(ADDRESS) }) }) });
    const runtime = build();
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
    return {
      send, inputs, searches,
      domain: () => {
        const row: unknown = store.db.prepare('SELECT domain FROM conversations').get();
        return row === undefined || row === null || (row as Record<string, unknown>)['domain'] === null ? null
          : JSON.parse(String((row as Record<string, string>)['domain'])) as PurchaseJson;
      },
      dump: () => store.db.prepare('SELECT domain FROM conversations').get(),
    };
  }

  const page = fx('searchOffers-pizza.json');
  const item = page.results.find((r: { itemId: string }) => ITEMS.has(r.itemId));

  const chooseBag = async (e: ReturnType<typeof environment>) => {
    await e.send(ownPreference);
    return e.send(ownRequest);
  };

  it('pedido com item detalhado compõe proposta numerada no mesmo patch do participante', async () => {
    const e = environment();
    const { op } = await chooseBag(e);
    expect(op.status).toBe('SUCCEEDED');
    const domain = e.domain();
    expect(domain?.proposals).toHaveLength(1);
    const proposal = domain?.proposals?.[0];
    expect(proposal).toMatchObject({
      merchantId: item.merchant.merchantId,
      lines: [{ name: 'Promoção pizza grande', consumerIds: [proposal?.coverage[0]?.participantId] }],
      coverage: [{ status: 'COVERED' }],
    });
    const cards = op.snapshot?.blocks.filter(b => b.kind === 'TEXT' && String(b.text).startsWith('1.'));
    expect(cards).toHaveLength(1);
    expect(String(cards?.[0]?.text)).toContain('Promoção pizza grande');
  });

  it('escolha digitada por número fecha a sacola do escopo sem reexecutar modelos', async () => {
    const e = environment();
    await chooseBag(e);
    const inputs = e.inputs.length;
    const { op } = await e.send('Confirmo: escolher a opção 1.');
    expect(op.status).toBe('SUCCEEDED');
    expect(e.inputs.length).toBe(inputs);
    const domain = e.domain();
    expect(domain?.bag?.lines?.[0]?.name).toBe('Promoção pizza grande');
    expect(JSON.stringify(op.snapshot)).toContain('Sacola atual');
  });

  it('confirmar escolha de opção inexistente não altera estado e responde sem ambiguidade', async () => {
    const e = environment();
    await chooseBag(e);
    const before = e.domain();
    const { op } = await e.send('Confirmo: escolher a opção 9.');
    expect(op.status).toBe('SUCCEEDED');
    expect(JSON.stringify(op.snapshot)).toContain('Não reconheço a opção 9');
    expect(e.domain()?.proposals).toEqual(before?.proposals);
    expect(e.domain()?.bag).toBeUndefined();
  });

  it('escolher antes de qualquer busca responde com instrução e não cria compra', async () => {
    const e = environment();
    const { op } = await e.send('Confirmo: escolher a opção 1.');
    expect(op.status).toBe('SUCCEEDED');
    expect(JSON.stringify(op.snapshot)).toContain('Escape de escolha não reconhecida');
    expect(e.domain()).toBeNull();
  });

  it('busca nova sem detalhe invalida os números da lista antiga', async () => {
    const e = environment();
    await chooseBag(e);
    vi.spyOn(ITEMS, 'get').mockReturnValue(undefined);
    expect((await e.send(ownRequest)).op.status).toBe('SUCCEEDED');
    expect(e.domain()?.proposals ?? []).toHaveLength(0);
    const { op } = await e.send('Confirmo: escolher a opção 1.');
    expect(JSON.stringify(op.snapshot)).toContain('Não reconheço a opção 1');
    expect(e.domain()?.bag).toBeUndefined();
  });

  it('alergia desconhecida bloqueia composição: nenhuma proposta, nenhum participante gravado', async () => {
    const e = environment();
    await e.send(ownAllergy);
    expect(e.domain()).toBeNull();
    const { op } = await e.send(ownRequest);
    expect(op.status).toBe('SUCCEEDED');
    const domain = e.domain();
    expect(domain?.proposals ?? []).toHaveLength(0);
    expect(domain?.participants ?? []).toHaveLength(0);
    const numbered = (op.snapshot?.blocks ?? []).filter(b => b.kind === 'TEXT' && /^\d+\./.test(String(b.text)));
    expect(numbered).toHaveLength(0);
    expect(e.domain()).toBeNull();
  });
});
