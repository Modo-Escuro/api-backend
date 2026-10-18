// GRP-01: composição de propostas coletivas (domínio puro) com DATA-01 + DOM-01.
import { describe, expect, it } from 'vitest';
import { composeProposals, evaluatePlan, planCoverage, restrictionsSig, type PlanEvaluation, type PlanRanker } from '../../src/server/domain/group';
import { applyPatch, type DomainOp, type Proposal, type PurchaseState } from '../../src/server/domain/purchase';
import { M1, M2, candidate } from './catalog';

const ctx = (eventId = 'e1') => ({ seed: 'escopo-grp', eventId });
function group(...specs: [string, DomainOp['op'] extends never ? never : Partial<{ restrictions: 'NONE' | 'VEGETARIAN' | 'MILK' | 'NOT_ASKED'; limit: { amountCents: number; kind: 'MANDATORY' | 'PREFERENCE' } | 'UNCLEAR' }>][]): PurchaseState {
  let s = applyPatch(null, specs.map(([name]) => ({ op: 'ADD_PARTICIPANT' as const, displayName: name })), ctx()).state;
  const ops: DomainOp[] = [];
  specs.forEach(([, o], i) => {
    const id = s.participants[i]!.participantId;
    if (o.restrictions === 'NONE') ops.push({ op: 'SET_RESTRICTIONS', participantId: id, value: 'NONE' });
    if (o.restrictions === 'VEGETARIAN') ops.push({ op: 'ADD_RESTRICTION', participantId: id, key: { kind: 'DIETARY', code: 'VEGETARIAN' } });
    if (o.restrictions === 'MILK') ops.push({ op: 'ADD_RESTRICTION', participantId: id, key: { kind: 'ALLERGY', code: 'MILK' } });
    if (o.limit === 'UNCLEAR') ops.push({ op: 'MARK_UNCLEAR', target: id, field: 'LIMIT', question: 'Qual o teto?' });
    else if (o.limit) ops.push({ op: 'SET_LIMIT', target: id, value: o.limit });
  });
  if (ops.length) s = applyPatch(s, ops, ctx('e2')).state;
  return s;
}
const ids = (s: PurchaseState) => s.participants.map((p) => p.participantId);
const status = (p: PlanEvaluation, s: PurchaseState) => s.participants.map((x) => p.coverage.find((c) => c.participantId === x.participantId)!.status);

describe('matriz participante × item e cobertura', () => {
  it('restrições diferentes recebem itens diferentes; ninguém é excluído em silêncio', () => {
    const s = group(['Ana', { restrictions: 'NONE' }], ['Bia', { restrictions: 'VEGETARIAN' }], ['Caio', { restrictions: 'MILK' }]);
    const veg = candidate({ name: 'Salada de grãos', price: 30, filters: ['VEGETARIAN'] });
    const meat = candidate({ name: 'Hambúrguer de carne', price: 25 });
    const r = composeProposals(s, [veg, meat], { seed: 'x' });
    expect(r.proposals.length).toBeGreaterThan(0);
    const best = r.proposals[0]!;
    const [ana, bia, caio] = ids(s);
    expect(best.proposal.lines.find((l) => l.consumerIds[0] === bia)!.itemId).toBe(veg.listing.itemId);
    // Decisão de produto: alergia sem dado do iFood não bloqueia; a pessoa é atendida com aviso explícito.
    expect(best.proposal.lines.some((l) => l.consumerIds.includes(caio!))).toBe(true);
    expect(status(best, s)).toEqual(['COVERED', 'COVERED', 'COVERED']);
    expect(best.approvalBlockers).not.toContain('PARTIAL_COVERAGE');
    expect(r.matrix.filter((c) => c.participantId === caio && c.status === 'COMPATIBLE').every((c) => c.warnings?.includes('ALLERGY_UNVERIFIED'))).toBe(true);
    expect(r.matrix.filter((c) => c.participantId === ana).every((c) => !c.warnings)).toBe(true);
    expect(r.explanation[0]).toMatch(/^Busca limitada:.*não prova que não existe combinação válida/);
    expect(r.explanation[1]).toMatch(/^Atenção: o iFood não informa ingredientes nem alérgenos\. As restrições de .*Caio.* confirme com o restaurante antes de pedir\.$/);
    expect(r.explanation[1]).not.toMatch(/Ana/);
    expect(r.explanation.some((e) => e.startsWith('Sem atendimento'))).toBe(false);
    // Conflito informado continua excluindo: carne nunca vai para a pessoa vegetariana.
    expect(r.matrix.find((c) => c.participantId === bia && c.itemId === meat.listing.itemId)!.status).toBe('INCOMPATIBLE');
    expect(best.proposal.lines.every((l) => l.consumerIds.length === 1 && l.quantity === 1)).toBe(true);
    expect(ana).toBeDefined();
  });

  it('alergia nunca vira PASS: item com leite é incompatível e item sem dado é liberado com aviso', () => {
    const s = group(['Caio', { restrictions: 'MILK' }]);
    const queijo = candidate({ name: 'Pizza de queijo', description: 'Mussarela e molho', price: 40 }), arroz = candidate({ name: 'Arroz', price: 20 });
    const r = composeProposals(s, [queijo, arroz], { seed: 'x' });
    expect(r.matrix.find((c) => c.itemId === queijo.listing.itemId)).toMatchObject({ status: 'INCOMPATIBLE', reasons: ['RESTRICTION_FAIL'] });
    expect(r.matrix.find((c) => c.itemId === arroz.listing.itemId)).toMatchObject({ status: 'COMPATIBLE', warnings: ['ALLERGY_UNVERIFIED'] });
    expect(r.proposals).toHaveLength(1);
    expect(r.proposals[0]!.proposal.lines.map((l) => l.itemId)).toEqual([arroz.listing.itemId]);
    expect(r.explanation).toContain('Atenção: o iFood não informa ingredientes nem alérgenos. As restrições de Caio não puderam ser verificadas nos itens sugeridos; confirme com o restaurante antes de pedir.');
  });

  it('restrições não informadas bloqueiam a pessoa (UNKNOWN não é compatível)', () => {
    const s = group(['Ana', { restrictions: 'NONE' }], ['Dani', {}]);
    const r = composeProposals(s, [candidate({ name: 'Arroz', price: 20 })], { seed: 'x' });
    expect(status(r.proposals[0]!, s)).toEqual(['COVERED', 'NEEDS_VERIFICATION']);
    expect(r.explanation).toContain('Sem atendimento (restrições alimentares não informadas ou a confirmar): Dani.');
  });

  it('preço ausente não vira zero: item sem preço não entra em plano', () => {
    const s = group(['Ana', { restrictions: 'NONE' }]);
    const r = composeProposals(s, [candidate({ name: 'Sem preço', price: null })], { seed: 'x' });
    expect(r.proposals).toEqual([]);
    expect(r.matrix[0]!.status).not.toBe('COMPATIBLE');
  });
});

