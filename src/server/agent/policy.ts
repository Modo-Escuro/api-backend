// AI-02: converte a proposta do modelo em operações de domínio validadas pelo servidor.
// Regras (DEC-01 D5/D6/D8, issue #16):
//  - Cada ação é validada incrementalmente com a mesma pré-visualização que o commit usa; uma ação inválida vira
//    pendência para o usuário e não contamina as demais. O patch final é sempre aceito pelo domínio.
//  - Participante é resolvido no estado atual (ref do servidor ou nome único). Nome ambíguo ou desconhecido ⇒ pergunta.
//  - Confirmação humana nunca é marcada pelo agente: remover/rebaixar algo rígido e encerrar a compra viram pendência.
//  - Alergia é sempre MANDATORY (o modelo não rebaixa). Teto sem `kind` claro ⇒ pergunta (UNCLEAR, não "sem teto").
//  - "Pode pedir" nunca aprova: responde com o caminho de revisão humana (BUY-01 não implementada).
//  - Nenhum texto livre do modelo é exibido, gravado ou devolvido ao modelo: perguntas vêm de modelos fixos do servidor.
//  - `refusal` descarta todas as ações; remover e recriar alguém no mesmo turno é recusado.
import { DomainError, type DomainChange, type DomainOp, type Participant, type PurchaseState } from '../domain/purchase.js';
import type { RestrictionKey } from '../domain/constraints.js';
import { formatCents } from '../domain/money.js';
import { label as ptLabel } from './render.js';
import type { AgentAction, AgentModelInput, AgentProposal, ParticipantSelector } from './model.js';

export const ALLOWED_ACTIONS: readonly AgentAction['action'][] = [
  'ADD_PARTICIPANT', 'RENAME_PARTICIPANT', 'REMOVE_PARTICIPANT', 'ADD_RESTRICTION', 'SET_NO_RESTRICTIONS',
  'REMOVE_RESTRICTION', 'SET_LIMIT', 'SET_NO_LIMIT', 'SET_PRIORITY', 'ASK_CLARIFICATION', 'REQUEST_ORDER', 'CLOSE_PURCHASE',
  'SUGGEST_PROPOSALS', 'SELECT_PROPOSAL', 'CLEAR_BAG',
];

const CONFIRMATION = 'precisa de confirmação explícita sua, que ainda não pode ser dada por mensagem nesta etapa; nada foi alterado';
export const REVIEW_NOTE = 'Para fazer o pedido, a sacola simulada precisa ser revisada e aprovada por botão. Essa revisão ainda não está disponível nesta etapa; nenhuma compra foi feita.';

const fold = (s: string) => s.normalize('NFD').replace(/[\p{M}\p{Cf}]/gu, '').trim().toLocaleLowerCase('pt-BR');
/** Acima disto (R$ 100 mil) o valor é tratado como implausível: na prática equivaleria a "sem teto" sem ninguém dizer. */
export const MAX_PLAUSIBLE_LIMIT_CENTS = 10_000_000;
const UNCLEAR_NOTE = 'Não entendi um ponto da sua mensagem. Pode reformular?';
/**
 * "Sem teto" só vale se a PRÓPRIA mensagem humana disser isso explicitamente. A proposta do modelo sozinha não basta:
 * sem uma destas expressões no texto do usuário, o servidor pergunta em vez de remover o teto.
 */
export const EXPLICIT_NO_LIMIT = /\bsem (?:teto|limite|orcamento|restricao de (?:valor|preco|orcamento))\b|\bnao (?:tem|ha|existe|temos|precisa de) (?:teto|limite|orcamento)\b|\bqualquer valor\b|\bpode gastar o que (?:for preciso|quiser)\b/;
export const hasExplicitNoLimit = (message: string) => EXPLICIT_NO_LIMIT.test(fold(message));
/**
 * "Sem restrições" só vale se a PRÓPRIA mensagem humana disser isso. Sem a expressão, o servidor pergunta (MARK_UNCLEAR
 * preserva o valor declarado) em vez de liberar a pessoa: restrição desconhecida continua bloqueando.
 */
