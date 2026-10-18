import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ApprovalSchema, EventSchema, OperationSchema, SnapshotSchema, contractSchemas, toModelContext,
  type Operation, type Snapshot,
} from '../../src/server/contracts/conversation';
import {
  assertAction, assertApproval, assertOperation, assertSnapshot, contentHash, eventKey,
  type ApprovalBinding,
} from '../../src/server/contracts/guards';
import { contractErrorResponse } from '../../src/server/contracts/errors';
import { mockApi, principal, store, token } from './mock-api';

interface Example { name: string; schema: keyof typeof contractSchemas; valid: boolean; value: unknown }
const examples: Example[] = JSON.parse(readFileSync('contracts/conversation/v1/examples.json', 'utf8'));
const example = (name: string) => structuredClone(examples.find((e) => e.name === name)!.value);
const event = () => EventSchema.parse(example('evento de texto'));
const now = Date.parse('2026-10-18T04:00:30Z');
const owner = { ...principal, version: 1 };
const headers = { authorization: `Bearer ${token}`, 'x-telegram-user-id': principal.organizerId,
  'x-telegram-chat-id': principal.conversationId, 'content-type': 'application/json' };
const post = (body: unknown, over: Record<string, string> = {}) => ({ method: 'POST', headers: { ...headers, ...over }, body: JSON.stringify(body) });
const path = `/api/bot/v1/conversations/${principal.conversationId}/events`;

describe('schemas compartilhados', () => {
  it.each(examples)('$name', ({ schema, value, valid }) => {
    expect(contractSchemas[schema].safeParse(value).success).toBe(valid);
  });
  it.each(Object.entries(contractSchemas))('JSON Schema %s está atualizado', (name, schema) => {
    expect(JSON.parse(readFileSync(`contracts/conversation/v1/${name}.schema.json`, 'utf8')))
      .toEqual(z.toJSONSchema(schema, { target: 'draft-2020-12' }));
  });
  it.each(examples.filter((e) => e.valid && e.schema === 'operation'))('semântica: $name', ({ value }) => {
    assertOperation(OperationSchema.parse(value), now);
  });
});

