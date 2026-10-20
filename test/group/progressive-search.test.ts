// Regressões SINTÉTICAS do cenário da imagem; não são capturas autenticadas de catálogo.
import { describe, expect, it, vi } from 'vitest';
import { generateProposals } from '../../src/server/services/group';
import { applyPatch, type DomainOp, type PurchaseState } from '../../src/server/domain/purchase';
import { composeProposals } from '../../src/server/domain/group';
import type { EvaluateDeps } from '../../src/server/services/evaluate';
import type { GetItemResult, SearchItemResult, SearchOffersArgs } from '../../src/server/mcp/types';
import { candidate, M1, M2 } from './catalog';

const context = { seed: 'grp-progressive', eventId: 'event-synthetic' };
function group(scenario = false) {
  let state = applyPatch(null, [{ op: 'ADD_PARTICIPANT', displayName: 'Eu' },
    ...(scenario ? [{ op: 'ADD_PARTICIPANT' as const, displayName: 'Namorada' }] : [])], context).state;
  const ops: DomainOp[] = state.participants.map((p) => ({ op: 'SET_RESTRICTIONS', participantId: p.participantId, value: 'NONE' }));
  ops.push({ op: 'SET_LIMIT', target: 'GROUP', value: { amountCents: 10_000, kind: 'MANDATORY' } });
  if (scenario) ops.push({ op: 'ADD_RESTRICTION', participantId: state.participants[0]!.participantId, key: { kind: 'DIETARY', code: 'LACTOSE_FREE' } },
    { op: 'ADD_RESTRICTION', participantId: state.participants[1]!.participantId, key: { kind: 'ALLERGY', code: 'SEAFOOD' } });
  state = applyPatch(state, ops, context).state;
  return state;
}
function catalog(count: number, price = 20) {
  const entries = Array.from({ length: count }, (_, i) => {
    const id = `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`;
    const merchantId = i % 2 ? M2 : M1;
    const listing: SearchItemResult = { itemId: id, itemName: `Arroz ${i + 1}`, unitPrice: price,
      merchant: { merchantId, merchantName: `Loja ${i % 2 + 1}`, isOpen: true, minimumOrderAmount: 0,
        deliveryMethod: { fee: 0, estimatedMinutes: { max: 30 } } } };
    const detail: GetItemResult = { itemId: id, itemName: listing.itemName, merchantId, unitPrice: price,
      merchantMinimumOrderAmount: 0, itemDescription: 'Descrição sintética sem prova alimentar', optionGroups: [] };
    return { listing, detail };
  });
  const deps = {
    listAddresses: vi.fn(async () => ({ results: [{ addressId: 'addr-synthetic', coordinates: { latitude: -1, longitude: -2 } }] })),
    searchOffers: vi.fn(async (_a: SearchOffersArgs) => ({ results: entries.map((e) => structuredClone(e.listing)), hasMore: false })),
    getItem: vi.fn(async (a: { itemId: string }) => structuredClone(entries.find((e) => e.detail.itemId === a.itemId)!.detail)),
  };
  return { entries, deps };
}
/** Conflito informado é incompatibilidade; dado insuficiente continua sem atendimento verificado. */
function named(f: ReturnType<typeof catalog>, word: string) {
  f.entries.forEach((e, i) => { e.listing.itemName = `Arroz com ${word} ${i + 1}`; e.detail.itemName = e.listing.itemName; });
}
const run = (state: PurchaseState, deps: EvaluateDeps, evaluateLimits = {}) => generateProposals(state, { query: 'comida' }, deps, { seed: 's', evaluateLimits });

