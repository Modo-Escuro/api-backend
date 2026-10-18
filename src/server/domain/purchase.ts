// DATA-01: estado da compra simulada (participantes, restrições, limites, evidências) e patches validados.
// Função pura: sem I/O, sem relógio, sem aleatoriedade. IDs são derivados de (escopo, eventId, posição da operação),
// então o processador pode pré-visualizar exatamente o estado que o armazenamento vai recalcular e gravar.
//
// Regras (DEC-01 D1, D2, D5, D6, D7 e issue #13):
//  - O estado nunca é substituído por JSON externo: só muda por operações tipadas, aplicadas sobre a versão atual.
//  - Um patch é atômico: qualquer operação inválida rejeita o patch inteiro (DomainError) sem estado parcial.
//  - IDs de participante/restrição/esclarecimento são do servidor; ID desconhecido é rejeitado (nunca inventado).
//  - Desconhecido/ambíguo (UNCLEAR), "nenhum" explícito (NONE), não perguntado (NOT_ASKED) e declarado são distintos.
//  - Alergia é sempre MANDATORY. Enfraquecer algo rígido exige confirmação humana explícita (D5.6): remover/rebaixar
//    restrição obrigatória, remover participante que tem restrição obrigatória e tirar/rebaixar teto MANDATORY.
//  - Ambiguidade nunca apaga valor declarado: o valor continua valendo e a pergunta fica pendente.
//  - Evidência de restaurante só de canal verificado; nenhum canal existe na demo (D6) ⇒ sempre rejeitada.
//  - merchantId/addressId devem vir de respostas MCP; o processador valida a origem antes de propor a operação.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ALLERGENS, DIETARY, type RestrictionKey } from './constraints.js';
import type { Cents } from './money.js';

// Tipos de limite da DATA-01 sobre o `Cents` da DOM-01 (domain/money.ts, fonte única dos tipos monetários).
/** Centavos BRL: inteiro seguro >= 0 (mesma regra de `cents()` da DOM-01). */
export const CentsSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
/** DEC-01 D5: limite rígido (bloqueia) × flexível (só ranking/explicação). */
export const LimitKindSchema = z.enum(['MANDATORY', 'PREFERENCE']);
export type LimitKind = z.infer<typeof LimitKindSchema>;
export const MoneyLimitSchema = z.object({ amountCents: CentsSchema, kind: LimitKindSchema }).strict();
export interface MoneyLimit { amountCents: Cents; kind: LimitKind }

export const DEFAULT_MAX_PARTICIPANTS = 20;
/** Teto absoluto do contrato API-01 (GROUP.participants). */
export const CONTRACT_MAX_PARTICIPANTS = 100;
export const MAX_OPS_PER_PATCH = 50;
export const MAX_CLARIFICATIONS = 30;
export const MAX_RESTRICTIONS_PER_PARTICIPANT = 20;

const serverId = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/);
const eventId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
/** IDs vindos de respostas MCP (UUIDs ou equivalentes); sem espaços nem separadores de caminho. */
const providerId = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
/** Texto curto sem caracteres de controle; tamanho em code points (mesma fronteira do contrato). */
// Sem controle (Cc) nem formatação invisível (Cf: zero-width, bidi override) e sem surrogate isolado:
// nomes visualmente iguais não viram pessoas diferentes e nada invisível chega ao Telegram.
const shortText = (max: number) =>
  z.string().trim().min(1).regex(new RegExp(`^[^\\p{Cc}\\p{Cf}\\p{Cs}]{1,${max}}$`, 'u'));

export const OriginSchema = z.object({ eventId }).strict();
export type Origin = z.infer<typeof OriginSchema>;

export const RestrictionKeySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('DIETARY'), code: z.enum(DIETARY), requirement: z.enum(['MANDATORY', 'PREFERENCE']).optional() }).strict(),
  z.object({ kind: z.literal('ALLERGY'), code: z.enum(ALLERGENS), requirement: z.literal('MANDATORY').optional() }).strict(),
]);

export const RestrictionSchema = z.object({ restrictionId: serverId, key: RestrictionKeySchema, origin: OriginSchema }).strict();
export type Restriction = z.infer<typeof RestrictionSchema>;

const declared = <T extends z.ZodType>(value: T) =>
  z.discriminatedUnion('state', [
    z.object({ state: z.literal('NOT_ASKED') }).strict(),
    z.object({ state: z.literal('UNCLEAR'), clarificationId: serverId, origin: OriginSchema }).strict(),
    z.object({ state: z.literal('NONE'), origin: OriginSchema }).strict(),
    z.object({ state: z.literal('DECLARED'), value, origin: OriginSchema }).strict(),
  ]);
export type Declared<T> =
  | { state: 'NOT_ASKED' }
  | { state: 'UNCLEAR'; clarificationId: string; origin: Origin }
  | { state: 'NONE'; origin: Origin }
  | { state: 'DECLARED'; value: T; origin: Origin };

