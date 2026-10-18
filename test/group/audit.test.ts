// GRP-01: regressões permanentes da auditoria adversarial (um bloco por bug) + falhas e respostas malformadas do MCP.
import { describe, expect, it } from 'vitest';
import { OperationSchema, SnapshotSchema, type Snapshot } from '../../src/server/contracts/conversation';
import { planActions } from '../../src/server/agent/policy';
import { renderSnapshot, SNAPSHOT_BUDGET_BYTES } from '../../src/server/agent/render';
import { composeProposals, evaluatePlan, planCoverage } from '../../src/server/domain/group';
import { applyPatch, DomainError, type DomainOp, type PurchaseState } from '../../src/server/domain/purchase';
import { candidate, M1, M2 } from './catalog';

let n = 0;
const ctx = () => ({ seed: 'escopo-audit', eventId: `ev-${++n}`, maxParticipants: 100 });
const apply = (s: PurchaseState | null, ops: DomainOp[]) => applyPatch(s, ops, ctx()).state;
function people(...names: string[]): PurchaseState {
  let s: PurchaseState | null = null;
  for (let i = 0; i < names.length; i += 50) s = apply(s, names.slice(i, i + 50).map((displayName) => ({ op: 'ADD_PARTICIPANT' as const, displayName })));
  const all = s!.participants.map((p) => ({ op: 'SET_RESTRICTIONS' as const, participantId: p.participantId, value: 'NONE' as const }));
  for (let i = 0; i < all.length; i += 50) s = apply(s, all.slice(i, i + 50));
  return s!;
}
const idOf = (s: PurchaseState, name: string) => s.participants.find((p) => p.displayName === name)!.participantId;
function choose(s: PurchaseState, items = [candidate({ name: 'Pizza de queijo', price: 30 })]) {
  const r = composeProposals(s, items, { seed: 'x' });
  const withP = apply(s, [{ op: 'SET_PROPOSALS', proposals: r.proposals.map((p) => p.proposal) }]);
  return apply(withP, [{ op: 'SELECT_PROPOSAL', proposalId: withP.proposals![0]!.proposalId }]);
}
const BASE: Snapshot = { contractVersion: '1.0', conversationId: '1', version: 3, phase: 'COLLECTING', blocks: [], pending: [], allowedActions: [], humanApproval: null };

describe('bug 1 — cobertura da sacola revalidada contra restrições atuais', () => {
  it('alergia adicionada depois da escolha: deixa de ser COVERED e a sacola fica inválida', () => {
    let s = choose(people('Caio'));
    const caio = idOf(s, 'Caio');
    expect(evaluatePlan(s, s.bag!, planCoverage(s, s.bag!)).valid).toBe(true);
    s = apply(s, [{ op: 'ADD_RESTRICTION', participantId: caio, key: { kind: 'ALLERGY', code: 'MILK' } }]);
    const ev = evaluatePlan(s, s.bag!, planCoverage(s, s.bag!));
    expect(ev.coverage).toEqual([expect.objectContaining({ status: 'NEEDS_VERIFICATION', reason: 'RESTRICTIONS_CHANGED' })]);
    expect(ev.valid).toBe(false);
    expect(ev.violations).toEqual(expect.arrayContaining([`CONSUMER_NOT_VERIFIED:${caio}`, 'BAG_NEEDS_REVALIDATION']));
    const snap = renderSnapshot(BASE, s, [], [], { proposals: [], bag: ev });
    const review = snap.blocks.find((b) => b.kind === 'REVIEW');
    expect(review?.kind === 'REVIEW' && review.coverage).toEqual([{ participantRef: caio, status: 'NEEDS_VERIFICATION' }]);
  });

  it('pergunta de restrição pendente também tira a cobertura', () => {
    let s = choose(people('Caio'));
    s = apply(s, [{ op: 'MARK_UNCLEAR', target: idOf(s, 'Caio'), field: 'RESTRICTIONS', question: 'Tem alguma alergia?' }]);
    const ev = evaluatePlan(s, s.bag!, planCoverage(s, s.bag!));
    expect(ev.coverage[0]).toMatchObject({ status: 'NEEDS_VERIFICATION', reason: 'RESTRICTIONS_UNKNOWN' });
    expect(ev.valid).toBe(false);
  });

  it('commit recusa proposta composta com restrições antigas (não confia só no processador)', () => {
    const s = people('Caio');
    const stale = composeProposals(s, [candidate({ name: 'Pizza', price: 30 })], { seed: 'x' }).proposals.map((p) => p.proposal);
    const changed = apply(s, [{ op: 'ADD_RESTRICTION', participantId: idOf(s, 'Caio'), key: { kind: 'ALLERGY', code: 'MILK' } }]);
    expect(() => apply(changed, [{ op: 'SET_PROPOSALS', proposals: stale }])).toThrow(DomainError);
    const noCoverage = stale.map((p) => ({ ...p, coverage: undefined }));
    expect(() => apply(s, [{ op: 'SET_PROPOSALS', proposals: noCoverage }])).toThrow(DomainError);
  });
});

