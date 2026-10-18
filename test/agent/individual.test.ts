// Uso individual ou em grupo: perguntar antes, sem assumir grupo (decisão de produto, 18/10/2026).
import { describe, expect, it } from 'vitest';
import { shortReply } from '../../src/server/agent/short-reply';
import { NO_PARTICIPANTS_QUESTION, missingQuestions } from '../../src/server/agent/policy';
import { MODEL_PROMPT } from '../../src/server/agent/gemini-model';
import { renderSnapshot } from '../../src/server/agent/render';
import { applyPatch } from '../../src/server/domain/purchase';
import type { Snapshot } from '../../src/server/contracts/conversation';

const base: Snapshot = { contractVersion: '1.0', conversationId: '1', version: 0, phase: 'COLLECTING',
  blocks: [], pending: [], allowedActions: [], humanApproval: null };

describe('início da conversa: individual ou grupo', () => {
  it('sem participantes pergunta se é só para a pessoa ou para um grupo', () => {
    expect(missingQuestions(null)).toEqual([NO_PARTICIPANTS_QUESTION]);
    expect(NO_PARTICIPANTS_QUESTION).toMatch(/só para você ou para um grupo/);
  });

  it.each(['É um pedido individual, só para mim.', 'e um pedido individual, so para mim'])(
    'botão individual (%j) cria uma única pessoa "Você" sem modelo', (text) => {
      expect(shortReply(null, base, text)?.proposal.actions).toEqual([{ action: 'ADD_PARTICIPANT', name: 'Você' }]);
    });

  it('botão de grupo não cria ninguém; o servidor pergunta quem participa', () => {
    expect(shortReply(null, base, 'É um pedido em grupo.')?.proposal.actions).toEqual([]);
  });

  it('com participantes já registrados, as frases dos botões não alteram o estado deterministicamente', () => {
    const state = applyPatch(null, [{ op: 'ADD_PARTICIPANT', displayName: 'Ana' }], { seed: 'i', eventId: 'e1' }).state;
    const snapshot = renderSnapshot(base, state, [], missingQuestions(state));
    expect(shortReply(state, snapshot, 'É um pedido individual, só para mim.')).toBeNull();
    expect(shortReply(state, snapshot, 'É um pedido em grupo.')).toBeNull();
  });

  it('com uma pessoa, perguntas e orçamento não falam em grupo', () => {
    let state = applyPatch(null, [{ op: 'ADD_PARTICIPANT', displayName: 'Você' }], { seed: 'i', eventId: 'e1' }).state;
    expect(missingQuestions(state)).toEqual(['Você tem alguma alergia ou restrição alimentar?', 'Qual é o seu orçamento?', 'Você prefere economia ou rapidez?']);
    state = applyPatch(state, [{ op: 'SET_LIMIT', target: 'GROUP', value: { amountCents: 5000, kind: 'MANDATORY' } }], { seed: 'i', eventId: 'e2' }).state;
    const texts = renderSnapshot(base, state, [], missingQuestions(state)).blocks.flatMap(b => b.kind === 'TEXT' ? [b.text] : []);
    expect(texts.some(t => t.startsWith('Orçamento: R$'))).toBe(true);
    expect(texts.join(' ')).not.toMatch(/grupo/i);
  });

  it('com duas pessoas, mantém as perguntas de grupo', () => {
    const state = applyPatch(null, [{ op: 'ADD_PARTICIPANT', displayName: 'Ana' }, { op: 'ADD_PARTICIPANT', displayName: 'Bia' }], { seed: 'i', eventId: 'e1' }).state;
    expect(missingQuestions(state)).toContain('Qual é o orçamento do grupo?');
    expect(missingQuestions(state)).toContain('Vocês preferem economia ou rapidez?');
  });

  it('prompt do modelo não assume grupo e mapeia pedido individual', () => {
    expect(MODEL_PROMPT).toMatch(/individual ou em grupo/);
    expect(MODEL_PROMPT).toMatch(/Nunca suponha grupo/);
  });
});