export const ParticipantSchema = z.object({
  participantId: serverId,
  displayName: shortText(80),
  restrictions: declared(z.array(RestrictionSchema).max(MAX_RESTRICTIONS_PER_PARTICIPANT)),
  limit: declared(MoneyLimitSchema),
  origin: OriginSchema,
}).strict();
export type Participant = z.infer<typeof ParticipantSchema>;

export const ClarificationFieldSchema = z.enum(['RESTRICTIONS', 'LIMIT', 'PRIORITY', 'MERCHANT', 'ADDRESS']);
export type ClarificationField = z.infer<typeof ClarificationFieldSchema>;
/** participantId, GROUP (teto coletivo) ou PURCHASE (prioridade/loja/endereço). */
const target = z.union([serverId, z.literal('GROUP'), z.literal('PURCHASE')]);

export const ClarificationSchema = z.object({
  clarificationId: serverId, target, field: ClarificationFieldSchema, question: shortText(300), origin: OriginSchema,
}).strict();
export type Clarification = z.infer<typeof ClarificationSchema>;

/** Canais de confirmação de restaurante aprovados. Vazio por decisão (DEC-01 D6): nenhum existe na demo. */
export const VERIFIED_EVIDENCE_CHANNELS: readonly string[] = [];
export const EvidenceSchema = z.object({
  evidenceId: serverId, merchantId: providerId, itemId: providerId, optionIds: z.array(providerId).max(50),
  restriction: RestrictionKeySchema, result: z.enum(['SAFE', 'UNSAFE']),
  channel: z.string().refine((c) => VERIFIED_EVIDENCE_CHANNELS.includes(c), 'canal não verificado'),
  obtainedAt: z.number().int(), expiresAt: z.number().int(),
}).strict();
export type Evidence = z.infer<typeof EvidenceSchema>;

export const PurchaseStatusSchema = z.enum(['ACTIVE', 'CLOSED', 'CANCELLED']);

// ---------------- GRP-01: propostas e sacola simulada ----------------
// Gerados por código do servidor a partir de respostas MCP de leitura (searchOffers/getItem); o modelo nunca fornece
// IDs, preços ou consumidores. Preço por unidade guarda a faixa observada: min = max quando exato; max null = sem teto
// conhecido. Nada aqui é carrinho real (DEC-01 D8).
export const MAX_PROPOSALS = 4;
export const PlanLineSchema = z.object({
  lineId: serverId,
  itemId: providerId,
  name: shortText(200),
  optionIds: z.array(providerId).max(50),
  quantity: z.number().int().min(1).max(99),
  consumerIds: z.array(serverId).min(1).max(CONTRACT_MAX_PARTICIPANTS),
  unitMinCents: CentsSchema,
  unitMaxCents: CentsSchema.nullable(),
}).strict();
export type PlanLine = z.infer<typeof PlanLineSchema>;
export const ProposalSchema = z.object({
  proposalId: serverId,
  merchantId: providerId,
  lines: z.array(PlanLineSchema).min(1).max(CONTRACT_MAX_PARTICIPANTS),
  /** null = taxa de entrega não observada (nunca vira zero). */
  deliveryFeeCents: CentsSchema.nullable(),
  minimumOrderCents: CentsSchema.nullable(),
  /** Cobertura por pessoa no momento da composição (preserva o motivo: dado insuficiente ≠ incompatível). */
  coverage: z.array(z.object({
    participantId: serverId,
    status: z.enum(['COVERED', 'BLOCKED', 'NEEDS_VERIFICATION']),
    reason: z.string().regex(/^[A-Z_]{1,40}$/).nullable(),
    /** Assinatura das restrições usadas na composição; mudou ⇒ cobertura deixa de valer. */
    restrictionsSig: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/).optional(),
  }).strict()).max(CONTRACT_MAX_PARTICIPANTS).optional(),
  /** Endereço usado na leitura MCP (proveniência). */
  addressId: providerId.nullable().optional(),
  /** Observações divergentes do MCP para a mesma loja (incerteza explícita, nunca resolvida por ordem). */
  uncertainties: z.array(z.enum(['DELIVERY_FEE_DIVERGENT', 'MINIMUM_ORDER_DIVERGENT'])).max(2).optional(),
}).strict();
export type Proposal = z.infer<typeof ProposalSchema>;
export const BagSchema = ProposalSchema.extend({
  /** NEEDS_REVALIDATION: participantes, restrições, tetos ou endereço mudaram depois da escolha. */
  status: z.enum(['CURRENT', 'NEEDS_REVALIDATION']),
  origin: z.object({ eventId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) }).strict(),
  /** A loja foi fixada pela própria escolha (não declarada antes): esvaziar a sacola a desfaz. */
  merchantSetBySelection: z.boolean().optional(),
}).strict();
export type Bag = z.infer<typeof BagSchema>;