describe('bug 2 — teto de uma pessoa não derruba o grupo', () => {
  it('teto individual: a pessoa sai com motivo e o restante continua atendido', () => {
    let s = people('Ana', 'Bob');
    s = apply(s, [{ op: 'SET_LIMIT', target: idOf(s, 'Bob'), value: { amountCents: 1000, kind: 'MANDATORY' } }]);
    const r = composeProposals(s, [candidate({ name: 'Arroz', price: 20, fee: 0 })], { seed: 'x' });
    expect(r.proposals).toHaveLength(1);
    expect(r.proposals[0]!.coverage.map((c) => [c.status, c.reason])).toEqual([['COVERED', null], ['BLOCKED', 'LIMIT_EXCEEDED']]);
    expect(r.explanation).toContain('Sem atendimento (pelos preços observados, o item compatível mais barato já passa do próprio teto): Bob.');
    expect(r.explanation.join(' ')).not.toMatch(/Ana/);
  });

  it('teto coletivo: retira só o necessário e marca cobertura parcial', () => {
    let s = people('Ana', 'Bia', 'Caio');
    s = apply(s, [{ op: 'SET_LIMIT', target: 'GROUP', value: { amountCents: 5000, kind: 'MANDATORY' } }]);
    const p = composeProposals(s, [candidate({ name: 'Arroz', price: 20, fee: 0 })], { seed: 'x' }).proposals[0]!;
    expect(p.coverage.filter((c) => c.status === 'COVERED')).toHaveLength(2);
    expect(p.coverage.filter((c) => c.reason === 'GROUP_LIMIT')).toHaveLength(1);
    expect(p.lowerBoundCents).toBe(4000);
    expect(p.approvalBlockers).toContain('PARTIAL_COVERAGE');
  });
});

describe('bug 3 — corte em 4', () => {
  it('quem perde a única cobertura no corte aparece na explicação como corte, não como teto', () => {
    // Cada item contém (informado no nome) os alérgenos de todos menos um: conflito informado exclui,
    // sem dado só avisa. Assim cada loja atende exatamente uma pessoa.
    const codes = ['GLUTEN', 'MILK', 'EGG', 'PEANUT', 'SOY'] as const;
    const terms = ['trigo', 'leite', 'ovo', 'amendoim', 'soja'];
    const merchants = codes.map((_, i) => `${i + 3}${i + 3}${i + 3}${i + 3}${i + 3}${i + 3}${i + 3}${i + 3}-0000-4000-8000-000000000000`);
    let s = apply(null, codes.map((_, i) => ({ op: 'ADD_PARTICIPANT' as const, displayName: `P${i}` })));
    s = apply(s, codes.map((code, i) => ({ op: 'ADD_RESTRICTION' as const, participantId: s.participants[i]!.participantId, key: { kind: 'ALLERGY' as const, code } })));
    const items = codes.map((_, i) => candidate({ name: `Prato ${i} com ${terms.filter((_, j) => j !== i).join(', ')}`, price: 20 + i, merchantId: merchants[i] }));
    const r = composeProposals(s, items, { seed: 'x' });
    expect(r.search.validPlans).toBe(5);
    expect(r.proposals).toHaveLength(4);
    expect(r.lostByCut).toHaveLength(1);
    const lost = s.participants.find((p) => p.participantId === r.lostByCut[0])!.displayName;
    expect(r.explanation).toContain(`Sem atendimento (há opção válida fora das 4 propostas exibidas; peça sugestões mais específicas): ${lost}.`);
    expect(r.explanation.join(' ')).not.toMatch(/teto/);
  });
});

