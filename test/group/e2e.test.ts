// GRP-01 ponta a ponta: mensagem → agente → leitura MCP (fixtures reais) → propostas → sacola simulada → SQLite.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConversationEvent, Operation } from '../../src/server/contracts/conversation';
import { DeterministicModel } from '../../src/server/agent/mock-model';
import { createAgentProcessor } from '../../src/server/agent/processor';
import type { ConversationModel } from '../../src/server/agent/model';
import { linkedProposalProvider } from '../../src/server/services/group';
import { TurnRuntime } from '../../src/server/turns/runtime';
import { TurnStore } from '../../src/server/turns/store';
import { ORG_A, ORG_B, connectAndConfirm, setup } from '../helpers/fakes';
import { flush, temporary } from '../turns/helpers';

const BOT = '900001';
const principalOf = (org: string) => ({ organizerId: org, botId: BOT, conversationId: org });
function msg(n: number, text: string, expectedVersion: number, org = ORG_A): ConversationEvent {
  return { contractVersion: '1.0', eventId: `tg-update-${n}`, conversationId: org, expectedVersion,
    source: { channel: 'TELEGRAM', botId: BOT, conversationId: org, kind: 'MESSAGE', messageId: String(n) }, input: { kind: 'TEXT', text } };
}
const READ_TOOLS = new Set(['listAddresses', 'searchOffers', 'getItem']);