export const PurchaseStateSchema = z.object({
  schemaVersion: z.literal(1),
  purchaseId: serverId,
  status: PurchaseStatusSchema,
  version: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  linkId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).nullable(),
  merchant: declared(z.object({ merchantId: providerId }).strict()),
  address: declared(z.object({ addressId: providerId }).strict()),
  participants: z.array(ParticipantSchema).max(CONTRACT_MAX_PARTICIPANTS),
  groupLimit: declared(MoneyLimitSchema),
  priority: declared(z.enum(['ECONOMY', 'SPEED'])),
  evidence: z.array(EvidenceSchema).max(200),
  clarifications: z.array(ClarificationSchema).max(MAX_CLARIFICATIONS),
  /** Propostas da última busca; qualquer outra alteração as invalida (apaga). */
  proposals: z.array(ProposalSchema).max(MAX_PROPOSALS).optional(),
  /** Sacola simulada escolhida (consumo por participante). */
  bag: BagSchema.optional(),
}).strict();
export type PurchaseState = z.infer<typeof PurchaseStateSchema>;

// ---------------- operações ----------------

const limitValue = z.union([MoneyLimitSchema, z.literal('NONE')]);
export const DomainOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('ADD_PARTICIPANT'), displayName: shortText(80) }).strict(),
  z.object({ op: z.literal('RENAME_PARTICIPANT'), participantId: serverId, displayName: shortText(80) }).strict(),
  z.object({ op: z.literal('REMOVE_PARTICIPANT'), participantId: serverId, humanConfirmed: z.literal(true).optional() }).strict(),
  z.object({
    op: z.literal('SET_RESTRICTIONS'), participantId: serverId,
    value: z.union([z.array(RestrictionKeySchema).max(MAX_RESTRICTIONS_PER_PARTICIPANT), z.literal('NONE')]),
    humanConfirmed: z.literal(true).optional(),
  }).strict(),
  z.object({ op: z.literal('ADD_RESTRICTION'), participantId: serverId, key: RestrictionKeySchema }).strict(),
  z.object({ op: z.literal('REMOVE_RESTRICTION'), participantId: serverId, restrictionId: serverId, humanConfirmed: z.literal(true) }).strict(),
  z.object({
    op: z.literal('SET_LIMIT'), target: z.union([serverId, z.literal('GROUP')]), value: limitValue,
    humanConfirmed: z.literal(true).optional(),
  }).strict(),
  z.object({ op: z.literal('MARK_UNCLEAR'), target, field: ClarificationFieldSchema, question: shortText(300) }).strict(),
  z.object({ op: z.literal('RESOLVE_CLARIFICATION'), clarificationId: serverId }).strict(),
  z.object({ op: z.literal('SET_PRIORITY'), value: z.enum(['ECONOMY', 'SPEED']) }).strict(),
  z.object({ op: z.literal('SET_MERCHANT'), merchantId: providerId }).strict(),
  z.object({ op: z.literal('SET_ADDRESS'), addressId: providerId }).strict(),
  z.object({ op: z.literal('END'), reason: z.enum(['CLOSED', 'CANCELLED']) }).strict(),
  z.object({ op: z.literal('SET_PROPOSALS'), proposals: z.array(ProposalSchema).max(MAX_PROPOSALS) }).strict(),
  z.object({ op: z.literal('SELECT_PROPOSAL'), proposalId: serverId }).strict(),
  z.object({ op: z.literal('CLEAR_BAG') }).strict(),
]);
export type DomainOp = z.infer<typeof DomainOpSchema>;
export const DomainPatchSchema = z.array(DomainOpSchema).min(1).max(MAX_OPS_PER_PATCH);

/** Caminhos do contrato API-01 (ChangeSchema.paths). */
export type ChangePath = 'PARTICIPANTS' | 'CONDITIONS' | 'BUDGET' | 'PROPOSALS' | 'CART' | 'PHASE';

export type DomainErrorCode =
  | 'INVALID_PATCH'
  | 'PURCHASE_NOT_ACTIVE'
  | 'PARTICIPANT_NOT_FOUND'
  | 'PARTICIPANT_LIMIT'
  | 'RESTRICTION_NOT_FOUND'
  | 'CLARIFICATION_NOT_FOUND'
  | 'CLARIFICATION_LIMIT'
  | 'REQUIRES_HUMAN_CONFIRMATION'
  | 'EVIDENCE_SOURCE_UNVERIFIED'
  | 'INVALID_STATE'
  | 'PROPOSAL_NOT_FOUND'
  | 'PROPOSAL_INVALID';

/** Erro de domínio: mensagem sem dados pessoais, só o código e a posição da operação. */
export class DomainError extends Error {
  constructor(readonly code: DomainErrorCode, readonly opIndex: number | null = null) {
    super(opIndex === null ? code : `${code} (op ${opIndex})`);
  }
}

export interface PatchContext {
  /** Semente estável e privada do escopo (ex.: chave da conversa). Só entra em hash; nunca aparece no estado. */
  seed: string;
  /** Evento aceito que origina a alteração (proveniência). */
  eventId: string;
  /** Máximo de participantes (padrão 20; nunca acima de 100). */
  maxParticipants?: number;
}

const derive = (ctx: PatchContext, kind: string, index: number) =>
  createHash('sha256').update(JSON.stringify(['DATA-01', kind, ctx.seed, ctx.eventId, index])).digest('base64url').slice(0, 24);

