// DATA-01: domínio puro da compra — patches tipados, atomicidade, distinção de estados, restrições rígidas,
// troca de conta e evidência (DEC-01 D1, D2, D5, D6).
import { describe, expect, it } from 'vitest';
import {
  MoneyLimitSchema, applyLinkChange, applyPatch, DomainError, emptyPurchase, findEvidence, nextPurchase, parsePurchaseState, recordEvidence,
  type DomainOp, type PatchContext, type PurchaseState,
} from '../../src/server/domain/purchase';

const ctx = (eventId = 'evt-1', over: Partial<PatchContext> = {}): PatchContext => ({ seed: 'escopo-sintetico', eventId, ...over });
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof DomainError ? e.code : `outro:${String(e)}`;
  }
  return 'sem-erro';
};

/** Compra com dois participantes (Ana com alergia a amendoim, Bia sem restrições) e teto coletivo de R$ 180. */
function seeded(): PurchaseState {
  const a = applyPatch(null, [{ op: 'ADD_PARTICIPANT', displayName: 'Ana' }, { op: 'ADD_PARTICIPANT', displayName: 'Bia' }], ctx('evt-1')).state;
  const [ana, bia] = a.participants;
  return applyPatch(a, [
    { op: 'ADD_RESTRICTION', participantId: ana!.participantId, key: { kind: 'ALLERGY', code: 'PEANUT' } },
    { op: 'ADD_RESTRICTION', participantId: ana!.participantId, key: { kind: 'DIETARY', code: 'VEGAN', requirement: 'PREFERENCE' } },
    { op: 'SET_RESTRICTIONS', participantId: bia!.participantId, value: 'NONE' },
    { op: 'SET_LIMIT', target: 'GROUP', value: { amountCents: 18000, kind: 'MANDATORY' } },
  ], ctx('evt-2')).state;
}

describe('limites monetários', () => {
  it('MoneyLimit exige centavos inteiros seguros >= 0 e kind rígido/flexível', () => {
    expect(MoneyLimitSchema.safeParse({ amountCents: 18000, kind: 'MANDATORY' }).success).toBe(true);
    for (const amountCents of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(MoneyLimitSchema.safeParse({ amountCents, kind: 'MANDATORY' }).success).toBe(false);
    }
    expect(MoneyLimitSchema.safeParse({ amountCents: 1, kind: 'TALVEZ' }).success).toBe(false);
  });
});

describe('criação e IDs', () => {
  it('cria compra ativa com IDs do servidor, determinísticos por escopo + evento + posição', () => {
    const r1 = applyPatch(null, [{ op: 'ADD_PARTICIPANT', displayName: 'Ana' }], ctx());
    const r2 = applyPatch(null, [{ op: 'ADD_PARTICIPANT', displayName: 'Ana' }], ctx());
    expect(r1).toEqual(r2);
    expect(r1.state).toMatchObject({ status: 'ACTIVE', version: 0, linkId: null, merchant: { state: 'NOT_ASKED' } });
    expect(r1.state.participants[0]!.participantId).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(r1.state.participants[0]!.origin).toEqual({ eventId: 'evt-1' });
    expect(r1.paths).toEqual(['PARTICIPANTS']);
    // Outro escopo ou outro evento ⇒ outros IDs (sem colisão entre organizadores).
    expect(applyPatch(null, [{ op: 'ADD_PARTICIPANT', displayName: 'Ana' }], ctx('evt-1', { seed: 'outro' })).state.purchaseId)
      .not.toBe(r1.state.purchaseId);
  });

  it('a semente do escopo não aparece no estado', () => {
    const s = applyPatch(null, [{ op: 'ADD_PARTICIPANT', displayName: 'Ana' }], ctx('evt-1', { seed: '111111111-segredo' })).state;
    expect(JSON.stringify(s)).not.toContain('111111111');
  });
});