describe('mock HTTP do contrato (sem rotas em produção)', () => {
  it('aceita, perde resposta e recupera mesma operação após recriar mock, sem duplicar origem', async () => {
    const db = store();
    const request = event();
    const accepted = await mockApi(db).request(path, post(request));
    expect(accepted.status).toBe(202);
    const first = await accepted.json();
    const entry = [...db.events.values()][0]!;
    // Simula commit atômico DATA-01/RUN-01. O mock não promete durabilidade em disco.
    entry.operation = OperationSchema.parse(example('operação concluída com proveniência'));
    entry.operation.operationId = first.operationId;
    db.version = 1;
    const replay = await mockApi(db).request(path, post(request));
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(entry.operation);
    expect(db.events.size).toBe(1);
    expect(entry.operation.changes).toHaveLength(1);
    expect(entry.operation.changes[0]!.source).toEqual(request.source);
    expect(JSON.stringify(entry.operation.changes)).not.toContain('Agora temos');
  });
  it('mesma chave com conteúdo diferente conflita; mensagens iguais com novos IDs são legítimas', async () => {
    const db = store(); const api = mockApi(db); const original = event();
    await api.request(path, post(original));
    const conflict = await api.request(path, post({ ...original, input: { kind: 'TEXT', text: 'outro texto' } }));
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).error.code).toBe('EVENT_CONFLICT');
    expect((await api.request(path, post({ ...original, source: { ...original.source, messageId: '31' } }))).status).toBe(409);
    expect((await api.request(path, post({ ...original, eventId: 'tg-update-600' }))).status).toBe(202);
    expect(db.events.size).toBe(2);
  });
  it('requisições concorrentes do mesmo evento convergem', async () => {
    const db = store(); const api = mockApi(db);
    const results = await Promise.all(Array.from({ length: 5 }, () => api.request(path, post(event()))));
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 202]);
    expect(db.events.size).toBe(1);
  });
  it('versão antiga não sobrescreve estado', async () => {
    const db = store(); db.version = 2;
    const response = await mockApi(db).request(path, post(event()));
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe('STALE_VERSION');
    expect(db.version).toBe(2); expect(db.events.size).toBe(0);
  });
  it.each([
    ['sem Bearer', { authorization: '' }, 401],
    ['identidade não permitida', { 'x-telegram-user-id': '333333333' }, 403],
    ['outro organizador', { 'x-telegram-user-id': '222222222', 'x-telegram-chat-id': '222222222' }, 404],
    ['conversa adulterada', { 'x-telegram-chat-id': '222222222' }, 404],
  ] as const)('%s', async (_name, extra, status) => {
    const db = store(); const response = await mockApi(db).request(path, post(event(), extra));
    expect(response.status).toBe(status); expect(db.events.size).toBe(0);
  });
  it.each(['botId', 'conversationId'] as const)('origem de outro %s é rejeitada', async (field) => {
    const original = event();
    const r = await mockApi(store()).request(path, post({ ...original, source: { ...original.source, [field]: '999999999' } }));
    expect(r.status).toBe(400); expect((await r.json()).error.code).toBe('INVALID_SOURCE');
  });
  it('versão não suportada e JSON inválido falham de forma segura', async () => {
    const api = mockApi(store());
    const version = await api.request(path, post({ ...event(), contractVersion: '0' }));
    expect((await version.json()).error.code).toBe('UNSUPPORTED_VERSION');
    const invalid = await api.request(path, { method: 'POST', headers, body: '{' });
    expect(invalid.status).toBe(400); expect((await invalid.json()).error.code).toBe('INVALID_REQUEST');
  });
});

describe('referências, aprovação e contexto do modelo', () => {
  const binding = (): ApprovalBinding => ({
    ...principal, linkId: 'link-test', expectedVersion: 1, expiresAt: '2026-10-18T04:04:00Z', consumed: false,
    reviewRef: 'review_test_000001', approvalRef: 'approval_test_0001', fingerprint: 'fp-test', totalCents: 15000,
  });
  const review = { linkId: 'link-test', fingerprint: 'fp-test', totalCents: 15000 };
  it('pré-valida callback humano; não consome nem envia compra', () => {
    const b = binding();
    assertApproval(ApprovalSchema.parse(example('aprovação em canal humano')), principal, owner, b, review, now);
    expect(b.consumed).toBe(false);
  });
  it.each([
    ['consumida', { consumed: true }, 'ACTION_UNAVAILABLE'],
    ['expirada', { expiresAt: '2026-10-18T04:00:00Z' }, 'REFERENCE_EXPIRED'],
    ['validade corrompida', { expiresAt: 'invalid' }, 'REFERENCE_EXPIRED'],
    ['outra conta', { linkId: 'other-link' }, 'LINK_CHANGED'],
    ['outro organizador', { organizerId: '222222222' }, 'NOT_FOUND'],
    ['outro bot', { botId: '900002' }, 'NOT_FOUND'],
    ['outra conversa', { conversationId: '222222222' }, 'NOT_FOUND'],
    ['outro total', { totalCents: 14999 }, 'STALE_VERSION'],
    ['outro conteúdo', { fingerprint: 'different' }, 'STALE_VERSION'],
    ['versão antiga', { expectedVersion: 0 }, 'STALE_VERSION'],
  ] as const)('aprovação %s', (_name, patch, code) => {
    expect(() => assertApproval(ApprovalSchema.parse(example('aprovação em canal humano')), principal, owner, { ...binding(), ...patch }, review, now)).toThrow(code);
  });
  it('mensagem textual não é callback de aprovação', () => {
    const request = ApprovalSchema.parse(example('aprovação em canal humano'));
    expect(() => assertApproval({ ...request, source: event().source }, principal, owner, binding(), review, now)).toThrow('ACTION_UNAVAILABLE');
  });
  it('ação exige referência emitida no escopo e na versão atual', () => {
    const request = EventSchema.parse(example('evento de botão'));
    const action = { ...binding(), kind: 'REQUEST_REVIEW', actionRef: 'action_test_000001' };
    assertAction(request, principal, owner, action, 'link-test', now);
    expect(() => assertAction(request, principal, owner, { ...action, actionRef: 'action_other_00001' }, 'link-test', now)).toThrow('ACTION_UNAVAILABLE');
  });
  it('contexto do modelo usa projeção explícita, sem referências humanas ou texto de apresentação', () => {
    const snapshot = SnapshotSchema.parse(example('revisão humana sintética'));
    const model = toModelContext(snapshot);
    expect(model).not.toHaveProperty('humanApproval');
    expect(model).not.toHaveProperty('blocks');
    expect(JSON.stringify(model)).not.toContain(snapshot.humanApproval!.approvalRef);
    expect(JSON.stringify(model)).not.toContain(snapshot.humanApproval!.reviewRef);
  });
  it('hash ignora ordem de chaves, mas conserva texto e origem; chave inclui identidade e escopo', () => {
    expect(contentHash({ z: 1, a: { b: 2, a: 1 } })).toBe(contentHash({ a: { a: 1, b: 2 }, z: 1 }));
    expect(contentHash(event())).not.toBe(contentHash({ ...event(), expectedVersion: 1 }));
    expect(eventKey(principal, 'event-a')).not.toBe(eventKey({ ...principal, botId: '900002' }, 'event-a'));
  });
});