const sameKey = (a: RestrictionKey, b: RestrictionKey) => a.kind === b.kind && a.code === b.code;
const isMandatory = (k: RestrictionKey) => k.kind === 'ALLERGY' || (k.requirement ?? 'MANDATORY') === 'MANDATORY';

export function emptyPurchase(ctx: PatchContext): PurchaseState {
  return {
    schemaVersion: 1,
    purchaseId: derive(ctx, 'purchase', 0),
    status: 'ACTIVE',
    version: 0,
    linkId: null,
    merchant: { state: 'NOT_ASKED' },
    address: { state: 'NOT_ASKED' },
    participants: [],
    groupLimit: { state: 'NOT_ASKED' },
    priority: { state: 'NOT_ASKED' },
    evidence: [],
    clarifications: [],
  };
}

export function parsePurchaseState(value: unknown): PurchaseState {
  const r = PurchaseStateSchema.safeParse(value);
  if (!r.success) throw new DomainError('INVALID_STATE');
  return r.data;
}

/**
 * Aplica um patch sobre o estado atual (ou cria a compra, se não houver uma ativa) e devolve o novo estado e os
 * caminhos afetados. `version` não é alterada aqui: quem grava define version = versão do snapshot resultante.
 */
/** Restrições conhecidas da pessoa; null quando não informadas, ambíguas ou com pergunta pendente (bloqueia). */
export function knownRestrictions(state: PurchaseState, p: Participant): RestrictionKey[] | null {
  if (state.clarifications.some((c) => c.target === p.participantId && c.field === 'RESTRICTIONS')) return null;
  if (p.restrictions.state === 'NONE') return [];
  if (p.restrictions.state === 'DECLARED') return p.restrictions.value.map((r) => r.key);
  return null;
}

/** Assinatura estável das restrições atuais da pessoa (GRP-01): mudou ⇒ cobertura calculada antes deixa de valer. */
export function restrictionsSig(state: PurchaseState, p: Participant): string {
  const keys = knownRestrictions(state, p);
  // Normaliza a obrigatoriedade (omitida = obrigatória; alergia é sempre obrigatória) antes de assinar.
  const norm = keys === null ? ['UNKNOWN'] : keys.map((k) => JSON.stringify(k.kind === 'ALLERGY' ? [k.kind, k.code] : [k.kind, k.code, k.requirement ?? 'MANDATORY'])).sort();
  return createHash('sha256').update(JSON.stringify(['GRP-01', 'restrictions', ...norm])).digest('base64url').slice(0, 24);
}