describe('bug 4 — loja fixada pela escolha', () => {
  it('esvaziar a sacola desfaz a loja fixada só pela escolha; nova busca considera outras lojas', () => {
    let s = choose(people('Ana'), [candidate({ name: 'A', price: 20, merchantId: M1 })]);
    expect(s.merchant.state).toBe('DECLARED');
    s = apply(s, [{ op: 'CLEAR_BAG' }]);
    expect(s.merchant.state).toBe('NOT_ASKED');
    expect(composeProposals(s, [candidate({ name: 'B', price: 20, merchantId: M2 })], { seed: 'x' }).proposals).toHaveLength(1);
  });

  it('loja declarada pelo usuário é preservada, e a explicação cita o filtro de loja', () => {
    let s = apply(people('Ana'), [{ op: 'SET_MERCHANT', merchantId: M1 }]);
    s = choose(s, [candidate({ name: 'A', price: 20, merchantId: M1 })]);
    s = apply(s, [{ op: 'CLEAR_BAG' }]);
    expect(s.merchant).toMatchObject({ state: 'DECLARED', value: { merchantId: M1 } });
    const r = composeProposals(s, [candidate({ name: 'B', price: 20, merchantId: M2 })], { seed: 'x' });
    expect(r.proposals).toEqual([]);
    expect(r.explanation.join(' ')).toMatch(/fixada numa loja escolhida antes.*1 de outras lojas ignorados/);
    expect(r.explanation.join(' ')).not.toMatch(/não é compatível com as restrições/);
  });
});

describe('bug 5 — entrega desconhecida nunca vale zero no ranking', () => {
  it('loja com taxa conhecida vem antes da loja sem taxa informada', () => {
    const s = people('Ana');
    const r = composeProposals(s, [candidate({ name: 'Sem taxa', price: 30, merchantId: M1, fee: null }), candidate({ name: 'Com taxa', price: 30, merchantId: M2, fee: 1 })], { seed: 'x' });
    expect(r.proposals.map((p) => p.proposal.lines[0]!.name)).toEqual(['Com taxa', 'Sem taxa']);
    expect(r.proposals[1]!.comparable).toBe(false);
  });
});

describe('bug 6 — taxas e mínimos divergentes do MCP', () => {
  it('resultado não depende da ordem; divergência fica explícita e bloqueia aprovação', () => {
    let s = people('Ana');
    s = apply(s, [{ op: 'SET_LIMIT', target: idOf(s, 'Ana'), value: { amountCents: 3500, kind: 'MANDATORY' } }]);
    const a = candidate({ name: 'Item A', price: 30, merchantId: M1, fee: 10, minimumOrder: 20 });
    const b = candidate({ name: 'Item B', price: 31, merchantId: M1, fee: 0, minimumOrder: 25 });
    const r1 = composeProposals(s, [a, b], { seed: 'x' });
    const r2 = composeProposals(s, [b, a], { seed: 'x' });
    expect(r1.proposals.map((p) => p.proposal)).toEqual(r2.proposals.map((p) => p.proposal));
    expect(r1.proposals.length).toBeGreaterThan(0); // nenhuma falha falsa pela taxa mais alta
    const p = r1.proposals[0]!;
    expect(p.proposal.uncertainties).toEqual(['DELIVERY_FEE_DIVERGENT', 'MINIMUM_ORDER_DIVERGENT']);
    expect(p.approvalBlockers).toEqual(expect.arrayContaining(['DELIVERY_FEE_UNKNOWN', 'MINIMUM_ORDER_UNVERIFIED']));
    expect(p.proposal.minimumOrderCents).toBe(2000);
  });
});