describe('GRP-01: seis itens, duas lojas, sem lactose e alergia a frutos do mar', () => {
  it('sem dado alimentar: bloqueia composição, preserva R$100 e nunca declara segurança', async () => {
    const state = group(true), before = structuredClone(state), f = catalog(6);
    f.deps.searchOffers.mockImplementation(async (a) => ({ results: a.refinements?.itemRestrictions ? [] : f.entries.map((e) => e.listing), hasMore: false }));
    const { result } = await run(state, f.deps);
    expect(result.proposals).toHaveLength(0);
    expect(result.matrix.every(c => c.status === 'NEEDS_VERIFICATION')).toBe(true);
    expect(result.diagnosis.issues).toContain('FOOD_EVIDENCE');
    expect(result.explanation.join(' ')).not.toMatch(/seguro|segurança garantida/i);
    expect(f.deps.listAddresses).toHaveBeenCalledTimes(1);
    expect(state).toEqual(before); // R$100 e restrições preservados
  });

  it('filtro LAC_FREE pode atender a dieta; nunca libera alergia nem impõe a dieta à outra pessoa', async () => {
    const state = group(true), f = catalog(6);
    f.entries[0]!.detail.itemName = 'Arroz com camarão';
    const { result } = await run(state, f.deps);
    const [eu, namorada] = state.participants;
    expect(result.matrix.some((c) => c.participantId === eu!.participantId && c.status === 'COMPATIBLE')).toBe(true);
    expect(result.matrix.find((c) => c.participantId === namorada!.participantId && c.itemId === f.entries[0]!.detail.itemId)!.status).toBe('INCOMPATIBLE');
    expect(result.matrix.filter(c => c.participantId === namorada!.participantId).every(c => c.status !== 'COMPATIBLE')).toBe(true);
    expect(result.proposals.every((p) => p.proposal.lines.every((l) => !(l.consumerIds.includes(namorada!.participantId) && l.itemId === f.entries[0]!.detail.itemId)))).toBe(true);
    const filters = f.deps.searchOffers.mock.calls.flatMap(([a]) => a.refinements?.itemRestrictions ?? []);
    expect(filters.every((x) => x === 'LAC_FREE')).toBe(true); // a dieta de uma pessoa nunca vira filtro da outra
  });
});

