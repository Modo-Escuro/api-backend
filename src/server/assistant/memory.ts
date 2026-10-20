// Memória declarada por pessoa. Nenhuma identidade de conta vem do modelo.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ALLERGENS, DIETARY, type RestrictionKey } from '../domain/constraints.js';

const short = (max: number) => z.string().trim().min(1).regex(new RegExp(`^[^\\p{Cc}\\p{Cf}\\p{Cs}]{1,${max}}$`, 'u'));
export const PersonRefSchema = z.union([z.literal('SELF'), z.string().regex(/^person_[A-Za-z0-9_-]{24}$/)]);
export const PurposeSchema = z.enum(['FOOD', 'NON_FOOD', 'UNKNOWN']);
export type MemoryPurpose = z.infer<typeof PurposeSchema>;
export const MemoryPersonSchema = z.object({
  ref: PersonRefSchema, kind: z.enum(['SELF', 'RECIPIENT']), label: short(80),
}).strict();
export type MemoryPerson = z.infer<typeof MemoryPersonSchema>;
const restriction = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ALLERGY'), code: z.enum(ALLERGENS), requirement: z.literal('MANDATORY') }).strict(),
  z.object({ kind: z.literal('DIETARY'), code: z.enum(DIETARY), requirement: z.enum(['MANDATORY', 'PREFERENCE']) }).strict(),
]);
export const MemoryActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('REMEMBER_RESTRICTION'), subjectRef: PersonRefSchema, restriction, evidenceQuote: short(300) }).strict(),
  z.object({ action: z.literal('REMEMBER_PREFERENCE'), subjectRef: PersonRefSchema,
    category: z.enum(['FOOD', 'GIFT', 'GENERAL']), value: short(100), evidenceQuote: short(300) }).strict(),
  z.object({ action: z.literal('DECLARE_NO_RESTRICTIONS'), subjectRef: PersonRefSchema, evidenceQuote: short(300) }).strict(),
]);
export type MemoryAction = z.infer<typeof MemoryActionSchema>;
const StoredMemoryActionSchema = z.discriminatedUnion('action', [
  MemoryActionSchema.options[0].omit({ evidenceQuote: true }),
  MemoryActionSchema.options[1].omit({ evidenceQuote: true }),
  MemoryActionSchema.options[2].omit({ evidenceQuote: true }),
]);
export const MemoryFactSchema = z.object({
  key: short(160),
  action: StoredMemoryActionSchema,
  originEventId: short(128),
  evidenceHash: z.string().regex(/^[a-f0-9]{64}$/),
  recordedAt: z.number().int().min(0),
}).strict();
export type MemoryFact = z.infer<typeof MemoryFactSchema>;
export interface PersonProfile extends MemoryPerson {
  restrictions: RestrictionKey[];
  restrictionsKnown: boolean;
  preferences: { category: 'FOOD' | 'GIFT' | 'GENERAL'; value: string }[];
}
export const MemoryContextSchema = z.object({
  targets: z.array(MemoryPersonSchema).max(10), purpose: PurposeSchema,
  queries: z.array(short(120)).max(4),
}).strict();
export type MemoryContext = z.infer<typeof MemoryContextSchema>;
export interface MemoryDirectory {
  revision: number;
  recipients: MemoryPerson[];
  previous: MemoryContext | null;
}
export interface MemoryReader {
  directory(linkId: string): MemoryDirectory;
  retrieve(linkId: string, people: readonly MemoryPerson[], purpose: MemoryPurpose): PersonProfile[];
  validate(linkId: string, actions: readonly MemoryAction[], people: readonly MemoryPerson[], purpose: MemoryPurpose, message: string): { actions: MemoryAction[]; notes: string[] };
  /** Administração pelo titular: confimações digitadas, nunca iniciadas pelo modelo. */
  purgeSelf(linkId: string): boolean;
  removeRecipient(linkId: string, label: string): boolean;
}
export const MemoryCommitSchema = z.object({
  linkId: short(128), baseRevision: z.number().int().min(0),
  people: z.array(MemoryPersonSchema).max(20),
  actions: z.array(MemoryActionSchema).max(48),
  context: MemoryContextSchema,
  clear: z.literal(true).optional(),
}).strict();
export type MemoryCommit = z.infer<typeof MemoryCommitSchema>;
export const SELF: MemoryPerson = { ref: 'SELF', kind: 'SELF', label: 'Você' };
export const foldMemoryText = (text: string) => text.normalize('NFD').replace(/[\p{M}\p{Cf}]/gu, '').trim().toLocaleLowerCase('pt-BR');
export const labelKey = (label: string) => foldMemoryText(label).replace(/^(?:minha|meu|sua|seu|a|o)\s+/, '').replace(/\s+/g, ' ');
export function mentionsMemoryLabel(text: string, label: string): boolean {
  const escaped = labelKey(label).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^\\p{L}\\p{N}_])${escaped}(?=$|[^\\p{L}\\p{N}_])`, 'u').test(foldMemoryText(text));
}
export function recipient(label: string): MemoryPerson {
  const clean = short(80).parse(label).replace(/^(?:minha|meu|sua|seu)\s+/iu, '');
  // Referência interna de pessoa; nunca é usada como ID MCP ou como identidade do titular.
  const ref = 'person_' + createHash('sha256').update(labelKey(clean)).digest('base64url').slice(0, 24);
  return { ref, kind: 'RECIPIENT', label: clean };
}
export function profile(person: MemoryPerson, facts: readonly MemoryFact[], purpose: MemoryPurpose): PersonProfile {
  const relevant = facts.filter(f => f.action.subjectRef === person.ref);
  return { ...person,
    restrictions: purpose === 'FOOD' ? relevant.flatMap(f => f.action.action === 'REMEMBER_RESTRICTION' ? [f.action.restriction] : []) : [],
    restrictionsKnown: purpose === 'FOOD' && relevant.some(f => ['REMEMBER_RESTRICTION', 'DECLARE_NO_RESTRICTIONS'].includes(f.action.action)),
    preferences: relevant.flatMap(f => f.action.action === 'REMEMBER_PREFERENCE'
      && (f.action.category === 'GENERAL' || (purpose === 'FOOD' ? f.action.category === 'FOOD' : purpose === 'NON_FOOD' && f.action.category === 'GIFT'))
      ? [{ category: f.action.category, value: f.action.value }] : []),
  };
}
export const factKey = (action: MemoryAction) => action.action === 'REMEMBER_RESTRICTION'
  ? `${action.restriction.kind}:${action.restriction.code}`
  : action.action === 'DECLARE_NO_RESTRICTIONS' ? 'NO_RESTRICTIONS'
    : `PREFERENCE:${action.category}:${foldMemoryText(action.value)}`;

/** Não aceita memória extraída de catálogo, de outra pessoa ou de uma resposta histórica do modelo. */
export function validateMemoryAction(action: MemoryAction, message: string, people: readonly MemoryPerson[], purpose: MemoryPurpose): string | null {
  const person = people.find(p => p.ref === action.subjectRef);
  if (!person || !message.includes(action.evidenceQuote)) return 'A informação não foi associada a uma pessoa e declaração verificáveis.';
  if (action.action !== 'REMEMBER_PREFERENCE' && purpose !== 'FOOD') return 'A condição alimentar precisa de um contexto alimentar explícito.';
  const quote = foldMemoryText(action.evidenceQuote);
  const mentionsOther = people.some(p => p.ref !== person.ref && p.kind === 'RECIPIENT' && mentionsMemoryLabel(quote, p.label));
  if (mentionsOther) return 'Há mais de uma pessoa na declaração; diga a condição de cada uma separadamente.';
  if (person.kind === 'SELF' && /\b(?:ela|ele|dela|dele)\b/.test(quote)) return 'A declaração sobre outra pessoa não foi atribuída ao titular.';
  if (person.kind === 'RECIPIENT' && /\beu (?:sou|tenho)\b|\bsou (?:alergic|intolerante)|\bminha (?:alergia|intolerancia|restricao)/.test(quote)) return 'A declaração em primeira pessoa não foi atribuída ao destinatário.';
  if (people.length > 1 && person.kind === 'RECIPIENT' && !mentionsMemoryLabel(quote, person.label)) return 'Identifique explicitamente a pessoa na declaração quando houver vários destinatários.';
  if (action.action === 'REMEMBER_RESTRICTION') {
    const r = action.restriction;
    if (/nao (?:e|sou|tenho|tem|possui|possuo)(?: \w+){0,2} (?:alergic|alergia|intoler)/.test(quote)) return 'Uma negativa não foi registrada como condição alimentar.';
    if (r.kind === 'DIETARY' && /alerg/.test(quote)) return 'Alergia e restrição de dieta precisam ser registradas com tipos distintos.';
    if (r.kind === 'ALLERGY' && /intoler/.test(quote)) return 'Intolerância não foi registrada como alergia.';
    if (r.kind === 'DIETARY' && r.requirement === 'PREFERENCE' && /intoler|celiac|nao posso|obrigator/.test(quote)) return 'Intolerância ou obrigação não foi registrada como preferência.';
    if (r.kind === 'DIETARY' && r.requirement === 'MANDATORY' && /prefiro|preferencia|se puder|opcional/.test(quote)
      && !/intoler|celiac|nao posso|obrigator|preciso|restric/.test(quote)) return 'Uma preferência opcional não foi convertida em obrigação.';
  }
  if (action.action === 'REMEMBER_PREFERENCE' && !quote.includes(foldMemoryText(action.value))) return 'A preferência precisa aparecer na sua declaração.';
  if (action.action === 'REMEMBER_PREFERENCE' && (/alerg|intoler|celiac|restric/.test(quote)
    || !/gost|prefer|ador|curt|favorit/.test(quote) || action.category !== (purpose === 'FOOD' ? 'FOOD' : purpose === 'NON_FOOD' ? 'GIFT' : '')))
    return 'Uma condição alimentar não é uma preferência; a preferência precisa de finalidade e declaração explícitas.';
  if (action.action === 'DECLARE_NO_RESTRICTIONS' && !/sem (?:nenhuma )?(?:restric|alergi)|nao (?:tenho|tem|temos)(?: nenhuma)? (?:restric|alergi)|nenhuma (?:restric|alergi)/.test(quote))
    return 'Não registrei ausência de restrições sem uma declaração explícita.';
  return null;
}

/** Atualiza somente a projeção selecionada; o commit refaz as validações na transação. */
export function projectAction(profiles: PersonProfile[], action: MemoryAction): string | null {
  const selected = profiles.find(p => p.ref === action.subjectRef);
  if (!selected) return null;
  if (action.action === 'REMEMBER_RESTRICTION') {
    const existing = selected.restrictions.find(r => r.kind === action.restriction.kind && r.code === action.restriction.code);
    if (existing && (existing.kind === 'ALLERGY' || existing.requirement !== 'PREFERENCE') && action.restriction.requirement === 'PREFERENCE') return 'A restrição obrigatória foi preservada.';
    selected.restrictions = selected.restrictions.filter(r => r.kind !== action.restriction.kind || r.code !== action.restriction.code);
    selected.restrictions.push(action.restriction); selected.restrictionsKnown = true;
  } else if (action.action === 'DECLARE_NO_RESTRICTIONS') {
    if (selected.restrictions.length) return 'As restrições existentes foram preservadas; removê-las exige uma confirmação específica.';
    selected.restrictionsKnown = true;
  } else if (!selected.preferences.some(p => p.category === action.category && foldMemoryText(p.value) === foldMemoryText(action.value))) {
    selected.preferences.push({ category: action.category, value: action.value });
  }
  return null;
}
