// GRP-01 × DATA-01: propostas versionadas pelo estado, carrinho simulado, invalidação e consumo sem órfãos.
import { describe, expect, it } from 'vitest';
import { applyLinkChange, applyPatch, DomainError, restrictionsSig, type Proposal, type PurchaseState } from '../../src/server/domain/purchase';
import { M1, M2 } from './catalog';

const ctx = (eventId: string) => ({ seed: 'escopo-bag', eventId });
const code = (fn: () => unknown) => { try { fn(); return 'ok'; } catch (e) { return e instanceof DomainError ? e.code : String(e); } };

function base(): PurchaseState {
  const s = applyPatch(null, [{ op: 'ADD_PARTICIPANT', displayName: 'Ana' }, { op: 'ADD_PARTICIPANT', displayName: 'Bia' }], ctx('e1')).state;
  return applyPatch(s, s.participants.map((p) => ({ op: 'SET_RESTRICTIONS' as const, participantId: p.participantId, value: 'NONE' as const })), ctx('e2')).state;
}
function proposal(s: PurchaseState, id = 'a', merchantId = M1, shared = false): Proposal {
  const [ana, bia] = s.participants.map((p) => p.participantId);
  const lines = shared
    ? [{ lineId: `${id}l1`.padEnd(24, '0'), itemId: 'item-1', name: 'Pizza grande', optionIds: [], quantity: 1, consumerIds: [ana!, bia!], unitMinCents: 6000, unitMaxCents: 6000 }]
    : [
      { lineId: `${id}l1`.padEnd(24, '0'), itemId: 'item-1', name: 'Arroz', optionIds: [], quantity: 1, consumerIds: [ana!], unitMinCents: 2000, unitMaxCents: 2000 },
      { lineId: `${id}l2`.padEnd(24, '0'), itemId: 'item-2', name: 'Feijão', optionIds: [], quantity: 1, consumerIds: [bia!], unitMinCents: 1500, unitMaxCents: 1500 },
    ];
  const consumers = new Set(lines.flatMap((l) => l.consumerIds));
  const coverage = s.participants.map((p) => consumers.has(p.participantId)
    ? { participantId: p.participantId, status: 'COVERED' as const, reason: null, restrictionsSig: restrictionsSig(s, p) }
    : { participantId: p.participantId, status: 'BLOCKED' as const, reason: 'NOT_IN_PLAN' });
  return { proposalId: id.padEnd(24, 'p'), merchantId, lines, deliveryFeeCents: 799, minimumOrderCents: null, coverage };
}
const withProposals = (s: PurchaseState, ps: Proposal[]) => applyPatch(s, [{ op: 'SET_PROPOSALS', proposals: ps }], ctx('e3')).state;
const select = (s: PurchaseState, id: string) => applyPatch(s, [{ op: 'SELECT_PROPOSAL', proposalId: id.padEnd(24, 'p') }], ctx('e4'));

describe('propostas', () => {
  it('SET_PROPOSALS guarda até 4 e qualquer outra alteração as invalida', () => {
    const s = withProposals(base(), [proposal(base(), 'a'), proposal(base(), 'b', M2)]);
    expect(s.proposals).toHaveLength(2);
    const after = applyPatch(s, [{ op: 'SET_PRIORITY', value: 'SPEED' }], ctx('e5'));
    expect(after.state.proposals).toBeUndefined();
    expect(after.paths).toContain('PROPOSALS');
  });

  it('proposta com consumidor inexistente, faixa invertida ou loja diferente da declarada é recusada', () => {
    const s = base();
    const bad = proposal(s);
    expect(code(() => withProposals(s, [{ ...bad, lines: [{ ...bad.lines[0]!, consumerIds: ['ninguem-0000000000000000'] }] }]))).toBe('PROPOSAL_INVALID');
    expect(code(() => withProposals(s, [{ ...bad, lines: [{ ...bad.lines[0]!, unitMinCents: 10, unitMaxCents: 5 }] }]))).toBe('PROPOSAL_INVALID');
    const fixed = applyPatch(s, [{ op: 'SET_MERCHANT', merchantId: M2 }], ctx('e5')).state;
    expect(code(() => withProposals(fixed, [proposal(fixed, 'a', M1)]))).toBe('PROPOSAL_INVALID');
    expect(code(() => applyPatch(s, [{ op: 'SET_PROPOSALS', proposals: [bad, bad, bad, bad, bad] }], ctx('e6')))).toBe('INVALID_PATCH');
  });
});