describe('invariantes de respostas e proveniência', () => {
  const review = () => SnapshotSchema.parse(example('revisão humana sintética'));
  const complete = () => OperationSchema.parse(example('operação concluída com proveniência'));
  it.each([
    ['total divergente', (s: Snapshot) => { if (s.blocks[0]!.kind === 'REVIEW' && s.blocks[0]!.price.kind === 'CONFIRMED') s.blocks[0]!.price.totalCents++; }],
    ['cobertura bloqueada', (s: Snapshot) => { if (s.blocks[0]!.kind === 'REVIEW') s.blocks[0]!.coverage[0]!.status = 'NEEDS_VERIFICATION'; }],
    ['cotação vencida', (s: Snapshot) => { if (s.blocks[0]!.kind === 'REVIEW' && s.blocks[0]!.price.kind === 'CONFIRMED') s.blocks[0]!.price.expiresAt = '2026-10-18T04:00:00Z'; }],
    ['resultado desconhecido com botão', (s: Snapshot) => { s.phase = 'RESULT_UNKNOWN'; }],
  ])('%s impede resposta apta à aprovação', (_name, change) => {
    const s = review(); change(s); expect(() => assertSnapshot(s, now)).toThrow();
  });
  it.each([
    ['outro evento', (o: Operation) => { o.changes[0]!.eventId = 'other-event'; }],
    ['origem de outra conversa', (o: Operation) => { o.changes[0]!.source.conversationId = '222222222'; }],
    ['versão derivada incorreta', (o: Operation) => { o.changes[0]!.resultVersion = 2; }],
    ['snapshot atrasado', (o: Operation) => { o.snapshot!.version = 0; }],
    ['poll de sucesso', (o: Operation) => { o.pollAfterMs = 1000; }],
  ])('%s não passa no contrato', (_name, change) => {
    const o = complete(); change(o); expect(() => assertOperation(o, now)).toThrow();
  });
  it('erro interno vem de mensagem fixa, sem vazamento de erros externos', () => {
    expect(contractErrorResponse('INTERNAL').body).toEqual({ contractVersion: '1.0', error: {
      code: 'INTERNAL', message: 'Não foi possível concluir o processamento.', recovery: 'POLL_OPERATION',
    } });
  });
});