describe('custos (DOM-01): frete único, rateio exato, faixas e desconhecidos', () => {
  it('frete não é duplicado por pessoa e o rateio fecha em centavos', () => {
    const s = group(['Ana', { restrictions: 'NONE' }], ['Bia', { restrictions: 'NONE' }], ['Caio', { restrictions: 'NONE' }]);
    const r = composeProposals(s, [candidate({ name: 'Arroz', price: 20, fee: 7.99 })], { seed: 'x' });
    const p = r.proposals[0]!;
    expect(p.lowerBoundCents).toBe(3 * 2000 + 799);
    expect(p.perParticipant.reduce((n, x) => n + x.lowerBoundCents!, 0)).toBe(p.lowerBoundCents);
    expect(p.approvalBlockers).toContain('TOTAL_UNKNOWN'); // taxa de serviço nunca observada
  });

  it('item compartilhado: custo dividido só entre quem consome; quem não consome não paga frete', () => {
    const s = group(['Ana', { restrictions: 'NONE' }], ['Bia', { restrictions: 'NONE' }], ['Caio', { restrictions: 'NONE' }]);
    const [ana, bia] = ids(s);
    const coverage = s.participants.map((p) => ({ participantId: p.participantId, status: 'COVERED' as const, reason: null, restrictionsSig: restrictionsSig(s, p) }));
    const shared: Proposal = { proposalId: 'p'.repeat(24), merchantId: M1, deliveryFeeCents: 799, minimumOrderCents: null, coverage,
      lines: [{ lineId: 'l'.repeat(24), itemId: M1, name: 'Pizza grande', optionIds: [], quantity: 1, consumerIds: [ana!, bia!], unitMinCents: 6001, unitMaxCents: 6001 }] };
    const ev = evaluatePlan(s, shared, planCoverage(s, shared));
    const rows = Object.fromEntries(ev.perParticipant.map((x) => [x.participantId, x.lowerBoundCents]));
    expect(rows[ana!]! + rows[bia!]!).toBe(6001 + 799);
    expect(rows[ids(s)[2]!]).toBe(0);
    expect(status(ev, s)).toEqual(['COVERED', 'COVERED', 'BLOCKED']);
  });

  it('taxa de entrega e faixa de preço desconhecidas impedem total confirmado', () => {
    const s = group(['Ana', { restrictions: 'NONE' }]);
    const p = composeProposals(s, [candidate({ name: 'Arroz', price: 20, fee: null })], { seed: 'x' }).proposals[0]!;
    expect(p.approvalBlockers).toEqual(expect.arrayContaining(['TOTAL_UNKNOWN', 'DELIVERY_FEE_UNKNOWN']));
    const ranged: Proposal = { ...p.proposal, lines: [{ ...p.proposal.lines[0]!, unitMinCents: 2000, unitMaxCents: null }] };
    expect(evaluatePlan(s, ranged, planCoverage(s, ranged)).approvalBlockers).toContain('PRICE_RANGE');
  });
});