export function applyPatch(current: PurchaseState | null, rawOps: unknown, ctx: PatchContext): { state: PurchaseState; paths: ChangePath[] } {
  const parsed = DomainPatchSchema.safeParse(rawOps);
  if (!parsed.success) throw new DomainError('INVALID_PATCH');
  const ops = parsed.data;
  const max = Math.min(ctx.maxParticipants ?? DEFAULT_MAX_PARTICIPANTS, CONTRACT_MAX_PARTICIPANTS);
  if (!Number.isSafeInteger(max) || max < 1) throw new DomainError('INVALID_PATCH');

  const base = current && current.status === 'ACTIVE' ? current : null;
  if (current && current.status !== 'ACTIVE') throw new DomainError('PURCHASE_NOT_ACTIVE');
  // Encerrar exige uma compra ativa ANTES do patch: criar e encerrar no mesmo turno não expurga a conversa.
  const endIndex = ops.findIndex((o) => o.op === 'END');
  if (base === null && endIndex >= 0) throw new DomainError('PURCHASE_NOT_ACTIVE', endIndex);
  const s: PurchaseState = structuredClone(base ?? emptyPurchase(ctx));
  const origin: Origin = { eventId: ctx.eventId };
  const paths = new Set<ChangePath>();

  /** Operações que mudam quem é atendido, o que pode comer ou quanto pode gastar: a sacola precisa ser revalidada. */
  const REVALIDATE = new Set(['ADD_PARTICIPANT', 'REMOVE_PARTICIPANT', 'SET_RESTRICTIONS', 'ADD_RESTRICTION', 'REMOVE_RESTRICTION',
    'SET_LIMIT', 'MARK_UNCLEAR', 'RESOLVE_CLARIFICATION', 'SET_ADDRESS']);
  ops.forEach((op, i) => {
    if (s.status !== 'ACTIVE') throw new DomainError('PURCHASE_NOT_ACTIVE', i); // nada depois de END
    // Propostas valem só para o estado em que foram geradas: qualquer outra alteração as apaga.
    if (op.op !== 'SET_PROPOSALS' && op.op !== 'SELECT_PROPOSAL' && s.proposals) { delete s.proposals; paths.add('PROPOSALS'); }
    if (REVALIDATE.has(op.op) && s.bag) { s.bag.status = 'NEEDS_REVALIDATION'; paths.add('CART'); }
    const participant = (id: string) => {
      const p = s.participants.find((x) => x.participantId === id);
      if (!p) throw new DomainError('PARTICIPANT_NOT_FOUND', i);
      return p;
    };
    const resolveFor = (tgt: string, field: ClarificationField) => {
      s.clarifications = s.clarifications.filter((c) => !(c.target === tgt && c.field === field));
    };
    const currentRestrictions = (p: Participant) => (p.restrictions.state === 'DECLARED' ? p.restrictions.value : []);
    const newRestriction = (key: RestrictionKey, n: number): Restriction => ({ restrictionId: derive(ctx, 'restriction', i * 100 + n), key, origin });

    switch (op.op) {
      case 'ADD_PARTICIPANT': {
        if (s.participants.length >= max) throw new DomainError('PARTICIPANT_LIMIT', i);
        s.participants.push({
          participantId: derive(ctx, 'participant', i), displayName: op.displayName,
          restrictions: { state: 'NOT_ASKED' }, limit: { state: 'NOT_ASKED' }, origin,
        });
        paths.add('PARTICIPANTS');
        break;
      }
      case 'RENAME_PARTICIPANT':
        participant(op.participantId).displayName = op.displayName;
        paths.add('PARTICIPANTS');
        break;
      case 'REMOVE_PARTICIPANT': {
        const p = participant(op.participantId);
        // Sem isto, remover e recriar o participante apagaria uma alergia, uma pergunta de alergia pendente ou um teto
        // rígido sem confirmação (bypass de D5.6).
        const guarded = currentRestrictions(p).some((r) => isMandatory(r.key)) || p.restrictions.state === 'UNCLEAR' ||
          (p.limit.state === 'DECLARED' && p.limit.value.kind === 'MANDATORY');
        if (guarded && !op.humanConfirmed) {
          throw new DomainError('REQUIRES_HUMAN_CONFIRMATION', i);
        }
        s.participants = s.participants.filter((p) => p.participantId !== op.participantId);
        s.clarifications = s.clarifications.filter((c) => c.target !== op.participantId);
        // Consumo órfão não sobrevive: a pessoa sai das linhas da sacola e linhas sem consumidor somem.
        if (s.bag) {
          s.bag.lines = s.bag.lines
            .map((l) => ({ ...l, consumerIds: l.consumerIds.filter((c) => c !== op.participantId) }))
            .filter((l) => l.consumerIds.length > 0);
          if (s.bag && s.bag.coverage) s.bag.coverage = s.bag.coverage.filter((c) => c.participantId !== op.participantId);
          if (!s.bag.lines.length) delete s.bag;
        }
        paths.add('PARTICIPANTS');
        break;
      }
      case 'SET_RESTRICTIONS': {
        const p = participant(op.participantId);
        const next = op.value === 'NONE' ? [] : op.value;
        for (let a = 0; a < next.length; a++) {
          for (let b = a + 1; b < next.length; b++) if (sameKey(next[a]!, next[b]!)) throw new DomainError('INVALID_PATCH', i);
        }
        // Rígida existente que some ou vira preferência exige confirmação humana explícita.
        const dropsMandatory = currentRestrictions(p).some(
          (r) => isMandatory(r.key) && !next.some((k) => sameKey(k, r.key) && isMandatory(k)),
        );
        if (dropsMandatory && !op.humanConfirmed) throw new DomainError('REQUIRES_HUMAN_CONFIRMATION', i);
        p.restrictions = op.value === 'NONE'
          ? { state: 'NONE', origin }
          : { state: 'DECLARED', value: next.map((k, n) => {
              const kept = currentRestrictions(p).find((r) => sameKey(r.key, k) && (r.key.requirement ?? 'MANDATORY') === (k.requirement ?? 'MANDATORY'));
              return kept ?? newRestriction(k, n);
            }), origin };
        resolveFor(p.participantId, 'RESTRICTIONS');
        paths.add('CONDITIONS');
        break;
      }
      case 'ADD_RESTRICTION': {
        const p = participant(op.participantId);
        const list = currentRestrictions(p);
        const existing = list.find((r) => sameKey(r.key, op.key));
        if (existing && isMandatory(existing.key) && !isMandatory(op.key)) throw new DomainError('REQUIRES_HUMAN_CONFIRMATION', i);
        if (!existing && list.length >= MAX_RESTRICTIONS_PER_PARTICIPANT) throw new DomainError('INVALID_PATCH', i);
        const value = existing
          ? list.map((r) => (r === existing ? { ...r, key: op.key, origin } : r)) // preferência → rígida
          : [...list, newRestriction(op.key, 0)];
        p.restrictions = { state: 'DECLARED', value, origin };
        resolveFor(p.participantId, 'RESTRICTIONS');
        paths.add('CONDITIONS');
        break;
      }
      case 'REMOVE_RESTRICTION': {
        const p = participant(op.participantId);
        const list = currentRestrictions(p);
        if (!list.some((r) => r.restrictionId === op.restrictionId)) throw new DomainError('RESTRICTION_NOT_FOUND', i);
        const rest = list.filter((r) => r.restrictionId !== op.restrictionId);
        // Remover a última restrição volta a "declarado" com lista vazia, não a "nenhuma" (que exige declaração própria).
        p.restrictions = { state: 'DECLARED', value: rest, origin };
        paths.add('CONDITIONS');
        break;
      }
      case 'SET_LIMIT': {
        const value: Declared<MoneyLimit> = op.value === 'NONE' ? { state: 'NONE', origin } : { state: 'DECLARED', value: op.value, origin };
        const previous = op.target === 'GROUP' ? s.groupLimit : participant(op.target).limit;
        // Mudar o valor de um teto rígido é permitido (R$180 → R$150); tirá-lo ou torná-lo flexível exige confirmação.
        const weakens = previous.state === 'DECLARED' && previous.value.kind === 'MANDATORY' && (op.value === 'NONE' || op.value.kind !== 'MANDATORY');
        if (weakens && !op.humanConfirmed) throw new DomainError('REQUIRES_HUMAN_CONFIRMATION', i);
        if (op.target === 'GROUP') {
          s.groupLimit = value;
          resolveFor('GROUP', 'LIMIT');
        } else {
          participant(op.target).limit = value;
          resolveFor(op.target, 'LIMIT');
        }
        paths.add('BUDGET'); // participantes e restrições não são tocados (critério R$180 → R$150)
        break;
      }
      case 'MARK_UNCLEAR': {
        const id = derive(ctx, 'clarification', i);
        const markers = { state: 'UNCLEAR' as const, clarificationId: id, origin };
        // Valor já declarado continua valendo (teto rígido, restrições, loja...); só "não perguntado"/"nenhum" viram ambíguo.
        const mark = <T>(d: Declared<T>): Declared<T> => (d.state === 'DECLARED' ? d : markers);
        const purchaseField = op.field === 'PRIORITY' || op.field === 'MERCHANT' || op.field === 'ADDRESS';
        if (purchaseField !== (op.target === 'PURCHASE')) throw new DomainError('INVALID_PATCH', i);
        if (op.target === 'GROUP' && op.field !== 'LIMIT') throw new DomainError('INVALID_PATCH', i);
        if (op.target === 'GROUP') s.groupLimit = mark(s.groupLimit);
        else if (op.target === 'PURCHASE') {
          if (op.field === 'PRIORITY') s.priority = mark(s.priority);
          if (op.field === 'MERCHANT') s.merchant = mark(s.merchant);
          if (op.field === 'ADDRESS') s.address = mark(s.address);
        } else {
          const p = participant(op.target);
          if (op.field === 'RESTRICTIONS') p.restrictions = mark(p.restrictions);
          else if (op.field === 'LIMIT') p.limit = mark(p.limit);
          else throw new DomainError('INVALID_PATCH', i);
        }
        resolveFor(op.target, op.field);
        if (s.clarifications.length >= MAX_CLARIFICATIONS) throw new DomainError('CLARIFICATION_LIMIT', i);
        s.clarifications.push({ clarificationId: id, target: op.target, field: op.field, question: op.question, origin });
        paths.add(op.field === 'RESTRICTIONS' ? 'CONDITIONS' : op.field === 'LIMIT' ? 'BUDGET' : 'PROPOSALS');
        break;
      }
      case 'RESOLVE_CLARIFICATION': {
        const c = s.clarifications.find((x) => x.clarificationId === op.clarificationId);
        if (!c) throw new DomainError('CLARIFICATION_NOT_FOUND', i);
        s.clarifications = s.clarifications.filter((x) => x !== c);
        // Campo ainda marcado como ambíguo volta a "não perguntado"; valor declarado nunca é inventado.
        const reset = <T>(d: Declared<T>): Declared<T> => (d.state === 'UNCLEAR' && d.clarificationId === c.clarificationId ? { state: 'NOT_ASKED' } : d);
        if (c.target === 'GROUP') s.groupLimit = reset(s.groupLimit);
        else if (c.target === 'PURCHASE') {
          s.priority = reset(s.priority);
          s.merchant = reset(s.merchant);
          s.address = reset(s.address);
        } else {
          const p = s.participants.find((x) => x.participantId === c.target);
          if (p) {
            p.restrictions = reset(p.restrictions);
            p.limit = reset(p.limit);
          }
        }
        paths.add(c.field === 'RESTRICTIONS' ? 'CONDITIONS' : c.field === 'LIMIT' ? 'BUDGET' : 'PROPOSALS');
        break;
      }
      case 'SET_PRIORITY':
        s.priority = { state: 'DECLARED', value: op.value, origin };
        resolveFor('PURCHASE', 'PRIORITY');
        paths.add('PROPOSALS');
        break;
      case 'SET_MERCHANT': {
        const changed = s.merchant.state !== 'DECLARED' || s.merchant.value.merchantId !== op.merchantId;
        s.merchant = { state: 'DECLARED', value: { merchantId: op.merchantId }, origin };
        if (changed) s.evidence = s.evidence.filter((e) => e.merchantId === op.merchantId);
        if (changed && s.bag && s.bag.merchantId !== op.merchantId) { delete s.bag; paths.add('CART'); } // loja única (D2)
        if (s.bag?.merchantSetBySelection) s.bag.merchantSetBySelection = false; // agora é escolha explícita do usuário
        resolveFor('PURCHASE', 'MERCHANT');
        paths.add('PROPOSALS');
        break;
      }
      case 'SET_ADDRESS':
        s.address = { state: 'DECLARED', value: { addressId: op.addressId }, origin };
        resolveFor('PURCHASE', 'ADDRESS');
        paths.add('PROPOSALS');
        break;
      case 'END':
        s.status = op.reason;
        paths.add('PHASE');
        break;
      case 'SET_PROPOSALS': {
        const ids = new Set(s.participants.map((p) => p.participantId));
        const seen = new Set<string>();
        for (const pr of op.proposals) {
          const lines = new Set<string>();
          const unknownConsumer = pr.lines.some((l) => l.consumerIds.some((c) => !ids.has(c)) || new Set(l.consumerIds).size !== l.consumerIds.length);
          const badPrice = pr.lines.some((l) => l.unitMaxCents !== null && l.unitMaxCents < l.unitMinCents);
          const dupLine = pr.lines.some((l) => (lines.has(l.lineId) ? true : (lines.add(l.lineId), false)));
          const wrongMerchant = s.merchant.state === 'DECLARED' && s.merchant.value.merchantId !== pr.merchantId;
          // Revalidação no commit (não confia só no processador): cobertura de todos, e quem consome precisa ter sido
          // avaliado com as restrições conhecidas ATUAIS (assinatura igual). Restrição mudou ⇒ proposta recusada.
          const cov = pr.coverage ?? [];
          const badCoverage = cov.length !== ids.size || new Set(cov.map((c) => c.participantId)).size !== cov.length || cov.some((c) => {
            const person = s.participants.find((p) => p.participantId === c.participantId);
            if (!person) return true;
            const consumes = pr.lines.some((l) => l.consumerIds.includes(c.participantId));
            if ((c.status === 'COVERED') !== consumes) return true;
            return consumes && (knownRestrictions(s, person) === null || c.restrictionsSig !== restrictionsSig(s, person));
          });
          const wrongAddress = pr.addressId != null && s.address.state === 'DECLARED' && s.address.value.addressId !== pr.addressId;
          if (badCoverage || wrongAddress) throw new DomainError('PROPOSAL_INVALID', i);
          if (seen.has(pr.proposalId) || unknownConsumer || badPrice || dupLine || wrongMerchant) throw new DomainError('PROPOSAL_INVALID', i);
          seen.add(pr.proposalId);
        }
        if (op.proposals.length) s.proposals = op.proposals; else delete s.proposals;
        paths.add('PROPOSALS');
        break;
      }
      case 'SELECT_PROPOSAL': {
        const pr = s.proposals?.find((x) => x.proposalId === op.proposalId);
        if (!pr) throw new DomainError('PROPOSAL_NOT_FOUND', i);
        // Loja fixada só por uma escolha anterior pode ser trocada por outra escolha; loja declarada pelo usuário, não.
        const bySelection = s.bag?.merchantSetBySelection === true && s.merchant.state === 'DECLARED' && s.merchant.value.merchantId === s.bag.merchantId;
        if (s.merchant.state === 'DECLARED' && s.merchant.value.merchantId !== pr.merchantId && !bySelection) throw new DomainError('PROPOSAL_INVALID', i);
        const setBySelection = s.merchant.state !== 'DECLARED' || bySelection;
        if (setBySelection && (s.merchant.state !== 'DECLARED' || s.merchant.value.merchantId !== pr.merchantId)) {
          s.evidence = s.evidence.filter((e) => e.merchantId === pr.merchantId);
          s.merchant = { state: 'DECLARED', value: { merchantId: pr.merchantId }, origin };
        }
        s.bag = { ...structuredClone(pr), status: 'CURRENT', origin, merchantSetBySelection: setBySelection };
        paths.add('CART');
        break;
      }
      case 'CLEAR_BAG':
        if (s.bag) {
          // Loja fixada só pela escolha volta a "não perguntada"; loja declarada pelo usuário é preservada.
          if (s.bag.merchantSetBySelection && s.merchant.state === 'DECLARED' && s.merchant.value.merchantId === s.bag.merchantId) {
            s.merchant = { state: 'NOT_ASKED' };
            paths.add('PROPOSALS');
          }
          delete s.bag;
        }
        paths.add('CART');
        break;
    }
  });

  return { state: parsePurchaseState(s), paths: [...paths] };
}