describe('exploração progressiva com limites globais', () => {
  it('continua na próxima página quando os seis primeiros itens excedem o teto, sem reler detalhes', async () => {
    const f = catalog(7, 200);
    f.entries[6]!.listing.unitPrice = 20; f.entries[6]!.detail.unitPrice = 20;
    f.deps.searchOffers.mockImplementation(async (a) => ({ results: a.nextPageToken ? [f.entries[6]!.listing] : f.entries.slice(0, 6).map((e) => e.listing),
      hasMore: !a.nextPageToken, ...(!a.nextPageToken ? { nextPageToken: 'page-two' } : {}) }));
    const { result, read } = await run(group(), f.deps);
    expect(read).toMatchObject({ detailed: 7, pagesFetched: 2, detailCalls: 7, stop: 'COVERED' });
    expect(result.proposals[0]!.proposal.lines[0]!.unitMinCents).toBe(2000);
    expect(result.proposals[0]!.approvalBlockers).toContain('TOTAL_UNKNOWN');
    expect(f.deps.getItem).toHaveBeenCalledTimes(7);
    expect(f.deps.searchOffers.mock.calls[1]![0].nextPageToken).toBe('page-two');
  });

  it('diversifica lojas antes do primeiro corte de detalhes', async () => {
    const f = catalog(12, 200);
    f.entries.forEach((e) => { e.listing.merchant.merchantId = M1; e.detail.merchantId = M1; });
    f.entries[11]!.listing.merchant.merchantId = M2; f.entries[11]!.detail.merchantId = M2;
    f.entries[11]!.listing.unitPrice = 20; f.entries[11]!.detail.unitPrice = 20;
    const { result, read } = await run(group(), f.deps);
    expect(read).toMatchObject({ pagesFetched: 1, detailed: 6, stop: 'COVERED' });
    expect(f.deps.getItem.mock.calls[1]![0].itemId).toBe(f.entries[11]!.detail.itemId);
    expect(result.proposals[0]!.proposal.merchantId).toBe(M2);
  });

  it('não excede quatro consultas e 24 itens, mesmo com paginação extensa e conflito informado', async () => {
    const f = catalog(80), state = group(true);
    named(f, 'camarão'); // Namorada (frutos do mar) nunca é atendida: a busca vai até o limite
    f.deps.searchOffers.mockImplementation(async (a) => {
      const p = Number(a.nextPageToken ?? 0);
      return { results: f.entries.slice(p * 20, (p + 1) * 20).map((e) => e.listing), hasMore: true, nextPageToken: String(p + 1) };
    });
    const { result, read } = await run(state, f.deps);
    expect(read.pagesFetched).toBeLessThanOrEqual(4);
    expect(read.detailCalls).toBeLessThanOrEqual(24);
    expect(read.candidates).toBeLessThanOrEqual(80);
    expect(read.stop).toMatch(/LIMIT/);
    expect(f.deps.getItem.mock.calls.length).toBe(new Set(f.deps.getItem.mock.calls.map(([a]) => a.itemId)).size);
    expect(result.matrix.filter((c) => c.participantId === state.participants[1]!.participantId).every((c) => c.status !== 'COMPATIBLE')).toBe(true);
  });

  it('interrompe por prazo global e preserva a leitura parcial', async () => {
    const f = catalog(20); let clock = 0;
    named(f, 'queijo'); // Eu (sem lactose) não é atendida: a busca continuaria se não fosse o prazo
    f.deps.getItem.mockImplementation(async (a) => { clock = 24_500; return f.entries.find((e) => e.detail.itemId === a.itemId)!.detail; });
    const { read } = await run(group(true), { ...f.deps, now: () => clock });
    expect(read).toMatchObject({ deadlineReached: true, pagesFetched: 1, detailCalls: 1, stop: 'DEADLINE' });
  });

  it('cancelamento não agenda a fase seguinte nem outro getItem', async () => {
    const f = catalog(20), controller = new AbortController();
    f.deps.searchOffers.mockImplementation(async () => { controller.abort(); return { results: f.entries.map((e) => e.listing), hasMore: false }; });
    await expect(generateProposals(group(true), { query: 'comida' }, f.deps, { seed: 'x', signal: controller.signal })).rejects.toBeDefined();
    expect(f.deps.searchOffers).toHaveBeenCalledTimes(1);
    expect(f.deps.getItem).not.toHaveBeenCalled();
  });

  it('falha de uma ampliação mantém os itens lidos e não declara catálogo vazio', async () => {
    const f = catalog(6);
    named(f, 'queijo'); // conflito informado para Eu força a ampliação com filtro LAC_FREE
    f.deps.searchOffers.mockImplementation(async (a) => { if (a.refinements?.itemRestrictions) throw new Error('falha externa sintética privada'); return { results: f.entries.map((e) => e.listing), hasMore: false }; });
    const { result, read } = await run(group(true), f.deps);
    expect(read).toMatchObject({ detailed: 6, readErrors: 1, stop: 'READ_ERROR' });
    expect(result.explanation.join(' ')).toMatch(/Parte da leitura falhou/);
    expect(result.explanation.join(' ')).not.toMatch(/externa sintética privada/);
  });

  it('respeita loja fixada e não mistura evidência quando o preço muda entre consultas', async () => {
    const f = catalog(6);
    named(f, 'queijo');
    const state = applyPatch(group(true), [{ op: 'SET_MERCHANT', merchantId: M1 }], context).state;
    f.deps.searchOffers.mockImplementation(async (a) => ({ results: f.entries.filter((e) => e.listing.merchant.merchantId === M1).map((e) =>
      ({ ...e.listing, ...(a.refinements?.itemRestrictions ? { unitPrice: 21 } : {}) })), hasMore: false }));
    const { result, read } = await run(state, f.deps);
    expect(f.deps.searchOffers.mock.calls.every(([a]) => a.refinements?.merchantId === M1)).toBe(true);
    expect(read.changed).toBe(3);
    expect(result.proposals).toEqual([]);
    expect(result.explanation.join(' ')).toMatch(/observações divergentes/);
  });

  it('cursor repetido não refaz a mesma página', async () => {
    const f = catalog(6, 200);
    f.deps.searchOffers.mockImplementation(async () => ({ results: f.entries.map((e) => e.listing), hasMore: true, nextPageToken: 'same' }));
    const { read } = await run(group(), f.deps);
    const calls = f.deps.searchOffers.mock.calls.map(([a]) => JSON.stringify(a));
    expect(calls.length).toBe(new Set(calls).size);
    expect(f.deps.getItem).toHaveBeenCalledTimes(6);
    expect(read).toMatchObject({ paginationIncomplete: true, stop: 'PAGINATION_UNVERIFIED' });
  });

  it('hasMore sem cursor é paginação não verificada, não catálogo esgotado', async () => {
    const f = catalog(6, 200);
    f.deps.searchOffers.mockImplementation(async () => ({ results: f.entries.map((e) => e.listing), hasMore: true }));
    const { result, read } = await run(group(), f.deps);
    expect(read).toMatchObject({ paginationIncomplete: true, stop: 'PAGINATION_UNVERIFIED' });
    expect(result.explanation.join(' ')).toMatch(/cursor ausente ou repetido/);
  });
});

