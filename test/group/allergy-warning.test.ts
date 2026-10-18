// Decisão de produto (18/10/2026): alergia/restrição sem dado do iFood vira AVISO; conflito informado continua excluindo.
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

describe('alergia desconhecida não bloqueia a pessoa', () => {
  it('item sem informação de alérgeno é elegível com aviso ALLERGY_UNVERIFIED', () => {
    const c = candidate({ name: 'Pizza de mussarela', description: 'Queijo e molho', price: 40 });
    const e = evaluateCandidate(c, { restrictions: [{ kind: 'ALLERGY', code: 'PEANUT' }] });
    expect(e.blockers.map(b => b.code)).not.toContain('ALLERGY_UNVERIFIED');
    expect(e.warnings.map(w => w.code)).toContain('ALLERGY_UNVERIFIED');
    expect(e.eligible).toBe(true);
  });

  it('grupo com alérgico recebe proposta completa, com aviso explícito para confirmar com o restaurante', () => {
    const s = people('Ana', 'Bia');
    const r = composeProposals(s, [candidate({ name: 'Pizza de mussarela', description: 'Queijo e molho', price: 40 })], { seed: 'x' });
    expect(r.proposals.length).toBeGreaterThan(0);
    expect(r.proposals[0]!.coverage.every(c => c.status === 'COVERED')).toBe(true);
    const cell = r.matrix.find(c => c.participantId === s.participants[0]!.participantId)!;
    expect(cell).toMatchObject({ status: 'COMPATIBLE', warnings: ['ALLERGY_UNVERIFIED'] });
    expect(r.explanation[1]).toMatch(/^Atenção: o iFood não informa ingredientes nem alérgenos\. As restrições de Ana .*confirme com o restaurante/);
    expect(r.explanation.join(' ')).not.toMatch(/sem item liberado/);
  });

  it('uso individual com alergia também recebe proposta e aviso', () => {
    const s = people('Você');
    const r = composeProposals(s, [candidate({ name: 'Hambúrguer', description: 'Pão e carne', price: 30 })], { seed: 'x' });
    expect(r.proposals[0]!.coverage[0]!.status).toBe('COVERED');
    expect(r.explanation.some(t => t.includes('As restrições de Você'))).toBe(true);
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