describe('tetos', () => {
  it('teto individual rígido estourado invalida o plano; opção mais barata vira proposta', () => {
    const s = group(['Ana', { restrictions: 'NONE', limit: { amountCents: 2500, kind: 'MANDATORY' } }]);
    const r = composeProposals(s, [candidate({ name: 'Caro', price: 40, fee: 0 }), candidate({ name: 'Barato', price: 20, fee: 0 })], { seed: 'x' });
    expect(r.proposals.map((p) => p.proposal.lines[0]!.name)).toEqual(['Barato']);
    expect(r.search.validPlans).toBe(1);
    expect(r.proposals[0]!.caps).toEqual([{ target: ids(s)[0], kind: 'MANDATORY', status: 'UNVERIFIABLE' }]);
  });

  it('teto coletivo estourado: cobertura parcial explícita, com explicação e limite da busca', () => {
    let s = group(['Ana', { restrictions: 'NONE' }], ['Bia', { restrictions: 'NONE' }]);
    s = applyPatch(s, [{ op: 'SET_LIMIT', target: 'GROUP', value: { amountCents: 3000, kind: 'MANDATORY' } }], ctx('e3')).state;
    const r = composeProposals(s, [candidate({ name: 'Arroz', price: 20, fee: 0 })], { seed: 'x' });
    expect(r.proposals).toHaveLength(1);
    const p = r.proposals[0]!;
    expect(p.coverage.map((c) => [c.status, c.reason]).sort()).toEqual([['BLOCKED', 'GROUP_LIMIT'], ['COVERED', null]]);
    expect(p.approvalBlockers).toContain('PARTIAL_COVERAGE');
    expect(r.explanation[0]).toMatch(/não prova que não existe combinação válida/);
    expect(r.explanation.join(' ')).toMatch(/para caber no teto do grupo, pelos preços observados/);
    expect(r.explanation.join(' ')).toMatch(/menor soma de preços observados encontrada é R\$ 20\.00/);
    expect(r.explanation.join(' ')).toMatch(/cupons, descontos ou frete de assinatura não visíveis/);
  });

  it('teto coletivo abaixo de qualquer item: nenhum plano, sem afirmar impossibilidade global', () => {
    let s = group(['Ana', { restrictions: 'NONE' }]);
    s = applyPatch(s, [{ op: 'SET_LIMIT', target: 'GROUP', value: { amountCents: 1000, kind: 'MANDATORY' } }], ctx('e3')).state;
    const r = composeProposals(s, [candidate({ name: 'Arroz', price: 20, fee: 0 })], { seed: 'x' });
    expect(r.proposals).toEqual([]);
    expect(r.explanation[0]).toMatch(/não prova que não existe combinação válida/);
    expect(r.explanation).toContain('Sem atendimento (ficaram de fora para caber no teto do grupo, pelos preços observados): Ana.');
  });

  it('teto ambíguo bloqueia aprovação (UNVERIFIABLE); preferência excedida só gera aviso', () => {
    const s = group(['Ana', { restrictions: 'NONE', limit: 'UNCLEAR' }], ['Bia', { restrictions: 'NONE', limit: { amountCents: 1000, kind: 'PREFERENCE' } }]);
    const p = composeProposals(s, [candidate({ name: 'Arroz', price: 20 })], { seed: 'x' }).proposals[0]!;
    expect(p.valid).toBe(true);
    expect(p.approvalBlockers).toContain('LIMIT_UNVERIFIABLE');
    expect(p.warnings).toEqual([`PREFERENCE_LIMIT_EXCEEDED:${ids(s)[1]}`]);
    expect(p.caps).toEqual(expect.arrayContaining([{ target: ids(s)[0], kind: 'UNCLEAR', status: 'UNVERIFIABLE' }]));
  });

  it('pedido mínimo inalcançável invalida; incerto bloqueia aprovação', () => {
    const s = group(['Ana', { restrictions: 'NONE' }]);
    expect(composeProposals(s, [candidate({ name: 'Arroz', price: 20, minimumOrder: 50 })], { seed: 'x' }).proposals).toEqual([]);
    const p = composeProposals(s, [candidate({ name: 'Arroz', price: 60, minimumOrder: 50 })], { seed: 'x' }).proposals[0]!;
    expect(p.approvalBlockers).not.toContain('MINIMUM_ORDER_UNVERIFIED');
  });
});