describe('critérios da issue #13', () => {
  it('alterar R$ 180 para R$ 150 conserva participantes e restrições', () => {
    const before = seeded();
    const after = applyPatch(before, [{ op: 'SET_LIMIT', target: 'GROUP', value: { amountCents: 15000, kind: 'MANDATORY' } }], ctx('evt-3'));
    expect(after.paths).toEqual(['BUDGET']);
    expect(after.state.groupLimit).toMatchObject({ state: 'DECLARED', value: { amountCents: 15000 } });
    expect(after.state.participants).toEqual(before.participants);
  });

  it('patch é atômico: uma operação inválida rejeita tudo e não altera a entrada', () => {
    const before = seeded();
    const snapshot = JSON.stringify(before);
    const ops: DomainOp[] = [
      { op: 'SET_LIMIT', target: 'GROUP', value: { amountCents: 100, kind: 'MANDATORY' } },
      { op: 'RENAME_PARTICIPANT', participantId: 'id-inventado-pelo-modelo-x', displayName: 'X' },
    ];
    expect(code(() => applyPatch(before, ops, ctx('evt-3')))).toBe('PARTICIPANT_NOT_FOUND');
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it('estado pronto vindo de fora não é aceito: só operações tipadas', () => {
    const forged = { ...seeded(), participants: [] };
    expect(code(() => nextPurchase(seeded(), { ops: [], state: forged }, ctx()))).toBe('INVALID_PATCH');
    expect(code(() => applyPatch(seeded(), [{ op: 'REPLACE_STATE', state: forged }], ctx()))).toBe('INVALID_PATCH');
    expect(code(() => applyPatch(seeded(), [], ctx()))).toBe('INVALID_PATCH');
  });

  it('distingue não perguntado, ambíguo, "nenhuma" explícita e declarada', () => {
    const s = seeded();
    const [ana, bia] = s.participants;
    expect(ana!.restrictions.state).toBe('DECLARED');
    expect(bia!.restrictions.state).toBe('NONE');
    expect(ana!.limit.state).toBe('NOT_ASKED');
    const u = applyPatch(s, [{ op: 'MARK_UNCLEAR', target: ana!.participantId, field: 'LIMIT', question: 'Até quanto a Ana pode gastar?' }], ctx('evt-3')).state;
    expect(u.participants[0]!.limit.state).toBe('UNCLEAR');
    expect(u.clarifications).toHaveLength(1);
  });

  it('ambiguidade sobre restrições não apaga restrições já declaradas', () => {
    const s = seeded();
    const ana = s.participants[0]!;
    const u = applyPatch(s, [{ op: 'MARK_UNCLEAR', target: ana.participantId, field: 'RESTRICTIONS', question: 'Também evita castanhas?' }], ctx('evt-3')).state;
    expect(u.participants[0]!.restrictions).toMatchObject({ state: 'DECLARED' });
    expect(u.clarifications[0]!.field).toBe('RESTRICTIONS');
  });

  it('declarar o valor resolve o esclarecimento; RESOLVE sem valor volta a "não perguntado"', () => {
    const s = seeded();
    const ana = s.participants[0]!;
    const u = applyPatch(s, [{ op: 'MARK_UNCLEAR', target: ana.participantId, field: 'LIMIT', question: 'Quanto?' }], ctx('evt-3')).state;
    const set = applyPatch(u, [{ op: 'SET_LIMIT', target: ana.participantId, value: { amountCents: 5000, kind: 'PREFERENCE' } }], ctx('evt-4')).state;
    expect(set.clarifications).toEqual([]);
    const resolved = applyPatch(u, [{ op: 'RESOLVE_CLARIFICATION', clarificationId: u.clarifications[0]!.clarificationId }], ctx('evt-4')).state;
    expect(resolved.participants[0]!.limit).toEqual({ state: 'NOT_ASKED' });
  });
});

describe('restrições rígidas (D5)', () => {
  it('alergia nunca é preferência', () => {
    const s = seeded();
    const op = { op: 'ADD_RESTRICTION', participantId: s.participants[0]!.participantId, key: { kind: 'ALLERGY', code: 'MILK', requirement: 'PREFERENCE' } };
    expect(code(() => applyPatch(s, [op], ctx('evt-3')))).toBe('INVALID_PATCH');
  });

  it('remover restrição rígida exige confirmação humana explícita', () => {
    const s = seeded();
    const ana = s.participants[0]!;
    const peanut = ana.restrictions.state === 'DECLARED' ? ana.restrictions.value.find((r) => r.key.kind === 'ALLERGY')! : null;
    expect(code(() => applyPatch(s, [{ op: 'REMOVE_RESTRICTION', participantId: ana.participantId, restrictionId: peanut!.restrictionId }], ctx()))).toBe('INVALID_PATCH');
    expect(code(() => applyPatch(s, [{ op: 'SET_RESTRICTIONS', participantId: ana.participantId, value: 'NONE' }], ctx()))).toBe('REQUIRES_HUMAN_CONFIRMATION');
    expect(code(() => applyPatch(s, [{ op: 'SET_RESTRICTIONS', participantId: ana.participantId, value: [{ kind: 'DIETARY', code: 'VEGAN', requirement: 'PREFERENCE' }] }], ctx())))
      .toBe('REQUIRES_HUMAN_CONFIRMATION');
    const ok = applyPatch(s, [{ op: 'REMOVE_RESTRICTION', participantId: ana.participantId, restrictionId: peanut!.restrictionId, humanConfirmed: true }], ctx('evt-3')).state;
    expect(ok.participants[0]!.restrictions).toMatchObject({ state: 'DECLARED', value: [{ key: { kind: 'DIETARY', code: 'VEGAN' } }] });
  });

  it('preferência pode virar rígida; rígida não vira preferência sem confirmação', () => {
    const s = seeded();
    const ana = s.participants[0]!;
    const up = applyPatch(s, [{ op: 'ADD_RESTRICTION', participantId: ana.participantId, key: { kind: 'DIETARY', code: 'VEGAN', requirement: 'MANDATORY' } }], ctx('evt-3')).state;
    const vegan = up.participants[0]!.restrictions.state === 'DECLARED' ? up.participants[0]!.restrictions.value.find((r) => r.key.code === 'VEGAN')! : null;
    expect(vegan!.key.requirement).toBe('MANDATORY');
    expect(code(() => applyPatch(up, [{ op: 'ADD_RESTRICTION', participantId: ana.participantId, key: { kind: 'DIETARY', code: 'VEGAN', requirement: 'PREFERENCE' } }], ctx('evt-4'))))
      .toBe('REQUIRES_HUMAN_CONFIRMATION');
  });

  it('SET_RESTRICTIONS mantém o ID das restrições que continuam e rejeita duplicatas', () => {
    const s = seeded();
    const ana = s.participants[0]!;
    const before = ana.restrictions.state === 'DECLARED' ? ana.restrictions.value : [];
    const r = applyPatch(s, [{ op: 'SET_RESTRICTIONS', participantId: ana.participantId, value: before.map((x) => x.key) }], ctx('evt-3')).state;
    expect(r.participants[0]!.restrictions.state === 'DECLARED' && r.participants[0]!.restrictions.value.map((x) => x.restrictionId))
      .toEqual(before.map((x) => x.restrictionId));
    expect(code(() => applyPatch(s, [{ op: 'SET_RESTRICTIONS', participantId: ana.participantId, value: [{ kind: 'ALLERGY', code: 'EGG' }, { kind: 'ALLERGY', code: 'EGG' }] }], ctx())))
      .toBe('INVALID_PATCH');
  });
});

describe('limites e validação', () => {
  it('máximo de participantes configurável (padrão 20, teto 100)', () => {
    const add = (n: number): DomainOp[] => Array.from({ length: n }, (_, i) => ({ op: 'ADD_PARTICIPANT', displayName: `P${i}` }));
    expect(applyPatch(null, add(20), ctx()).state.participants).toHaveLength(20);
    expect(code(() => applyPatch(null, add(21), ctx()))).toBe('PARTICIPANT_LIMIT');
    expect(code(() => applyPatch(null, add(3), ctx('e', { maxParticipants: 2 })))).toBe('PARTICIPANT_LIMIT');
    const big = applyPatch(null, add(50), ctx('e', { maxParticipants: 500 })).state;
    expect(big.participants).toHaveLength(50);
  });

  it('valores monetários precisam ser centavos inteiros; textos têm limite e sem caracteres de controle', () => {
    const s = seeded();
    for (const amountCents of [-1, 10.5, 1e20]) {
      expect(code(() => applyPatch(s, [{ op: 'SET_LIMIT', target: 'GROUP', value: { amountCents, kind: 'MANDATORY' } }], ctx()))).toBe('INVALID_PATCH');
    }
    expect(code(() => applyPatch(s, [{ op: 'ADD_PARTICIPANT', displayName: 'x'.repeat(81) }], ctx()))).toBe('INVALID_PATCH');
    expect(code(() => applyPatch(s, [{ op: 'ADD_PARTICIPANT', displayName: 'a\u0007b' }], ctx()))).toBe('INVALID_PATCH');
    expect(code(() => applyPatch(s, [{ op: 'SET_MERCHANT', merchantId: '../etc' }], ctx()))).toBe('INVALID_PATCH');
  });

  it('erro de domínio não carrega dados pessoais', () => {
    const s = seeded();
    try {
      applyPatch(s, [{ op: 'RENAME_PARTICIPANT', participantId: 'id-inexistente-000000000', displayName: 'Nome Pessoal' }], ctx());
    } catch (e) {
      expect((e as Error).message).toBe('PARTICIPANT_NOT_FOUND (op 0)');
    }
  });

  it('remover participante remove seus esclarecimentos', () => {
    const s = seeded();
    const ana = s.participants[0]!;
    const u = applyPatch(s, [{ op: 'MARK_UNCLEAR', target: ana.participantId, field: 'LIMIT', question: '?' }], ctx('evt-3')).state;
    const r = applyPatch(u, [{ op: 'REMOVE_PARTICIPANT', participantId: ana.participantId, humanConfirmed: true }], ctx('evt-4')).state;
    expect(r.participants).toHaveLength(1);
    expect(r.clarifications).toEqual([]);
  });
});

describe('encerramento', () => {
  it('END encerra; nada depois no mesmo patch; compra encerrada não aceita patch', () => {
    const s = seeded();
    expect(code(() => applyPatch(s, [{ op: 'END', reason: 'CLOSED' }, { op: 'SET_PRIORITY', value: 'SPEED' }], ctx()))).toBe('PURCHASE_NOT_ACTIVE');
    const closed = applyPatch(s, [{ op: 'END', reason: 'CANCELLED' }], ctx('evt-3'));
    expect(closed.state.status).toBe('CANCELLED');
    expect(closed.paths).toEqual(['PHASE']);
    expect(code(() => applyPatch(closed.state, [{ op: 'SET_PRIORITY', value: 'SPEED' }], ctx('evt-4')))).toBe('PURCHASE_NOT_ACTIVE');
  });
});

describe('troca de conta', () => {
  it('primeira associação invalida loja/endereço definidos sem vínculo; troca limpa e preserva participantes, restrições e limites', () => {
    const unlinked = applyPatch(seeded(), [{ op: 'SET_MERCHANT', merchantId: 'merchant-uuid-1' }], ctx('evt-3')).state;
    const linked = applyLinkChange(unlinked, 'link-A')!;
    expect(linked).toMatchObject({ event: 'ASSOCIATED', paths: ['PROPOSALS'], state: { linkId: 'link-A', merchant: { state: 'NOT_ASKED' } } });
    expect(applyLinkChange(linked.state, 'link-A')).toBeNull();
    const clean = applyLinkChange(seeded(), 'link-A')!;
    expect(clean).toMatchObject({ event: 'ASSOCIATED', paths: [] }); // nada dependente ⇒ só registra
    const s = applyPatch(clean.state, [{ op: 'SET_MERCHANT', merchantId: 'merchant-uuid-1' }, { op: 'SET_ADDRESS', addressId: 'addr-test-1' }], ctx('evt-4')).state;
    const switched = applyLinkChange(s, 'link-B')!;
    expect(switched).toMatchObject({ event: 'CHANGED', paths: ['PROPOSALS'] });
    expect(switched.state).toMatchObject({ linkId: 'link-B', merchant: { state: 'NOT_ASKED' }, address: { state: 'NOT_ASKED' } });
    expect(switched.state.participants).toEqual(s.participants);
    expect(switched.state.groupLimit).toEqual(s.groupLimit);
  });

  it('nextPurchase: compra nova sob o vínculo mantém o que o turno definiu; troca posterior invalida antes do patch', () => {
    const created = nextPurchase(null, { ops: [{ op: 'ADD_PARTICIPANT', displayName: 'Ana' }, { op: 'SET_MERCHANT', merchantId: 'm-1' }], linkId: 'link-A' }, ctx());
    expect(created).toMatchObject({ linkEvent: 'ASSOCIATED', state: { linkId: 'link-A', merchant: { state: 'DECLARED' } } });
    const r = nextPurchase(created.state, { ops: [{ op: 'SET_PRIORITY', value: 'ECONOMY' }], linkId: 'link-B' }, ctx('evt-3'));
    expect(r.linkEvent).toBe('CHANGED');
    expect(r.paths.sort()).toEqual(['PROPOSALS']);
    expect(r.state).toMatchObject({ linkId: 'link-B', merchant: { state: 'NOT_ASKED' }, priority: { state: 'DECLARED', value: 'ECONOMY' } });
    expect(nextPurchase(r.state, { ops: [], linkId: 'link-B' }, ctx('evt-4')).linkEvent).toBeNull();
  });
});

describe('regressões da auditoria', () => {
  it('bug 1: remover participante com restrição obrigatória exige confirmação; remover+recriar não apaga alergia', () => {
    const s = seeded();
    const [ana, bia] = s.participants;
    expect(code(() => applyPatch(s, [{ op: 'REMOVE_PARTICIPANT', participantId: ana!.participantId }, { op: 'ADD_PARTICIPANT', displayName: 'Ana' }], ctx('evt-3'))))
      .toBe('REQUIRES_HUMAN_CONFIRMATION');
    expect(applyPatch(s, [{ op: 'REMOVE_PARTICIPANT', participantId: bia!.participantId }], ctx('evt-3')).state.participants).toHaveLength(1); // sem restrição rígida
    expect(applyPatch(s, [{ op: 'REMOVE_PARTICIPANT', participantId: ana!.participantId, humanConfirmed: true }], ctx('evt-3')).state.participants).toHaveLength(1);
  });

  it('bug 1 (teto): tirar ou rebaixar teto MANDATORY exige confirmação; mudar o valor não', () => {
    const s = seeded();
    expect(code(() => applyPatch(s, [{ op: 'SET_LIMIT', target: 'GROUP', value: 'NONE' }], ctx()))).toBe('REQUIRES_HUMAN_CONFIRMATION');
    expect(code(() => applyPatch(s, [{ op: 'SET_LIMIT', target: 'GROUP', value: { amountCents: 18000, kind: 'PREFERENCE' } }], ctx()))).toBe('REQUIRES_HUMAN_CONFIRMATION');
    expect(applyPatch(s, [{ op: 'SET_LIMIT', target: 'GROUP', value: { amountCents: 20000, kind: 'MANDATORY' } }], ctx()).state.groupLimit)
      .toMatchObject({ state: 'DECLARED', value: { amountCents: 20000, kind: 'MANDATORY' } });
    expect(applyPatch(s, [{ op: 'SET_LIMIT', target: 'GROUP', value: 'NONE', humanConfirmed: true }], ctx()).state.groupLimit.state).toBe('NONE');
  });

  it('bug 2: ambiguidade preserva teto rígido declarado; RESOLVE não o transforma em "não perguntado"', () => {
    const s = seeded();
    const u = applyPatch(s, [{ op: 'MARK_UNCLEAR', target: 'GROUP', field: 'LIMIT', question: 'Subir para R$ 200?' }], ctx('evt-3')).state;
    expect(u.groupLimit).toEqual(s.groupLimit);
    expect(u.clarifications).toHaveLength(1);
    const r = applyPatch(u, [{ op: 'RESOLVE_CLARIFICATION', clarificationId: u.clarifications[0]!.clarificationId }], ctx('evt-4')).state;
    expect(r.groupLimit).toEqual(s.groupLimit);
    expect(r.clarifications).toEqual([]);
  });

  it('bug 2: "nenhuma restrição" + ambiguidade vira pergunta pendente (lado seguro); loja declarada é preservada', () => {
    const s = applyPatch(seeded(), [{ op: 'SET_MERCHANT', merchantId: 'm-1' }], ctx('evt-3')).state;
    const bia = s.participants[1]!;
    const u = applyPatch(s, [
      { op: 'MARK_UNCLEAR', target: bia.participantId, field: 'RESTRICTIONS', question: 'Ela evita lactose?' },
      { op: 'MARK_UNCLEAR', target: 'PURCHASE', field: 'MERCHANT', question: 'Trocar de loja?' },
    ], ctx('evt-4')).state;
    expect(u.participants[1]!.restrictions.state).toBe('UNCLEAR');
    expect(u.merchant).toMatchObject({ state: 'DECLARED', value: { merchantId: 'm-1' } });
  });

  it('bug 8: END sem compra ativa é recusado, inclusive criar e encerrar no mesmo patch', () => {
    expect(code(() => applyPatch(null, [{ op: 'END', reason: 'CLOSED' }], ctx()))).toBe('PURCHASE_NOT_ACTIVE');
    expect(code(() => applyPatch(null, [{ op: 'ADD_PARTICIPANT', displayName: 'Ana' }, { op: 'END', reason: 'CANCELLED' }], ctx()))).toBe('PURCHASE_NOT_ACTIVE');
    expect(code(() => nextPurchase(null, { ops: [{ op: 'END', reason: 'CLOSED' }] }, ctx()))).toBe('PURCHASE_NOT_ACTIVE');
  });
});

describe('evidência de restaurante (D6)', () => {
  it('nenhum canal é verificado: declaração do modelo/organizador nunca vira evidência', () => {
    const s = seeded();
    for (const channel of ['MODEL', 'ORGANIZER', 'TELEFONE', 'RESTAURANT_VERIFIED']) {
      expect(code(() => recordEvidence(s, { merchantId: 'm', itemId: 'i', optionIds: [], restriction: { kind: 'ALLERGY', code: 'PEANUT' },
        result: 'SAFE', channel, obtainedAt: 0, expiresAt: 1 }))).toBe('EVIDENCE_SOURCE_UNVERIFIED');
    }
    const forged = { ...s, evidence: [{ evidenceId: 'e'.repeat(24), merchantId: 'm', itemId: 'i', optionIds: [], restriction: { kind: 'ALLERGY', code: 'PEANUT' },
      result: 'SAFE', channel: 'MODEL', obtainedAt: 0, expiresAt: 1 }] };
    expect(code(() => parsePurchaseState(forged))).toBe('INVALID_STATE');
  });

  it('busca exige a mesma combinação válida: outro item, variante ou confirmação vencida não libera (CA07)', () => {
    const base = emptyPurchase(ctx());
    const ev = { evidenceId: 'e'.repeat(24), merchantId: 'm', itemId: 'i', optionIds: ['o2', 'o1'], restriction: { kind: 'ALLERGY' as const, code: 'PEANUT' as const },
      result: 'SAFE' as const, channel: 'hipotetico', obtainedAt: 100, expiresAt: 200 };
    const s = { ...base, evidence: [ev] } as PurchaseState; // estado montado à mão só para exercitar a busca
    const q = { merchantId: 'm', itemId: 'i', optionIds: ['o1', 'o2'], restriction: { kind: 'ALLERGY' as const, code: 'PEANUT' as const }, now: 150 };
    expect(findEvidence(s, q)).toBe(ev);
    expect(findEvidence(s, { ...q, itemId: 'outro' })).toBeNull();
    expect(findEvidence(s, { ...q, optionIds: ['o1'] })).toBeNull();
    expect(findEvidence(s, { ...q, restriction: { kind: 'ALLERGY', code: 'MILK' } })).toBeNull();
    expect(findEvidence(s, { ...q, now: 200 })).toBeNull();
  });
});