describe('bug 7 — aviso de busca limitada nunca é cortado', () => {
  it('35 pessoas sem atendimento: aviso primeiro e pessoas agrupadas', () => {
    let s = people(...Array.from({ length: 35 }, (_, i) => `Pessoa ${i}`));
    s = apply(s, s.participants.slice(1).map((p) => ({ op: 'ADD_RESTRICTION' as const, participantId: p.participantId, key: { kind: 'ALLERGY' as const, code: 'MILK' } })));
    // Leite informado no nome: conflito real exclui as 34 pessoas alérgicas (sem dado, só avisaria).
    const r = composeProposals(s, [candidate({ name: 'Pizza com leite', price: 30 })], { seed: 'x' });
    expect(r.explanation[0]).toMatch(/não prova que não existe combinação válida/);
    expect(r.explanation.length).toBeLessThan(10);
    expect(r.explanation.join(' ')).toMatch(/e mais 24/);
    const snap = renderSnapshot(BASE, s, [], [...r.explanation, ...Array.from({ length: 40 }, (_, i) => `outra pendência ${i}`)]);
    expect(snap.pending[0]).toMatch(/não prova que não existe combinação válida/);
  });
});

describe('bug 8 — 100 participantes cabem no limite do runtime', () => {
  it('snapshot com 4 propostas + sacola respeita o orçamento; GROUP, bloqueios e cobertura preservados', () => {
    const names = Array.from({ length: 100 }, (_, i) => `Ção Ñúñez Ação Ímpar ${'é'.repeat(50)} ${i}`.slice(0, 80));
    let s = people(...names);
    const items = Array.from({ length: 6 }, (_, i) => candidate({ name: `Prato com nome comprido número ${i} ${'á'.repeat(150)}`, price: 20 + i }));
    const r = composeProposals(s, items, { seed: 'x' });
    s = apply(s, [{ op: 'SET_PROPOSALS', proposals: r.proposals.map((p) => p.proposal) }]);
    s = apply(s, [{ op: 'SELECT_PROPOSAL', proposalId: s.proposals![0]!.proposalId }]);
    const views = { proposals: s.proposals!.map((p) => evaluatePlan(s, p, planCoverage(s, p))), bag: evaluatePlan(s, s.bag!, planCoverage(s, s.bag!)) };
    const pending = Array.from({ length: 30 }, (_, i) => `Pendência ${'ç'.repeat(250)} ${i}`);
    const snap = SnapshotSchema.parse(renderSnapshot(BASE, s, ['x'.repeat(1000)], pending, views));
    expect(Buffer.byteLength(JSON.stringify(snap))).toBeLessThanOrEqual(SNAPSHOT_BUDGET_BYTES);
    const group = snap.blocks.find((b) => b.kind === 'GROUP');
    expect(group?.kind === 'GROUP' && group.participants).toHaveLength(100);
    const review = snap.blocks.find((b) => b.kind === 'REVIEW');
    expect(review?.kind === 'REVIEW' && review.coverage).toHaveLength(100);
    expect(review?.kind === 'REVIEW' && review.blockers).toContain('Total do pedido desconhecido: a taxa de serviço só aparece no carrinho.');
    if (snap.blocks.filter((b) => b.kind === 'PROPOSAL').length < views.proposals.length) expect(snap.pending[0]).toMatch(/Grupo grande: só \d de \d propostas/);
    const op = OperationSchema.parse({ contractVersion: '1.0', operationId: 'o'.repeat(24), eventId: 'tg-update-1', conversationId: '1', status: 'SUCCEEDED',
      baseVersion: 3, resultVersion: 4, createdAt: new Date(0).toISOString(), deadlineAt: new Date(0).toISOString(), pollAfterMs: null, completeness: 'COMPLETE',
      snapshot: snap, error: null, changes: [{ changeId: 'c'.repeat(24), eventId: 'tg-update-1', source: { channel: 'TELEGRAM', botId: '1', conversationId: '1', kind: 'MESSAGE', messageId: '1' },
        baseVersion: 3, resultVersion: 4, paths: ['PARTICIPANTS', 'CONDITIONS', 'BUDGET', 'PROPOSALS', 'CART', 'PHASE'], cause: 'USER' }] });
    expect(Buffer.byteLength(JSON.stringify(op))).toBeLessThanOrEqual(65_536); // maxResultBytes da RUN-01
  });
});