/**
 * Associação ou troca de conta iFood: invalida o que depende do vínculo (loja, endereço, evidência e esclarecimentos
 * sobre eles) e preserva participantes, restrições, limites e prioridade, que podem ser revalidados. Na primeira
 * associação, o que foi definido sem vínculo também é invalidado: não dá para atribuí-lo a esta conta.
 * Retorna null se o vínculo não mudou.
 */
export function applyLinkChange(
  current: PurchaseState, linkId: string,
): { state: PurchaseState; paths: ChangePath[]; event: 'ASSOCIATED' | 'CHANGED' } | null {
  if (current.linkId === linkId) return null;
  const s = structuredClone(current);
  const event = current.linkId === null ? 'ASSOCIATED' : 'CHANGED';
  s.linkId = linkId;
  const dependent = s.merchant.state !== 'NOT_ASKED' || s.address.state !== 'NOT_ASKED' || s.evidence.length > 0 ||
    s.bag !== undefined || s.proposals !== undefined ||
    s.clarifications.some((c) => c.target === 'PURCHASE' && (c.field === 'MERCHANT' || c.field === 'ADDRESS'));
  if (!dependent) return { state: parsePurchaseState(s), paths: [], event };
  s.merchant = { state: 'NOT_ASKED' };
  s.address = { state: 'NOT_ASKED' };
  s.evidence = [];
  // Preços, itens e loja dependem da conta: sacola e propostas não sobrevivem à troca.
  const hadBag = s.bag !== undefined;
  delete s.bag;
  delete s.proposals;
  s.clarifications = s.clarifications.filter((c) => !(c.target === 'PURCHASE' && (c.field === 'MERCHANT' || c.field === 'ADDRESS')));
  return { state: parsePurchaseState(s), paths: hadBag ? ['PROPOSALS', 'CART'] : ['PROPOSALS'], event };
}