export const EXPLICIT_NO_RESTRICTIONS = /\bsem (?:nenhuma |qualquer )?(?:restric|alergi)|\bnao (?:tem|tenho|temos|tenhem|possui|possuem|ha)(?: nenhuma| qualquer)? (?:restric|alergi)|\bnenhuma (?:restricao|alergia)\b|\bcome(?:m|mos)? de tudo\b/;
export const hasExplicitNoRestrictions = (message: string) => EXPLICIT_NO_RESTRICTIONS.test(fold(message));

/** Perguntas geradas pelo servidor (nunca o texto do modelo). */
function question(field: 'RESTRICTIONS' | 'LIMIT' | 'PRIORITY', who: string | null): string {
  if (field === 'PRIORITY') return 'Vocês preferem economia ou rapidez?';
  if (field === 'RESTRICTIONS') return `${who} tem alguma alergia ou restrição alimentar? Pode confirmar?`;
  return who ? `Qual é o teto de gastos de ${who}? É um valor máximo ou só uma referência?` : 'Qual é o teto de gastos do grupo? É um valor máximo ou só uma referência?';
}

function restrictionsView(p: Participant): AgentModelInput['participants'][number]['restrictions'] {
  if (p.restrictions.state !== 'DECLARED') return p.restrictions.state;
  return p.restrictions.value.map((r) => ({ kind: r.key.kind, code: r.key.code, requirement: r.key.kind === 'ALLERGY' ? 'MANDATORY' : r.key.requirement ?? 'MANDATORY' }));
}
function limitView(d: PurchaseState['groupLimit']): AgentModelInput['groupLimit'] {
  return d.state === 'DECLARED' ? { amountCents: d.value.amountCents, kind: d.value.kind } : d.state;
}

/** Contexto do modelo por allowlist: sem linkId, purchaseId, eventId, IDs de conta, aprovações ou tokens. */
export function buildModelInput(purchase: PurchaseState | null, phase: string, message: string): AgentModelInput {
  const s = purchase && purchase.status === 'ACTIVE' ? purchase : null;
  return {
    contractVersion: '1.0',
    phase,
    participants: (s?.participants ?? []).map((p) => ({ ref: p.participantId, name: p.displayName, restrictions: restrictionsView(p), limit: limitView(p.limit) })),
    groupLimit: s ? limitView(s.groupLimit) : 'NOT_ASKED',
    priority: s ? (s.priority.state === 'DECLARED' ? s.priority.value : s.priority.state === 'UNCLEAR' ? 'UNCLEAR' : 'NOT_ASKED') : 'NOT_ASKED',
    openQuestions: missingQuestions(s),
    allowedActions: ALLOWED_ACTIONS,
    message,
  };
}

export interface Plan {
  ops: DomainOp[];
  state: PurchaseState | null;
  /** Resumo do que foi aplicado (gerado pelo servidor a partir das operações aceitas). */
  applied: string[];
  /** Pendências para o usuário: confirmações, ambiguidades e ações não aplicadas. */
  notes: string[];
  /** GRP-01: termo de busca pedido nesta mensagem (a composição roda depois, no processador). */
  suggest: string | null;
}

type Preview = (change: DomainChange) => PurchaseState | null;

/**
 * Planeja as operações a partir da proposta. `preview` é `TurnContext.previewDomain` (mesmo cálculo do commit);
 * `linkId` vem do vínculo autenticado e entra em toda pré-visualização para o resultado bater com o commit.
 */