describe('bug 9 — candidatos duplicados', () => {
  it('duplicata é descartada antes da composição; IDs de proposta distintos', () => {
    const s = people('Ana', 'Bia');
    const a = candidate({ name: 'Arroz', price: 20 });
    const r = composeProposals(s, [a, a, candidate({ name: 'Feijão', price: 21 })], { seed: 'x' });
    expect(r.search.discarded.duplicates).toBe(1);
    const ids = r.proposals.map((p) => p.proposal.proposalId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(() => apply(s, [{ op: 'SET_PROPOSALS', proposals: r.proposals.map((p) => p.proposal) }])).not.toThrow();
  });
});

describe('respostas malformadas do MCP', () => {
  it('detalhe de outra loja/outro item é ignorado e aparece na explicação', () => {
    const s = people('Ana');
    const a = candidate({ name: 'Arroz', price: 20, merchantId: M1 });
    const b = candidate({ name: 'Feijão', price: 20, merchantId: M2 });
    const r = composeProposals(s, [{ ...a, detail: { ...a.detail, merchantId: M2 } }, { ...b, detail: { ...a.detail } }], { seed: 'x' });
    expect(r.proposals).toEqual([]);
    expect(r.search.discarded.inconsistent).toBe(2);
    expect(r.explanation.join(' ')).toMatch(/2 item\(ns\) ignorado\(s\) por dados inconsistentes/);
  });

  it('preço negativo ou ausente nunca vira item elegível nem zero', () => {
    const s = people('Ana');
    const r = composeProposals(s, [candidate({ name: 'Negativo', price: -5 }), candidate({ name: 'Sem preço', price: null })], { seed: 'x' });
    expect(r.proposals).toEqual([]);
    expect(r.matrix.every((c) => c.status !== 'COMPATIBLE')).toBe(true);
  });
});

describe('mensagem com sugestão e escolha juntas', () => {
  it('"sugere X e quero a 1" não escolhe da lista antiga', () => {
    let s = people('Ana');
    s = apply(s, [{ op: 'SET_PROPOSALS', proposals: composeProposals(s, [candidate({ name: 'Arroz', price: 20 })], { seed: 'x' }).proposals.map((p) => p.proposal) }]);
    const plan = planActions(s, { actions: [{ action: 'SUGGEST_PROPOSALS', query: 'pizza' }, { action: 'SELECT_PROPOSAL', position: 1 }] },
      (change) => (change.ops.length ? applyPatch(s, change.ops, ctx()).state : s), null, 'sugere pizza e quero a proposta 1');
    expect(plan.ops.some((o) => o.op === 'SELECT_PROPOSAL')).toBe(false);
    expect(plan.suggest).toBe('pizza');
    expect(plan.notes).toContain('Veja as novas sugestões e depois diga qual proposta quer.');
  });
});

describe('auditoria final — bug A: cascata do reparo de tetos', () => {
  it('retirar o mais caro faz a entrega estourar os demais: acha o plano válido com menos retiradas', () => {
    let s = apply(null, ['A', 'B', 'C'].map((displayName) => ({ op: 'ADD_PARTICIPANT' as const, displayName })));
    const [a, b, c] = s.participants.map((p) => p.participantId);
    s = apply(s, [
      { op: 'ADD_RESTRICTION', participantId: a!, key: { kind: 'DIETARY', code: 'GLUTEN_FREE' } },
      { op: 'ADD_RESTRICTION', participantId: b!, key: { kind: 'DIETARY', code: 'VEGETARIAN' } },
      { op: 'ADD_RESTRICTION', participantId: c!, key: { kind: 'DIETARY', code: 'VEGETARIAN' } },
      { op: 'SET_LIMIT', target: b!, value: { amountCents: 2000, kind: 'MANDATORY' } },
      { op: 'SET_LIMIT', target: c!, value: { amountCents: 2000, kind: 'MANDATORY' } },
      { op: 'SET_LIMIT', target: 'GROUP', value: { amountCents: 7500, kind: 'MANDATORY' } },
    ]);
    const items = [candidate({ name: 'Carne grelhada', price: 40, fee: 30, filters: ['GLUTEN_FREE'] }), candidate({ name: 'Salada com croutons de pão', price: 10, fee: 30, filters: ['VEGETARIAN'] })];
    const r = composeProposals(s, items, { seed: 'x' });
    expect(r.proposals).toHaveLength(1);
    const p = r.proposals[0]!;
    expect(p.lowerBoundCents).toBe(7000);
    expect(p.coverage.map((x) => [x.status, x.reason])).toEqual([['COVERED', null], ['BLOCKED', 'CAP_COMBINATION'], ['BLOCKED', 'CAP_COMBINATION']]);
    const text = r.explanation.join(' ');
    expect(text).toMatch(/outra combinação pode existir\): B, C/);
    expect(text).not.toMatch(/item compatível mais barato já passa do próprio teto/); // a salada cabe no teto de B e C
    expect(text).not.toMatch(/A\./);
  });

  it('teto coletivo: retira quem basta, sem retirar duas pessoas quando uma resolve', () => {
    let s = apply(null, ['A', 'B', 'C'].map((displayName) => ({ op: 'ADD_PARTICIPANT' as const, displayName })));
    const [a, b, c] = s.participants.map((p) => p.participantId);
    s = apply(s, [
      { op: 'ADD_RESTRICTION', participantId: a!, key: { kind: 'DIETARY', code: 'GLUTEN_FREE' } },
      { op: 'ADD_RESTRICTION', participantId: b!, key: { kind: 'DIETARY', code: 'VEGETARIAN' } },
      { op: 'ADD_RESTRICTION', participantId: c!, key: { kind: 'DIETARY', code: 'VEGETARIAN' } },
      { op: 'SET_LIMIT', target: 'GROUP', value: { amountCents: 6000, kind: 'MANDATORY' } },
    ]);
    const r = composeProposals(s, [candidate({ name: 'Carne', price: 30, fee: 0, filters: ['GLUTEN_FREE'] }), candidate({ name: 'Salada', price: 26, fee: 0, filters: ['VEGETARIAN'] })], { seed: 'x' });
    expect(r.proposals[0]!.coverage.filter((x) => x.status === 'COVERED')).toHaveLength(2);
  });
});