describe('loja única, ranking e corte', () => {
  it('planos nunca misturam lojas; loja declarada restringe a busca', () => {
    const s = group(['Ana', { restrictions: 'NONE' }], ['Bia', { restrictions: 'NONE' }]);
    const cands = [candidate({ name: 'A1', price: 20, merchantId: M1 }), candidate({ name: 'B1', price: 18, merchantId: M2 })];
    const r = composeProposals(s, cands, { seed: 'x' });
    for (const p of r.proposals) expect(new Set(p.proposal.lines.map((l) => cands.find((c) => c.listing.itemId === l.itemId)!.listing.merchant.merchantId)).size).toBe(1);
    const fixed = applyPatch(s, [{ op: 'SET_MERCHANT', merchantId: M1 }], ctx('e3')).state;
    expect(composeProposals(fixed, cands, { seed: 'x' }).proposals.every((p) => p.proposal.merchantId === M1)).toBe(true);
  });

  it('top-4 não elimina a única opção que atende um participante (mesmo com ranqueador que a coloca no fim)', () => {
    const s = group(['Ana', { restrictions: 'NONE' }], ['Bia', { restrictions: 'VEGETARIAN' }], ['Caio', { restrictions: 'NONE' }]);
    // Carne: conflito informado para a vegetariana (sem dado, o item a atenderia com aviso).
    const m1 = [20, 21, 22, 23, 24].map((p, i) => candidate({ name: `Hambúrguer de carne ${i}`, price: p, merchantId: M1, fee: 0 }));
    const m2 = [candidate({ name: 'Vegetariano caro', price: 90, merchantId: M2, filters: ['VEGETARIAN'], fee: 0 })];
    // Ranqueador (contrato RANK-03) que ignora cobertura e põe o mais barato primeiro: o plano da loja 2 cai para o fim.
    const cheapestFirst: PlanRanker = { id: 'teste', rank: (plans) => [...plans].sort((a, b) => a.lowerBoundCents! - b.lowerBoundCents!) };
    const ranked = cheapestFirst.rank(composeProposals(s, [...m1, ...m2], { seed: 'x', limits: { maxPlansPerMerchant: 30 }, ranker: { id: 'id', rank: (p) => [...p] } }).proposals, { priority: null });
    const r = composeProposals(s, [...m1, ...m2], { seed: 'x', limits: { maxPlansPerMerchant: 30 }, ranker: cheapestFirst });
    const coversBia = (p: PlanEvaluation) => p.coverage.some((c) => c.participantId === ids(s)[1] && c.status === 'COVERED');
    expect(r.search.validPlans).toBeGreaterThan(4);
    expect(r.proposals).toHaveLength(4);
    expect(r.proposals.filter(coversBia)).toHaveLength(1); // resgatado no corte
    expect(r.proposals.at(-1)!.proposal.merchantId).toBe(M2); // ordem do ranking preservada
    expect(r.rankerId).toBe('teste');
    expect(ranked.length).toBeLessThanOrEqual(4);
  });

  it('determinístico: mesma entrada, mesmas propostas e IDs; prioridade rapidez muda a ordem', () => {
    const s = group(['Ana', { restrictions: 'NONE' }]);
    const cands = [candidate({ name: 'Barato lento', price: 20, fee: 0, etaMax: 90, merchantId: M1 }), candidate({ name: 'Caro rápido', price: 30, fee: 0, etaMax: 20, merchantId: M2 })];
    const a = composeProposals(s, cands, { seed: 'x' });
    expect(composeProposals(s, cands, { seed: 'x' })).toEqual(a);
    expect(a.proposals[0]!.proposal.lines[0]!.name).toBe('Barato lento');
    const fast = applyPatch(s, [{ op: 'SET_PRIORITY', value: 'SPEED' }], ctx('e3')).state;
    expect(composeProposals(fast, cands, { seed: 'x' }).proposals[0]!.proposal.lines[0]!.name).toBe('Caro rápido');
  });

  it('limites da busca são declarados quando há corte', () => {
    const s = group(['Ana', { restrictions: 'NONE' }]);
    const cands = Array.from({ length: 6 }, (_, i) => candidate({ name: `Item ${i}`, price: 20 + i }));
    expect(composeProposals(s, cands, { seed: 'x', limits: { maxOptionsPerParticipant: 3 } }).search.truncated.some((t) => t.startsWith('MAX_OPTIONS'))).toBe(true);
  });
});
