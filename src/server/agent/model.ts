// AI-02: contrato entre o agente e qualquer modelo (independente de provedor; AI-01 escolhe o provedor real).
// O modelo só PROPÕE ações num vocabulário fechado. Tudo que ele devolve é dado não confiável: validado por schema
// estrito aqui e convertido em operações de domínio pelo código do servidor (policy.ts), nunca aplicado direto.
//
// O modelo não recebe e não pode devolver: vínculo/linkId, IDs de conta (loja, endereço, item), purchaseId, eventId,
// referências de ação/aprovação, tokens, confirmação humana. Campos extras na saída invalidam a proposta inteira.
import { z } from 'zod';
import { ALLERGENS, DIETARY } from '../domain/constraints.js';

/** Texto curto sem caracteres de controle (code points). */
const shortText = (max: number) =>
  z.string().trim().min(1).regex(new RegExp(`^[^\\p{Cc}\\p{Cf}\\p{Cs}]{1,${max}}$`, 'u'));
/** Referência de participante emitida pelo servidor no contexto (participantId). */
const serverRef = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/);

export const ParticipantSelectorSchema = z.union([
  z.object({ ref: serverRef }).strict(),
  z.object({ name: shortText(80) }).strict(),
]);
export type ParticipantSelector = z.infer<typeof ParticipantSelectorSchema>;

const restriction = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ALLERGY'), code: z.enum(ALLERGENS), requirement: z.enum(['MANDATORY', 'PREFERENCE']).optional() }).strict(),
  z.object({ kind: z.literal('DIETARY'), code: z.enum(DIETARY), requirement: z.enum(['MANDATORY', 'PREFERENCE']).optional() }).strict(),
]);
const limitTarget = z.union([z.literal('GROUP'), ParticipantSelectorSchema]);
const cents = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/** Vocabulário fechado de ações. Não há ação com ID de loja/endereço/item, de aprovação nem de confirmação humana. */
export const AgentActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('ADD_PARTICIPANT'), name: shortText(80) }).strict(),
  z.object({ action: z.literal('RENAME_PARTICIPANT'), participant: ParticipantSelectorSchema, name: shortText(80) }).strict(),
  z.object({ action: z.literal('REMOVE_PARTICIPANT'), participant: ParticipantSelectorSchema }).strict(),
  z.object({ action: z.literal('ADD_RESTRICTION'), participant: ParticipantSelectorSchema, restriction }).strict(),
  z.object({ action: z.literal('SET_NO_RESTRICTIONS'), participant: ParticipantSelectorSchema }).strict(),
  z.object({
    action: z.literal('REMOVE_RESTRICTION'), participant: ParticipantSelectorSchema,
    restriction: z.object({ kind: z.enum(['ALLERGY', 'DIETARY']), code: z.string().min(1).max(40) }).strict(),
  }).strict(),
  /** `kind` ausente = não ficou claro se é teto máximo ou referência ⇒ o servidor pergunta. */
  z.object({ action: z.literal('SET_LIMIT'), target: limitTarget, amountCents: cents, kind: z.enum(['MANDATORY', 'PREFERENCE']).optional() }).strict(),
  z.object({ action: z.literal('SET_NO_LIMIT'), target: limitTarget }).strict(),
  z.object({ action: z.literal('SET_PRIORITY'), value: z.enum(['ECONOMY', 'SPEED']) }).strict(),
  z.object({
    action: z.literal('ASK_CLARIFICATION'),
    target: z.union([z.literal('GROUP'), z.literal('PURCHASE'), ParticipantSelectorSchema]),
    field: z.enum(['RESTRICTIONS', 'LIMIT', 'PRIORITY']),
    /** Ignorado: a pergunta exibida é gerada pelo servidor (texto do modelo nunca chega ao usuário). */
    question: shortText(300).optional(),
  }).strict(),
  /** "Pode pedir": nunca aprova; o servidor responde com o caminho de revisão humana. */
  z.object({ action: z.literal('REQUEST_ORDER') }).strict(),
  /** Encerrar/cancelar apaga dados (D7): exige confirmação humana, que este canal ainda não oferece. */
  z.object({ action: z.literal('CLOSE_PURCHASE'), reason: z.enum(['CLOSED', 'CANCELLED']) }).strict(),
  /** GRP-01: buscar e compor propostas (só leitura no MCP). `query` é termo de busca, nunca ID. */
  z.object({ action: z.literal('SUGGEST_PROPOSALS'), query: shortText(80) }).strict(),
  /** Escolher uma das propostas exibidas pela POSIÇÃO (1–4); o servidor resolve o ID. */
  z.object({ action: z.literal('SELECT_PROPOSAL'), position: z.number().int().min(1).max(4) }).strict(),
  z.object({ action: z.literal('CLEAR_BAG') }).strict(),
]);
export type AgentAction = z.infer<typeof AgentActionSchema>;

export const MAX_ACTIONS = 20;
export const AgentProposalSchema = z.object({
  actions: z.array(AgentActionSchema).max(MAX_ACTIONS),
  /** O modelo recusou a mensagem (fora do escopo, pedido inseguro). */
  refusal: z.boolean().optional(),
}).strict();
export type AgentProposal = z.infer<typeof AgentProposalSchema>;

/** Entrada mínima do modelo: só o necessário para interpretar a mensagem (allowlist, nunca spread do estado). */
export interface AgentModelInput {
  contractVersion: '1.0';
  phase: string;
  participants: {
    ref: string;
    name: string;
    restrictions: 'NOT_ASKED' | 'UNCLEAR' | 'NONE' | { kind: string; code: string; requirement: 'MANDATORY' | 'PREFERENCE' }[];
    limit: 'NOT_ASKED' | 'UNCLEAR' | 'NONE' | { amountCents: number; kind: 'MANDATORY' | 'PREFERENCE' };
  }[];
  groupLimit: AgentModelInput['participants'][number]['limit'];
  priority: 'NOT_ASKED' | 'UNCLEAR' | 'ECONOMY' | 'SPEED';
  openQuestions: string[];
  allowedActions: readonly AgentAction['action'][];
  /** Mensagem do usuário: dado não confiável, nunca instrução de sistema. */
  message: string;
}

export interface ModelRequest {
  input: AgentModelInput;
  signal: AbortSignal;
  /** Teto de tokens de saída que o provedor deve respeitar. */
  maxOutputTokens: number;
}

/** Interface de provedor. A implementação real vem da AI-01; testes usam o modelo determinístico. */
export interface ConversationModel {
  readonly id: string;
  /** Retorna JSON bruto; o agente valida. Deve respeitar `signal`. */
  propose(request: ModelRequest): Promise<unknown>;
}