describe('auditoria final — bug B: trocar de proposta entre lojas', () => {
  it('loja fixada só pela escolha: escolher a proposta de outra loja troca loja e sacola', () => {
    let s = people('Ana');
    const r = composeProposals(s, [candidate({ name: 'X', price: 20, merchantId: M1 }), candidate({ name: 'Y', price: 21, merchantId: M2 })], { seed: 'x' });
    s = apply(s, [{ op: 'SET_PROPOSALS', proposals: r.proposals.map((p) => p.proposal) }]);
    const [first, second] = s.proposals!;
    s = apply(s, [{ op: 'SELECT_PROPOSAL', proposalId: first!.proposalId }]);
    s = apply(s, [{ op: 'SELECT_PROPOSAL', proposalId: second!.proposalId }]);
    expect(s.bag).toMatchObject({ proposalId: second!.proposalId, merchantId: second!.merchantId, merchantSetBySelection: true });
    expect(s.merchant).toMatchObject({ state: 'DECLARED', value: { merchantId: second!.merchantId } });
    expect(apply(s, [{ op: 'CLEAR_BAG' }]).merchant.state).toBe('NOT_ASKED');
  });

  it('loja declarada pelo usuário continua travando a troca', () => {
    let s = people('Ana');
    const r = composeProposals(s, [candidate({ name: 'X', price: 20, merchantId: M1 }), candidate({ name: 'Y', price: 21, merchantId: M2 })], { seed: 'x' });
    s = apply(s, [{ op: 'SET_PROPOSALS', proposals: r.proposals.map((p) => p.proposal) }]);
    const other = s.proposals!.find((p) => p.merchantId === M2)!;
    s = apply(s, [{ op: 'SELECT_PROPOSAL', proposalId: s.proposals!.find((p) => p.merchantId === M1)!.proposalId }]);
    s = apply(s, [{ op: 'SET_MERCHANT', merchantId: M1 }]); // usuário confirma a loja: deixa de ser só da escolha
    expect(s.bag?.merchantSetBySelection ?? false).toBe(false);
    expect(() => apply({ ...s, proposals: [other] }, [{ op: 'SELECT_PROPOSAL', proposalId: other.proposalId }])).toThrow(DomainError);
  });
});