describe('GRP-01 ponta a ponta com AI-02 + DATA-01 + RUN-01', () => {
  const cleanup: (() => void)[] = [];
  afterEach(() => { cleanup.splice(0).forEach((f) => f()); vi.restoreAllMocks(); });

  type Provider = Parameters<typeof createAgentProcessor>[0]['proposals'];
  async function world(custom?: (env: ReturnType<typeof setup>) => Provider, proposalsTimeoutMs?: number, model: ConversationModel = new DeterministicModel()) {
    const env = setup();
    await connectAndConfirm(env, ORG_A);
    await connectAndConfirm(env, ORG_B);
    const dir = temporary();
    const make = () => new TurnRuntime(new TurnStore(dir.file), { processor: createAgentProcessor({
      model, linkOf: async (org) => (await env.links.status(org)).linkId,
      proposals: custom ? custom(env) : linkedProposalProvider(env.links), timeoutMs: 5_000,
      ...(proposalsTimeoutMs ? { proposalsTimeoutMs } : {}),
    }) });
    let runtime = make();
    cleanup.push(() => { runtime.stop(); dir.clean(); });
    let n = 0;
    const send = async (text: string, org = ORG_A): Promise<Operation> => {
      const p = principalOf(org);
      const version = (() => { try { return runtime.store.snapshot(p).version; } catch { return 0; } })();
      const a = runtime.accept(p, msg(++n, text, version, org));
      for (let i = 0; i < 80; i++) {
        runtime.tick(); await flush();
        const op = runtime.store.operation(p, a.operation.operationId);
        if (!['ACCEPTED', 'RUNNING'].includes(op.status)) return op;
        await new Promise((r) => setTimeout(r, 5));
      }
      throw new Error('operação não terminou');
    };
    const domain = (org = ORG_A) => {
      const r = runtime.store.db.prepare('SELECT domain FROM conversations WHERE scope LIKE ?').get(`%"${org}"%`);
      return r?.['domain'] ? JSON.parse(String(r['domain'])) : null;
    };
    const restart = () => { runtime.stop(); runtime = make(); };
    return { env, send, domain, restart, get runtime() { return runtime; } };
  }

  it('grupo → sugestões → escolha → mudança de teto → saída de participante, sem escrita no MCP', async () => {
    const w = await world();
    // Este cenário continua sem catálogo alimentar classificado. A ampliação filtrada não pode
    // reapresentar a fixture sem filtro como se fosse nova evidência de vegetarianismo.
    w.env.mcp.searchPages.push({ results: [], hasMore: false });
    await w.send('Somos Ana, Bia e Caio. Ana não tem restrição. Bia é vegetariana. Caio é alérgico a leite');
    const s1 = w.domain();
    const [ana, bia, caio] = s1.participants.map((p: { participantId: string }) => p.participantId);

    const sug = await w.send('Sugere pizza');
    expect(sug.status).toBe('SUCCEEDED');
    expect(sug.snapshot!.phase).toBe('PROPOSALS_READY');
    const proposals = sug.snapshot!.blocks.filter((b) => b.kind === 'PROPOSAL');
    expect(proposals.length).toBeGreaterThan(0);
    for (const p of proposals) {
      expect(p).toMatchObject({ price: { kind: 'UNKNOWN' } });
      expect(p.kind === 'PROPOSAL' && Object.fromEntries(p.coverage.map((c) => [c.participantRef, c.status])))
        .toEqual({ [ana]: 'COVERED', [bia]: 'COVERED', [caio]: 'BLOCKED' }); // Bia: dieta sem dado ⇒ aviso; Caio: leite informado ⇒ conflito
    }
    expect(sug.snapshot!.pending.join(' ')).toMatch(/Busca limitada/);
    expect(w.domain().proposals).toHaveLength(proposals.length);

    const chosen = await w.send('Quero a proposta 1');
    expect(chosen.snapshot!.phase).toBe('EDITING_CART');
    const review = chosen.snapshot!.blocks.find((b) => b.kind === 'REVIEW')!;
    expect(review.kind === 'REVIEW' && review.blockers).toEqual(expect.arrayContaining([
      'Total do pedido desconhecido: a taxa de serviço só aparece no carrinho.',
      'Sacola simulada: aprovação e pedido ainda não estão disponíveis nesta etapa.',
    ]));
    expect(chosen.snapshot!.humanApproval).toBeNull();
    expect(chosen.snapshot!.blocks.some((b) => b.kind === 'OUTCOME')).toBe(false);
    expect(w.domain()).toMatchObject({ bag: { status: 'CURRENT' }, merchant: { state: 'DECLARED' } });
    expect(w.domain().bag.lines.map((l: { consumerIds: string[] }) => l.consumerIds[0]).sort()).toEqual([ana, bia].sort()); // Caio fica fora: conflito informado

    const capped = await w.send('Teto de R$ 50');
    expect(w.domain().bag.status).toBe('NEEDS_REVALIDATION');
    expect(w.domain().proposals).toBeUndefined();
    const review2 = capped.snapshot!.blocks.find((b) => b.kind === 'REVIEW')!;
    expect(review2.kind === 'REVIEW' && review2.blockers).toContain('A compra mudou depois da escolha; peça novas sugestões.');

    await w.send('remove a Ana da compra');
    // Sem consumo órfão: nenhuma linha restante aponta para quem saiu.
    expect((w.domain().bag?.lines ?? []).every((l: { consumerIds: string[] }) => !l.consumerIds.includes(ana))).toBe(true);
    expect(JSON.stringify(w.domain())).not.toContain(ana);

    const used = w.env.mcp.used.map((u) => u.op);
    expect(used.every((op) => READ_TOOLS.has(op))).toBe(true);
    expect(used).toContain('getItem');
  });

  it('replay não refaz a busca; reinício preserva propostas e sacola', async () => {
    const w = await world();
    await w.send('Somos Ana. Ana não tem restrição');
    await w.send('Sugere pizza');
    const calls = w.env.mcp.used.length;
    expect(w.runtime.accept(principalOf(ORG_A), msg(2, 'Sugere pizza', 1)).status).toBe(200);
    w.runtime.tick(); await flush();
    expect(w.env.mcp.used.length).toBe(calls);
    await w.send('Quero a proposta 1');
    const before = w.domain();
    w.restart();
    expect(w.domain()).toEqual(before);
    expect((await w.send('pode pedir')).snapshot!.phase).toBe('EDITING_CART');
  });

  it('Esvaziar sacola limpa somente a composição simulada e preserva contexto após reinício', async () => {
    const w = await world();
    await w.send('Somos Ana e Caio. Ana não tem restrição. Caio é alérgico a leite. Teto de R$ 180');
    await w.send('Sugere pizza');
    await w.send('Quero a proposta 1');
    expect(w.domain().bag).toBeDefined();
    const before = w.domain();
    const reads = w.env.mcp.used.length;
    const cleared = await w.send('Esvaziar sacola simulada');
    expect(cleared.status).toBe('SUCCEEDED');
    expect(w.domain().bag).toBeUndefined();
    expect(w.domain().participants).toEqual(before.participants);
    expect(w.domain().groupLimit).toEqual(before.groupLimit);
    expect(cleared.snapshot!.blocks.some((b) => b.kind === 'REVIEW')).toBe(false);
    expect(cleared.snapshot!.humanApproval).toBeNull();
    w.restart();
    expect(w.domain().bag).toBeUndefined();
    expect(w.env.mcp.used).toHaveLength(reads);
    expect(w.env.mcp.used.every((call) => READ_TOOLS.has(call.op))).toBe(true);
  });

  it('falha do MCP na busca não derruba o turno nem perde dados', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const w = await world();
    await w.send('Somos Ana. Ana não tem restrição');
    w.env.mcp.failure = 'http503';
    const op = await w.send('Sugere pizza');
    expect(op.status).toBe('SUCCEEDED');
    expect(op.snapshot!.pending.join(' ')).toMatch(/Não consegui buscar opções agora/);
    expect(w.domain().participants).toHaveLength(1);
    expect(w.domain().proposals).toBeUndefined();
  });

  it('isolamento: outro organizador não escolhe propostas alheias', async () => {
    const w = await world();
    await w.send('Somos Ana. Ana não tem restrição');
    await w.send('Sugere pizza');
    await w.send('Somos Zeca. Zeca não tem restrição', ORG_B);
    const op = await w.send('Quero a proposta 1', ORG_B);
    expect(op.snapshot!.pending.join(' ')).toMatch(/Não há proposta 1/);
    expect(w.domain(ORG_B).bag).toBeUndefined();
    expect(w.domain(ORG_A).proposals.length).toBeGreaterThan(0);
  });

  it('sem participantes, sugestão vira pergunta e nada é buscado', async () => {
    const w = await world();
    const before = w.env.mcp.used.length;
    const op = await w.send('Sugere pizza');
    expect(op.snapshot!.pending).toContain('Diga quem vai participar antes de pedir sugestões.');
    expect(w.env.mcp.used.length).toBe(before);
  });

  it('MCP lento: prazo da busca esgota, turno conclui com aviso e nada é gravado', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const w = await world(() => (_o, _s, _q, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))), 50);
    await w.send('Somos Ana. Ana não tem restrição');
    const op = await w.send('Sugere pizza');
    expect(op.status).toBe('SUCCEEDED');
    expect(op.snapshot!.pending.join(' ')).toMatch(/Não consegui buscar opções agora/);
    expect(w.domain().proposals).toBeUndefined();
  });

  it('vários endereços sem escolha: mensagem específica, sem usar endereço adivinhado', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const w = await world();
    w.env.mcp.addresses = [{ addressId: 'addr-1', alias: 'Casa' }, { addressId: 'addr-2', alias: 'Trabalho' }];
    await w.send('Somos Ana. Ana não tem restrição');
    const op = await w.send('Sugere pizza');
    expect(op.snapshot!.pending.join(' ')).toMatch(/mais de um endereço salvo/);
    expect(w.env.mcp.used.map((u) => u.op)).not.toContain('searchOffers');
  });

  it('proposta registra o endereço usado (proveniência)', async () => {
    const w = await world();
    await w.send('Somos Ana. Ana não tem restrição');
    await w.send('Sugere pizza');
    expect(w.domain().proposals.every((p: { addressId?: string }) => p.addressId === 'addr-test-1')).toBe(true);
  });

  it('vínculo trocado durante a busca: resultado descartado', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const w = await world((env) => async (org, state, query) => ({ ...(await linkedProposalProvider(env.links)(org, state, query)), linkId: 'outro-vinculo' }));
    await w.send('Somos Ana. Ana não tem restrição');
    const op = await w.send('Sugere pizza');
    expect(op.snapshot!.pending.join(' ')).toMatch(/A conexão com a conta iFood mudou durante a busca/);
    expect(w.domain().proposals).toBeUndefined();
  });

  it('auditoria: o prazo do turno chega às chamadas MCP (cancelamento cooperativo)', async () => {
    const { generateProposals } = await import('../../src/server/services/group');
    const seen: (AbortSignal | undefined)[] = [];
    const deps = {
      listAddresses: async () => ({ results: [{ addressId: 'addr-1', alias: 'Casa', coordinates: { latitude: -1, longitude: -2 } }] }) as never,
      searchOffers: async (_a: unknown, o: { signal?: AbortSignal }) => { seen.push(o.signal); return { results: [] }; },
      getItem: async (_a: unknown, o: { signal?: AbortSignal }) => { seen.push(o.signal); return {}; },
    };
    const controller = new AbortController();
    const { applyPatch } = await import('../../src/server/domain/purchase');
    const state = applyPatch(null, [{ op: 'ADD_PARTICIPANT', displayName: 'Ana' }], { seed: 's', eventId: 'e1' }).state;
    await generateProposals(state, { query: 'pizza' }, deps as never, { seed: 'x', signal: controller.signal });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((sg) => sg === controller.signal)).toBe(true);
  });

  it('cenário da imagem: aviso alimentar e propostas sobrevivem a consulta/replay/reinício sem outro modelo ou MCP', async () => {
    const propose = vi.fn().mockResolvedValueOnce({ actions: [
      { action: 'ADD_PARTICIPANT', name: 'Eu' }, { action: 'ADD_PARTICIPANT', name: 'Namorada' },
      { action: 'ADD_RESTRICTION', participant: { name: 'Eu' }, restriction: { kind: 'DIETARY', code: 'LACTOSE_FREE' } },
      { action: 'ADD_RESTRICTION', participant: { name: 'Namorada' }, restriction: { kind: 'ALLERGY', code: 'SEAFOOD' } },
      { action: 'SET_LIMIT', target: 'GROUP', amountCents: 10_000, kind: 'MANDATORY' },
    ] }).mockResolvedValueOnce({ actions: [{ action: 'SUGGEST_PROPOSALS', query: 'comida' }] });
    const w = await world(undefined, undefined, { id: 'synthetic-scenario', propose });
    w.env.mcp.searchPages.push({ results: [], hasMore: false });
    await w.send('Eu sem lactose, Namorada com alergia a frutos do mar. Orçamento R$100.');
    const op = await w.send('Sugere comida');
    expect(op.status).toBe('SUCCEEDED');
    // Sem dado alimentar do iFood: propostas aparecem com aviso explícito (decisão de produto), sem declarar segurança.
    expect(op.snapshot!.blocks.filter((b) => b.kind === 'PROPOSAL').length).toBeGreaterThan(0);
    // Namorada (alergia sem dado) é atendida com aviso; Eu tem conflito informado (laticínio) nos itens da fixture.
    expect(op.snapshot!.pending.join(' ')).toMatch(/Atenção: o iFood não informa ingredientes nem alérgenos\. As restrições de Namorada .*confirme com o restaurante/);
    expect(op.snapshot!.pending.join(' ')).toMatch(/Sem atendimento \(nenhum dos itens avaliados é compatível com as restrições declaradas\): Eu\./);
    expect(op.snapshot!.pending.join(' ')).toMatch(/Sugere arroz/);
    expect(op.snapshot!.pending.join(' ')).not.toMatch(/Só informação, não é recomendação/);
    expect(op.snapshot!.humanApproval).toBeNull();
    expect(w.domain().groupLimit.value.amountCents).toBe(10_000);
    const reads = w.env.mcp.used.length;
    for (let i = 0; i < 3; i++) {
      w.runtime.store.snapshot(principalOf(ORG_A));
      w.runtime.store.operation(principalOf(ORG_A), op.operationId);
    }
    expect(w.runtime.accept(principalOf(ORG_A), msg(2, 'Sugere comida', 1)).status).toBe(200);
    w.runtime.tick(); await flush();
    w.restart();
    expect(w.runtime.store.snapshot(principalOf(ORG_A)).pending).toEqual(op.snapshot!.pending);
    expect(propose).toHaveBeenCalledTimes(2);
    expect(w.env.mcp.used).toHaveLength(reads);
    expect(w.env.mcp.used.every((c) => READ_TOOLS.has(c.op))).toBe(true);
  });
});