/**
 * Registro de confirmação de restaurante (RS13). Só aceita canal em VERIFIED_EVIDENCE_CHANNELS — vazio na demo —,
 * então declarações do modelo ou do organizador nunca viram evidência.
 */
export function recordEvidence(current: PurchaseState, evidence: Omit<Evidence, 'evidenceId'> & { evidenceId?: string }): PurchaseState {
  if (!VERIFIED_EVIDENCE_CHANNELS.includes(evidence.channel)) throw new DomainError('EVIDENCE_SOURCE_UNVERIFIED');
  /* c8 ignore next 2 -- inalcançável enquanto nenhum canal for aprovado */
  const parsed = EvidenceSchema.safeParse(evidence);
  if (!parsed.success) throw new DomainError('INVALID_PATCH');
  return parsePurchaseState({ ...current, evidence: [...current.evidence, parsed.data] });
}

/**
 * Evidência aplicável a uma combinação exata de loja + item + opções + restrição, ainda válida.
 * Outro item, variante (opções diferentes) ou confirmação vencida não libera a combinação atual (CA07).
 */
export function findEvidence(
  state: PurchaseState, q: { merchantId: string; itemId: string; optionIds: string[]; restriction: RestrictionKey; now: number },
): Evidence | null {
  const want = [...q.optionIds].sort().join('\u0000');
  return state.evidence.find((e) =>
    e.merchantId === q.merchantId && e.itemId === q.itemId && [...e.optionIds].sort().join('\u0000') === want &&
    sameKey(e.restriction, q.restriction) && e.obtainedAt <= q.now && q.now < e.expiresAt) ?? null;
}