describe('diagnóstico distingue alimentação, orçamento, cobertura e catálogo', () => {
  it('foto vem do getItem de proposta completa, nunca de item bloqueado ou URL arbitrária', async () => {
    const f = catalog(1);
    const photo = 'https://static.ifood-static.com.br/image/upload/t_medium/pratos/synthetic.jpg';
    f.entries[0]!.detail.itemImageUrl = photo;
    expect((await run(group(), f.deps)).result.explanation).toContain(`Foto do item: ${photo}`);
    f.entries[0]!.detail.itemName = 'Arroz com camarão'; // bloqueado para a Namorada: sem proposta completa, sem foto
    expect((await run(group(true), f.deps)).result.explanation.join(' ')).not.toContain('Foto do item:');
    f.entries[0]!.detail.itemName = f.entries[0]!.listing.itemName;
    for (const image of ['http://127.0.0.1/image/upload/a.jpg', 'https://example.test/image/upload/a.jpg',
      'https://static.ifood-static.com.br/image/upload/a.jpg?token=private']) {
      f.entries[0]!.detail.itemImageUrl = image;
      expect((await run(group(), f.deps)).result.explanation.join(' ')).not.toContain('Foto do item:');
    }
  });
  it('preço ausente não é chamado de falta de evidência alimentar', () => {
    const result = composeProposals(group(), [candidate({ name: 'Arroz', price: null })], { seed: 'x' });
    expect(result.diagnosis.issues).toEqual(['MISSING_DATA']);
    expect(result.explanation.join(' ')).toMatch(/faltam dados de preço/);
    expect(result.explanation.join(' ')).not.toMatch(/Falta evidência alimentar/);
  });
  it('loja fechada é catálogo indisponível; cobertura em lojas separadas não atende o grupo numa proposta', () => {
    const closed = candidate({ name: 'Arroz', price: 20 });
    closed.listing.merchant.isOpen = { state: 'PRESENT', value: false };
    const unavailable = composeProposals(group(), [closed], { seed: 'x' });
    expect(unavailable.diagnosis.issues).toEqual(['CATALOG']);
    expect(unavailable.explanation.join(' ')).toMatch(/lojas.*fechadas/);
    let state = applyPatch(group(), [{ op: 'ADD_PARTICIPANT', displayName: 'Outra pessoa' }], { ...context, eventId: 'another-person' }).state;
    state = applyPatch(state, state.participants.map((p, i) => ({ op: 'ADD_RESTRICTION', participantId: p.participantId,
      key: { kind: 'DIETARY', code: i ? 'SUGAR_FREE' : 'LACTOSE_FREE' } })), { ...context, eventId: 'different-diets' }).state;
    // Conflito informado no nome: cada loja atende só uma das dietas.
    const partial = composeProposals(state, [candidate({ name: 'Arroz com mel', price: 20, filters: ['LAC_FREE'], merchantId: M1 }),
      candidate({ name: 'Feijão com queijo', price: 20, filters: ['SUGAR_FREE'], merchantId: M2 })], { seed: 'x' });
    expect(partial.diagnosis.issues).toEqual(['COVERAGE']);
    expect(partial.explanation.join(' ')).toMatch(/ainda não há proposta única/);
  });
  it('teto excedido, ausência de itens e incompatibilidade permanecem motivos distintos', () => {
    const capped = composeProposals(group(), [candidate({ name: 'Arroz', price: 200 })], { seed: 'x' });
    const empty = composeProposals(group(), [], { seed: 'x' });
    const incompatible = composeProposals(group(true), [candidate({ name: 'Camarão ao queijo', price: 20 })], { seed: 'x' });
    expect(capped.diagnosis.issues).toContain('BUDGET');
    expect(empty.diagnosis.issues).toEqual(['CATALOG']);
    expect(incompatible.diagnosis.issues).toContain('INCOMPATIBILITY');
    expect(incompatible.proposals).toEqual([]);
  });
});