describe('auditoria final — bug C: nada de escolha às cegas nem revisão invisível', () => {
  const event = (text: string) => ({ contractVersion: '1.0' as const, eventId: 'tg-update-9', conversationId: '1', expectedVersion: 3,
    source: { channel: 'TELEGRAM' as const, botId: '1', conversationId: '1', kind: 'MESSAGE' as const, messageId: '9' }, input: { kind: 'TEXT' as const, text } });
  async function turn(purchase: PurchaseState, snapshot: Snapshot, text: string) {
    const { createAgentProcessor } = await import('../../src/server/agent/processor');
    const { DeterministicModel } = await import('../../src/server/agent/mock-model');
    const run = createAgentProcessor({ model: new DeterministicModel(), linkOf: async () => null, timeoutMs: 2_000 });
    return run({ event: event(text), principal: { organizerId: '1', botId: '1', conversationId: '1' }, snapshot, purchase,
      previewDomain: (change) => (change.ops.length ? applyPatch(purchase, change.ops, { seed: 'escopo-c', eventId: 'tg-update-9', maxParticipants: 100 }).state : purchase),
      signal: new AbortController().signal, beforeExternalWrite: () => { throw new Error('escrita proibida'); } });
  }

  it('proposta que não apareceu no último snapshot não pode ser escolhida', () => {
    let s = people('Ana');
    s = apply(s, [{ op: 'SET_PROPOSALS', proposals: composeProposals(s, [candidate({ name: 'Arroz', price: 20 })], { seed: 'x' }).proposals.map((p) => p.proposal) }]);
    const plan = planActions(s, { actions: [{ action: 'SELECT_PROPOSAL', position: 1 }] },
      (change) => (change.ops.length ? applyPatch(s, change.ops, ctx()).state : s), null, 'quero a proposta 1', new Set());
    expect(plan.ops).toEqual([]);
    expect(plan.notes.join(' ')).toMatch(/não foi exibida/);
  });

  it('revisão que não cabe no limite de resposta: a escolha não é gravada e o motivo aparece', async () => {
    const names = Array.from({ length: 100 }, (_, i) => `Ção Ñúñez Ação Ímpar ${'é'.repeat(50)} ${i}`.slice(0, 80));
    let s = people(...names);
    const allergies = ['PEANUT', 'MILK', 'EGG', 'GLUTEN', 'TREE_NUTS', 'SOY', 'FISH', 'SEAFOOD'] as const;
    const diets = ['VEGAN', 'VEGETARIAN', 'LACTOSE_FREE', 'GLUTEN_FREE', 'NO_PORK', 'SUGAR_FREE', 'ORGANIC'] as const;
    for (const p of s.participants.slice(35)) {
      s = apply(s, [...allergies.map((code) => ({ op: 'ADD_RESTRICTION' as const, participantId: p.participantId, key: { kind: 'ALLERGY' as const, code } })),
        ...diets.map((code) => ({ op: 'ADD_RESTRICTION' as const, participantId: p.participantId, key: { kind: 'DIETARY' as const, code } }))]);
    }
    s = apply(s, [{ op: 'SET_PROPOSALS', proposals: composeProposals(s, [candidate({ name: `Prato ${'á'.repeat(150)}`, price: 20 })], { seed: 'x' }).proposals.map((p) => p.proposal) }]);
    const shown: Snapshot = { ...BASE, blocks: s.proposals!.map((p) => ({ kind: 'PROPOSAL' as const, proposalRef: p.proposalId, coverage: [], price: { kind: 'UNKNOWN' as const, currency: 'BRL' as const } })) };
    const r = await turn(s, shown, 'quero a proposta 1');
    expect(r.domain?.ops.some((o) => o.op === 'SELECT_PROPOSAL') ?? false).toBe(false);
    expect(r.snapshot.pending.slice(0, 2).join(' ')).toMatch(/grande demais para mostrar a revisão da sacola/);
    expect(Buffer.byteLength(JSON.stringify(r.snapshot))).toBeLessThan(63_000); // cabe nos 64 KiB do runtime (GROUP da AI-02 não é cortado)
    expect(r.snapshot.blocks.some((b) => b.kind === 'REVIEW')).toBe(false);
  });

  it('grupo comum: a escolha passa normalmente', async () => {
    let s = people('Ana', 'Bia');
    s = apply(s, [{ op: 'SET_PROPOSALS', proposals: composeProposals(s, [candidate({ name: 'Arroz', price: 20 })], { seed: 'x' }).proposals.map((p) => p.proposal) }]);
    const shown: Snapshot = { ...BASE, blocks: s.proposals!.map((p) => ({ kind: 'PROPOSAL' as const, proposalRef: p.proposalId, coverage: [], price: { kind: 'UNKNOWN' as const, currency: 'BRL' as const } })) };
    const r = await turn(s, shown, 'quero a proposta 1');
    expect(r.domain?.ops.map((o) => o.op)).toEqual(['SELECT_PROPOSAL']);
    expect(r.snapshot.blocks.some((b) => b.kind === 'REVIEW')).toBe(true);
  });
});

describe('auditoria final — F: assinatura de restrições normalizada', () => {
  it('requirement omitido e MANDATORY explícito geram a mesma assinatura', async () => {
    const { restrictionsSig } = await import('../../src/server/domain/purchase');
    const a = people('Ana');
    const id = a.participants[0]!.participantId;
    const s1 = apply(a, [{ op: 'ADD_RESTRICTION', participantId: id, key: { kind: 'DIETARY', code: 'VEGAN' } }]);
    const s2 = apply(a, [{ op: 'ADD_RESTRICTION', participantId: id, key: { kind: 'DIETARY', code: 'VEGAN', requirement: 'MANDATORY' } }]);
    expect(restrictionsSig(s1, s1.participants[0]!)).toBe(restrictionsSig(s2, s2.participants[0]!));
    const s3 = apply(a, [{ op: 'ADD_RESTRICTION', participantId: id, key: { kind: 'DIETARY', code: 'VEGAN', requirement: 'PREFERENCE' } }]);
    expect(restrictionsSig(s3, s3.participants[0]!)).not.toBe(restrictionsSig(s1, s1.participants[0]!));
  });
});