describe('carrinho simulado', () => {
  it('escolher proposta cria o carrinho e fixa a loja (D2); escolha inexistente é recusada', () => {
    const s = withProposals(base(), [proposal(base(), 'a')]);
    const r = select(s, 'a');
    expect(r.state.bag).toMatchObject({ proposalId: 'a'.padEnd(24, 'p'), status: 'CURRENT', merchantId: M1, origin: { eventId: 'e4' } });
    expect(r.state.merchant).toMatchObject({ state: 'DECLARED', value: { merchantId: M1 } });
    expect(r.paths).toContain('CART');
    expect(code(() => select(s, 'z'))).toBe('PROPOSAL_NOT_FOUND');
  });

  it('remover participante tira o consumo dele; linha sem consumidor some; carrinho precisa ser revalidado', () => {
    const s = select(withProposals(base(), [proposal(base(), 'a')]), 'a').state;
    const bia = s.participants[1]!.participantId;
    const r = applyPatch(s, [{ op: 'REMOVE_PARTICIPANT', participantId: bia }], ctx('e5')).state;
    expect(r.bag!.lines.map((l) => l.consumerIds)).toEqual([[s.participants[0]!.participantId]]);
    expect(r.bag!.status).toBe('NEEDS_REVALIDATION');
    expect(JSON.stringify(r.bag)).not.toContain(bia);
  });

  it('item compartilhado: quem sai deixa a linha com os demais; último consumidor removido apaga o carrinho', () => {
    const s = select(withProposals(base(), [proposal(base(), 's', M1, true)]), 's').state;
    const [ana, bia] = s.participants.map((p) => p.participantId);
    const one = applyPatch(s, [{ op: 'REMOVE_PARTICIPANT', participantId: bia! }], ctx('e5')).state;
    expect(one.bag!.lines[0]!.consumerIds).toEqual([ana]);
    expect(applyPatch(one, [{ op: 'REMOVE_PARTICIPANT', participantId: ana! }], ctx('e6')).state.bag).toBeUndefined();
  });

  it('mudar restrição, teto, participantes ou endereço exige revalidar; prioridade e nome não', () => {
    const s = select(withProposals(base(), [proposal(base(), 'a')]), 'a').state;
    const ana = s.participants[0]!.participantId;
    for (const op of [{ op: 'ADD_RESTRICTION', participantId: ana, key: { kind: 'ALLERGY', code: 'EGG' } }, { op: 'SET_LIMIT', target: 'GROUP', value: { amountCents: 100, kind: 'MANDATORY' } },
      { op: 'ADD_PARTICIPANT', displayName: 'Caio' }, { op: 'SET_ADDRESS', addressId: 'addr-2' }]) {
      expect(applyPatch(s, [op], ctx('e5')).state.bag!.status).toBe('NEEDS_REVALIDATION');
    }
    for (const op of [{ op: 'SET_PRIORITY', value: 'SPEED' }, { op: 'RENAME_PARTICIPANT', participantId: ana, displayName: 'Ana Maria' }]) {
      expect(applyPatch(s, [op], ctx('e5')).state.bag!.status).toBe('CURRENT');
    }
  });

  it('trocar de loja ou de conta apaga carrinho e propostas; CLEAR_BAG esvazia', () => {
    const s = select(withProposals(base(), [proposal(base(), 'a')]), 'a').state;
    expect(applyPatch(s, [{ op: 'SET_MERCHANT', merchantId: M2 }], ctx('e5')).state.bag).toBeUndefined();
    const linked = applyLinkChange({ ...s, linkId: 'link-A' }, 'link-B')!.state;
    expect(linked.bag).toBeUndefined();
    expect(linked.proposals).toBeUndefined();
    expect(applyPatch(s, [{ op: 'CLEAR_BAG' }], ctx('e5')).state.bag).toBeUndefined();
  });

  it('estado antigo sem carrinho/propostas continua válido (campos opcionais)', () => {
    const s = base();
    expect('bag' in s || 'proposals' in s).toBe(false);
  });
});