// ---------------- composição usada pelo armazenamento e pela pré-visualização ----------------

/** Alteração de domínio proposta por um processador confiável (TurnResult.domain). */
export const DomainChangeSchema = z.object({
  ops: z.array(DomainOpSchema).max(MAX_OPS_PER_PATCH),
  /** Vínculo iFood usado neste turno; troca de conta invalida dados dependentes (derivado). */
  linkId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).nullable().optional(),
}).strict();
export type DomainChange = z.infer<typeof DomainChangeSchema>;

/**
 * Próximo estado a partir do estado persistido: primeiro a troca de vínculo (derivada), depois o patch.
 * Determinístico: o armazenamento recalcula com o mesmo contexto e grava este resultado — nunca um estado pronto.
 */
export function nextPurchase(
  previous: PurchaseState | null, rawChange: unknown, ctx: PatchContext,
): { state: PurchaseState | null; paths: ChangePath[]; linkEvent: 'ASSOCIATED' | 'CHANGED' | null; ops: DomainOp[] } {
  const parsed = DomainChangeSchema.safeParse(rawChange);
  if (!parsed.success) throw new DomainError('INVALID_PATCH');
  const change = parsed.data;
  let state = previous && previous.status === 'ACTIVE' ? previous : null;
  const paths = new Set<ChangePath>();
  let linkEvent: 'ASSOCIATED' | 'CHANGED' | null = null;
  if (state && change.linkId) {
    const lc = applyLinkChange(state, change.linkId);
    if (lc) {
      state = lc.state;
      linkEvent = lc.event;
      lc.paths.forEach((p) => paths.add(p));
    }
  }
  if (change.ops.length) {
    const r = applyPatch(state, change.ops, ctx);
    state = r.state;
    r.paths.forEach((p) => paths.add(p));
  }
  // Compra criada neste turno: as operações já rodaram sob este vínculo, então só registra a associação.
  if (state && change.linkId && state.linkId === null) {
    state = parsePurchaseState({ ...state, linkId: change.linkId });
    linkEvent = 'ASSOCIATED';
  }
  return { state, paths: [...paths], linkEvent, ops: change.ops };
}