export function planActions(
  purchase: PurchaseState | null, proposal: AgentProposal, preview: Preview, linkId: string | null, message: string,
  /** Propostas exibidas no último snapshot (GRP-01): só dá para escolher o que o usuário viu. Ausente ⇒ sem filtro. */
  visibleProposals?: ReadonlySet<string>,
): Plan {
  const ops: DomainOp[] = [];
  const applied: string[] = [];
  const notes: string[] = [];
  const change = (extra: DomainOp[]): DomainChange => ({ ops: [...ops, ...extra], ...(linkId ? { linkId } : {}) });
  let state = preview(change([])) ?? (purchase && purchase.status === 'ACTIVE' ? purchase : null);

  const tryApply = (candidate: DomainOp[], summary: string, what: string): boolean => {
    try {
      state = preview(change(candidate));
      ops.push(...candidate);
      applied.push(summary);
      return true;
    } catch (e) {
      if (!(e instanceof DomainError)) throw e;
      if (e.code === 'REQUIRES_HUMAN_CONFIRMATION') notes.push(candidate.length === 1 && candidate[0]!.op === 'REMOVE_PARTICIPANT'
        ? `${what} precisa de confirmação explícita: use Remover pessoa no menu. Nada foi alterado.` : `${what} ${CONFIRMATION}.`);
      else if (e.code === 'PARTICIPANT_LIMIT') notes.push('O limite de participantes desta compra foi atingido; ninguém novo foi adicionado.');
      else notes.push(`Não consegui aplicar: ${what.toLocaleLowerCase('pt-BR')}.`);
      return false;
    }
  };
  const resolve = (sel: ParticipantSelector): Participant | null => {
    const people = state?.participants ?? [];
    if ('ref' in sel) {
      const found = people.find((p) => p.participantId === sel.ref);
      if (!found) notes.push('Não encontrei uma das pessoas citadas nesta compra.');
      return found ?? null;
    }
    const matches = people.filter((p) => fold(p.displayName) === fold(sel.name));
    if (matches.length === 1) return matches[0]!;
    notes.push(matches.length > 1
      ? `Há mais de uma pessoa chamada ${sel.name}. De qual delas você está falando?`
      : `Não encontrei ${sel.name} nesta compra. Quer que eu adicione?`);
    return null;
  };
  const target = (t: 'GROUP' | ParticipantSelector): { id: string | 'GROUP'; label: string } | null => {
    if (t === 'GROUP') return { id: 'GROUP', label: state?.participants.length === 1 ? 'você' : 'o grupo' }; // uso individual não fala em grupo
    const p = resolve(t);
    return p ? { id: p.participantId, label: p.displayName } : null;
  };
  const money = formatCents; // formatação da DOM-01 (sem regra monetária duplicada)

  const removedNow = new Set<string>();
  let suggest: string | null = null;
  // Recusa do modelo descarta tudo: uma saída contraditória não muda o estado.
  // A escolha de proposta vem primeiro: qualquer outra alteração invalida as propostas exibidas.
  const actions = proposal.refusal ? [] : [...proposal.actions.filter((a) => a.action === 'SELECT_PROPOSAL'), ...proposal.actions.filter((a) => a.action !== 'SELECT_PROPOSAL')];
  for (const a of actions) {
    switch (a.action) {
      case 'ADD_PARTICIPANT': {
        if (removedNow.has(fold(a.name))) {
          notes.push(`${a.name} acabou de sair da compra nesta mensagem; não vou adicioná-la de novo no mesmo pedido.`);
          break;
        }
        if ((state?.participants ?? []).some((p) => fold(p.displayName) === fold(a.name))) {
          notes.push(`Já existe ${a.name} nesta compra. É outra pessoa? Se for, use um nome que diferencie.`);
          break;
        }
        tryApply([{ op: 'ADD_PARTICIPANT', displayName: a.name }], `${a.name} entrou na compra.`, `Adicionar ${a.name}`);
        break;
      }
      case 'RENAME_PARTICIPANT': {
        const p = resolve(a.participant);
        if (!p) break;
        if ((state?.participants ?? []).some((x) => x.participantId !== p.participantId && fold(x.displayName) === fold(a.name))) {
          notes.push(`Já existe ${a.name} nesta compra; escolha um nome que diferencie as duas pessoas.`);
          break;
        }
        tryApply([{ op: 'RENAME_PARTICIPANT', participantId: p.participantId, displayName: a.name }], `${p.displayName} agora se chama ${a.name}.`, `Renomear ${p.displayName}`);
        break;
      }
      case 'REMOVE_PARTICIPANT': {
        const p = resolve(a.participant);
        // Sem humanConfirmed: o domínio recusa se houver restrição obrigatória, pergunta de restrição pendente ou teto
        // rígido (D5.6), e isso vira pendência.
        if (p && tryApply([{ op: 'REMOVE_PARTICIPANT', participantId: p.participantId }], `${p.displayName} saiu da compra.`, `Remover ${p.displayName}`)) {
          removedNow.add(fold(p.displayName));
        }
        break;
      }
      case 'ADD_RESTRICTION': {
        const p = resolve(a.participant);
        if (!p) break;
        // Alergia é sempre rígida: o modelo não consegue rebaixá-la, mesmo que proponha PREFERENCE.
        const key: RestrictionKey = a.restriction.kind === 'ALLERGY'
          ? { kind: 'ALLERGY', code: a.restriction.code }
          : { kind: 'DIETARY', code: a.restriction.code, requirement: a.restriction.requirement ?? 'MANDATORY' };
        const label = key.kind === 'ALLERGY' ? `alergia a ${ptLabel(key.code)}` : `dieta ${ptLabel(key.code)} (${key.requirement === 'PREFERENCE' ? 'preferência' : 'obrigatória'})`;
        tryApply([{ op: 'ADD_RESTRICTION', participantId: p.participantId, key }], `Registrei ${label} para ${p.displayName}.`, `Registrar ${label} para ${p.displayName}`);
        break;
      }
      case 'SET_NO_RESTRICTIONS': {
        const p = resolve(a.participant);
        if (!p) break;
        if (!hasExplicitNoRestrictions(message)) {
          // Proposta do modelo sozinha não libera ninguém (nem apaga pergunta pendente): vira pergunta.
          tryApply([{ op: 'MARK_UNCLEAR', target: p.participantId, field: 'RESTRICTIONS', question: question('RESTRICTIONS', p.displayName) }],
            `Não registrei "sem restrições" para ${p.displayName}: preciso que você confirme.`, `Registrar a pergunta sobre restrições de ${p.displayName}`);
          break;
        }
        tryApply([{ op: 'SET_RESTRICTIONS', participantId: p.participantId, value: 'NONE' }], `${p.displayName} não tem restrições.`, `Remover as restrições de ${p.displayName}`);
        break;
      }
      case 'REMOVE_RESTRICTION': {
        const p = resolve(a.participant);
        // Remover restrição sempre exige confirmação humana explícita; o agente não a marca.
        if (p) notes.push(`Remover ${a.restriction.kind === 'ALLERGY' ? 'a alergia' : 'a restrição'} de ${p.displayName} ${CONFIRMATION}.`);
        break;
      }
      case 'SET_LIMIT': {
        const t = target(a.target);
        if (!t) break;
        if (a.amountCents > MAX_PLAUSIBLE_LIMIT_CENTS) {
          notes.push(`O valor de ${money(a.amountCents)} para ${t.label} parece fora do esperado. Pode confirmar o teto?`);
          break;
        }
        if (!a.kind) {
          // Ambíguo: vira pergunta (UNCLEAR). Nunca é tratado como "sem teto" (DOM-01).
          tryApply([{ op: 'MARK_UNCLEAR', target: t.id, field: 'LIMIT', question: `${money(a.amountCents)} para ${t.label} é um teto máximo ou só uma referência?` }],
            `Anotei ${money(a.amountCents)} para ${t.label}; falta confirmar se é teto máximo.`, `Registrar o valor para ${t.label}`);
          break;
        }
        tryApply([{ op: 'SET_LIMIT', target: t.id, value: { amountCents: a.amountCents, kind: a.kind } }],
          `${a.kind === 'MANDATORY' ? 'Teto máximo' : 'Valor de referência'} de ${money(a.amountCents)} para ${t.label}.`, `Mudar o teto de ${t.label}`);
        break;
      }
      case 'SET_NO_LIMIT': {
        const t = target(a.target);
        if (!t) break;
        if (!hasExplicitNoLimit(message)) {
          // Sem declaração explícita do usuário: pergunta (UNCLEAR), não remove o teto.
          tryApply([{ op: 'MARK_UNCLEAR', target: t.id, field: 'LIMIT', question: question('LIMIT', t.id === 'GROUP' ? null : t.label) }],
            `Não removi o teto de ${t.label}: preciso que você confirme.`, `Registrar a pergunta sobre o teto de ${t.label}`);
          break;
        }
        tryApply([{ op: 'SET_LIMIT', target: t.id, value: 'NONE' }], `Sem teto para ${t.label}.`, `Tirar o teto de ${t.label}`);
        break;
      }
      case 'SET_PRIORITY':
        tryApply([{ op: 'SET_PRIORITY', value: a.value }], `Prioridade: ${a.value === 'ECONOMY' ? 'economia' : 'rapidez'}.`, 'Definir a prioridade');
        break;
      case 'ASK_CLARIFICATION': {
        // O texto proposto pelo modelo é descartado: a pergunta é escolhida pelo servidor a partir de (alvo, campo).
        if (a.target === 'PURCHASE') {
          if (a.field !== 'PRIORITY') { notes.push(UNCLEAR_NOTE); break; }
          tryApply([{ op: 'MARK_UNCLEAR', target: 'PURCHASE', field: 'PRIORITY', question: question('PRIORITY', null) }], 'Pergunta registrada.', 'Registrar a pergunta');
          break;
        }
        const t = target(a.target);
        if (!t) break;
        if ((t.id === 'GROUP' && a.field !== 'LIMIT') || a.field === 'PRIORITY') { notes.push(UNCLEAR_NOTE); break; }
        tryApply([{ op: 'MARK_UNCLEAR', target: t.id, field: a.field, question: question(a.field, t.id === 'GROUP' ? null : t.label) }],
          'Pergunta registrada.', 'Registrar a pergunta');
        break;
      }
      case 'REQUEST_ORDER':
        notes.push(REVIEW_NOTE);
        break;
      case 'CLOSE_PURCHASE':
        notes.push(`${a.reason === 'CANCELLED' ? 'Cancelar' : 'Encerrar'} a compra apaga os dados dela e precisa de confirmação explícita: use Limpar perfil no menu. Nada foi alterado.`);
        break;
      case 'SUGGEST_PROPOSALS':
        suggest = a.query;
        break;
      case 'SELECT_PROPOSAL': {
        // "Sugere X e escolhe a 1" na mesma mensagem: a posição se referiria à lista ANTIGA. Não adivinhamos.
        if (proposal.actions.some((x) => x.action === 'SUGGEST_PROPOSALS')) { notes.push('Veja as novas sugestões e depois diga qual proposta quer.'); break; }
        const chosen = state?.proposals?.[a.position - 1];
        if (!chosen) { notes.push(`Não há proposta ${a.position} disponível agora. Peça sugestões de novo.`); break; }
        if (visibleProposals && !visibleProposals.has(chosen.proposalId)) {
          notes.push(`A proposta ${a.position} não foi exibida (grupo grande); peça sugestões mais específicas antes de escolher.`);
          break;
        }
        tryApply([{ op: 'SELECT_PROPOSAL', proposalId: chosen.proposalId }], `Proposta ${a.position} colocada na sacola simulada (nenhum pedido foi feito).`, `Escolher a proposta ${a.position}`);
        break;
      }
      case 'CLEAR_BAG':
        if (state?.bag) tryApply([{ op: 'CLEAR_BAG' }], 'Sacola simulada esvaziada.', 'Esvaziar a sacola');
        else notes.push('A sacola simulada já está vazia.');
        break;
    }
  }
  if (proposal.refusal) notes.push('Não posso ajudar com esse pedido. Posso registrar participantes, restrições alimentares, orçamento e prioridade.');
  return { ops, state, applied, notes: [...new Set(notes)], suggest };
}

/** Uso pode ser individual ou em grupo: perguntar antes, sem assumir grupo. */
export const NO_PARTICIPANTS_QUESTION = 'O pedido é só para você ou para um grupo? Se for em grupo, diga o nome de quem participa.';

/** Pergunta só o que falta para a compra (issue #16: "pergunta apenas o que falta"). */
export function missingQuestions(state: PurchaseState | null): string[] {
  if (!state || !state.participants.length) return [NO_PARTICIPANTS_QUESTION];
  const q: string[] = [];
  const single = state.participants.length === 1;
  for (const p of state.participants) {
    if (p.restrictions.state === 'NOT_ASKED') q.push(`${p.displayName} tem alguma alergia ou restrição alimentar?`);
  }
  if (state.groupLimit.state === 'NOT_ASKED') q.push(single ? 'Qual é o seu orçamento?' : 'Qual é o orçamento do grupo?');
  if (state.priority.state === 'NOT_ASKED') q.push(single ? 'Você prefere economia ou rapidez?' : 'Vocês preferem economia ou rapidez?');
  return [...state.clarifications.map((c) => c.question), ...q];
}
