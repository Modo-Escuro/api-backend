// Regra confirmada em 20/10: UNKNOWN obrigatório bloqueia por consumidor; preferência não vira obrigação.
import { describe, expect, it } from 'vitest';
import { composeProposals } from '../../src/server/domain/group';
import { evaluateCandidate } from '../../src/server/domain/eligibility';
import { applyPatch, type PurchaseState } from '../../src/server/domain/purchase';
import { candidate } from './catalog';

const ctx = (eventId: string) => ({ seed: 'allergy-warning', eventId });
function people(allergic: string, other?: string): PurchaseState {
  const names = other ? [allergic, other] : [allergic];
  let s = applyPatch(null, names.map(displayName => ({ op: 'ADD_PARTICIPANT' as const, displayName })), ctx('e1')).state;
  s = applyPatch(s, [
    { op: 'ADD_RESTRICTION', participantId: s.participants[0]!.participantId, key: { kind: 'ALLERGY', code: 'PEANUT' } },
    ...(other ? [{ op: 'SET_RESTRICTIONS' as const, participantId: s.participants[1]!.participantId, value: 'NONE' as const }] : []),
  ], ctx('e2')).state;
  return s;
}

describe('alergia desconhecida bloqueia o item para a pessoa', () => {
  it('item sem informação de alérgeno não é elegível', () => {
    const c = candidate({ name: 'Pizza de mussarela', description: 'Queijo e molho', price: 40 });
    const e = evaluateCandidate(c, { restrictions: [{ kind: 'ALLERGY', code: 'PEANUT' }] });
    expect(e.blockers.map(b => b.code)).toContain('ALLERGY_UNVERIFIED');
    expect(e.eligible).toBe(false);
  });

  it('bloqueio de Ana não impede cobertura de Bia nem aparece como cobertura completa', () => {
    const s = people('Ana', 'Bia');
    const r = composeProposals(s, [candidate({ name: 'Pizza de mussarela', description: 'Queijo e molho', price: 40 })], { seed: 'x' });
    expect(r.proposals.length).toBeGreaterThan(0);
    expect(r.proposals[0]!.coverage.map(c => c.status)).toEqual(['NEEDS_VERIFICATION', 'COVERED']);
    const cell = r.matrix.find(c => c.participantId === s.participants[0]!.participantId)!;
    expect(cell).toMatchObject({ status: 'NEEDS_VERIFICATION', reasons: ['ALLERGY_UNVERIFIED'] });
    expect(r.proposals[0]!.approvalBlockers).toContain('PARTIAL_COVERAGE');
    expect(r.proposals[0]!.proposal.lines.every(l => !l.consumerIds.includes(s.participants[0]!.participantId))).toBe(true);
  });

  it('uso individual com alergia desconhecida não recebe proposta elegível', () => {
    const s = people('Você');
    const r = composeProposals(s, [candidate({ name: 'Hambúrguer', description: 'Pão e carne', price: 30 })], { seed: 'x' });
    expect(r.proposals).toHaveLength(0);
    expect(r.matrix[0]).toMatchObject({ status: 'NEEDS_VERIFICATION', reasons: ['ALLERGY_UNVERIFIED'] });
  });

  it('alérgeno citado na descrição continua bloqueando (não é dado desconhecido)', () => {
    const c = candidate({ name: 'Brownie da casa', description: 'Chocolate com pedaços de amendoim', price: 15 });
    const e = evaluateCandidate(c, { restrictions: [{ kind: 'ALLERGY', code: 'PEANUT' }] });
    expect(e.blockers.map(b => b.code)).toContain('RESTRICTION_FAIL');
    const s = people('Ana');
    const r = composeProposals(s, [c], { seed: 'x' });
    expect(r.matrix[0]!.status).toBe('INCOMPATIBLE');
  });

  it('conflito informado pelo iFood continua excluindo o item', () => {
    const vegan = applyPatch(null, [{ op: 'ADD_PARTICIPANT', displayName: 'Bia' }], ctx('v1')).state;
    const withDiet = applyPatch(vegan, [{ op: 'ADD_RESTRICTION', participantId: vegan.participants[0]!.participantId,
      key: { kind: 'DIETARY', code: 'VEGETARIAN', requirement: 'MANDATORY' } }], ctx('v2')).state;
    const meat = candidate({ name: 'Picanha na chapa', description: 'Carne bovina', price: 50 });
    const e = evaluateCandidate(meat, { restrictions: [{ kind: 'DIETARY', code: 'VEGETARIAN' }] });
    expect(e.blockers.map(b => b.code)).toContain('RESTRICTION_FAIL');
    const r = composeProposals(withDiet, [meat], { seed: 'x' });
    expect(r.matrix[0]!.status).toBe('INCOMPATIBLE');
    expect(r.proposals.every(p => p.coverage.every(c => c.status !== 'COVERED'))).toBe(true);
  });
});
