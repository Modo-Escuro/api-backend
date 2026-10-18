// Respostas fechadas a perguntas do servidor; nunca inferir ausência de restrições sem contexto.
import type { Snapshot } from '../contracts/conversation.js';
import type { DomainOp, PurchaseState } from '../domain/purchase.js';
import type { AgentProposal } from './model.js';
import { missingQuestions } from './policy.js';

/** Uma negativa responde apenas à pergunta canônica atualmente exibida. */
export function restrictionQuestionTarget(state: PurchaseState | null, snapshot: Snapshot) {
  if (!state || state.status !== 'ACTIVE' || snapshot.phase !== 'COLLECTING') return null;
  const questions = missingQuestions(state);
  if (JSON.stringify(snapshot.pending) !== JSON.stringify(questions)) return null;
  const person = state.participants.find(p => {
    const question = `${p.displayName} tem alguma alergia ou restrição alimentar?`;
    if (p.restrictions.state === 'NOT_ASKED') return questions[0] === question && !state.clarifications.length;
    return p.restrictions.state === 'UNCLEAR' && questions[0] === `${question} Pode confirmar?`
      && state.clarifications.length === 1
      && state.clarifications[0]?.target === p.participantId
      && state.clarifications[0]?.field === 'RESTRICTIONS'
      && state.clarifications[0]?.clarificationId === p.restrictions.clarificationId;
  });
  if (!person || state.participants.filter(p => p.displayName === person.displayName).length !== 1) return null;
  const expected = person.restrictions.state === 'NOT_ASKED' ? 'Restrições: não informadas' : 'Restrições: a confirmar';
  const group = snapshot.blocks.find(b => b.kind === 'GROUP');
  if (!group?.participants.some(p => p.participantRef === person.participantId
    && p.displayName === person.displayName && p.conditions.includes(expected)
    && !p.conditions.some(c => c.startsWith('Alergia:') || c.startsWith('Dieta:')))) return null;
  return person;
}

const fold = (v: string) => v.normalize('NFD').replace(/\p{M}/gu, '').trim().toLowerCase();

/**
 * Confirmações humanas explícitas (botões do bot após pergunta de confirmação). Texto literal do usuário, nunca do
 * modelo: o modelo não tem ação equivalente. Apagar usa END (D7 exclui a compra na mesma transação).
 */
export function humanCommand(state: PurchaseState | null, message: string): { ops: DomainOp[]; note: string } | null {
  const text = fold(message);
  if (/^confirmo: apagar todos os dados deste pedido[.!]?$/.test(text)) {
    if (!state || state.status !== 'ACTIVE') return { ops: [], note: 'Não há dados de pedido salvos para apagar.' };
    return { ops: [{ op: 'END', reason: 'CANCELLED' }], note: 'Pedido apagado: pessoas, restrições, orçamento e propostas foram excluídos.' };
  }
  const m = /^confirmo: remover (.+) do pedido[.!]?$/.exec(text);
  if (m) {
    const found = state && state.status === 'ACTIVE' ? state.participants.filter(p => fold(p.displayName) === m[1]!.trim()) : [];
    if (found.length !== 1) return { ops: [], note: 'Não encontrei essa pessoa neste pedido; nada foi alterado.' };
    const p = found[0]!;
    return { ops: [{ op: 'REMOVE_PARTICIPANT', participantId: p.participantId, humanConfirmed: true }],
      note: `${p.displayName} foi removida do pedido, junto com as restrições e o teto dela.` };
  }
  return null;
}

export function shortReply(state: PurchaseState | null, snapshot: Snapshot, message: string):
  { proposal: AgentProposal; policyMessage: string; note?: string; human?: { ops: DomainOp[]; note: string } } | null {
  const human = humanCommand(state, message);
  if (human) return { proposal: { actions: [] }, policyMessage: message, human };
  const text = message.normalize('NFD').replace(/\p{M}/gu, '').trim().toLowerCase();
  const reply = (note: string) => ({ proposal: { actions: [] }, policyMessage: message, note });
  const newQuery = /^(?:troca|troque|muda|mude) (?:por|para) (.{1,80}?)[.!]?$/iu.exec(message.trim());
  if (newQuery) return { proposal: { actions: [{ action: 'SUGGEST_PROPOSALS', query: newQuery[1]! }] }, policyMessage: message };
  if (/^(oi|ola|bom dia|boa tarde|boa noite|vamos comecar)[!.?]*$/.test(text)) {
    return reply(state?.searchQuery ? `Vamos continuar a busca por ${state.searchQuery}.` : 'O que vocês querem comer? Pode me contar também quem participa e as restrições alimentares.');
  }
  if (/^(mudar (?:a )?busca|continuar escolhendo)$/.test(text)) return reply('O que vocês querem comer agora? Vou manter o grupo, as restrições e o orçamento.');
  if (/^(?:somos|agora somos) (?:so |apenas )?(?:\d+|dois|duas|tres|quatro)[.!]?$/.test(text) && state?.participants.length) {
    return reply('Quem continua no grupo? Diga os nomes para eu não retirar a pessoa errada.');
  }
  const selection = /^(?:(?:quero|escolho|prefiro|vou de) )?(?:(?:a |o )?(?:(?:opcao|proposta) )?)([1-4]|primeira|primeiro|segunda|segundo|terceira|terceiro|quarta|quarto)[.!]?$/.exec(text);
  if (selection) {
    if (/^[1-4][.!]?$/.test(text) && !snapshot.blocks.some(b => b.kind === 'PROPOSAL')) return null;
    const positions: Record<string, number> = { primeira: 1, primeiro: 1, segunda: 2, segundo: 2, terceira: 3, terceiro: 3, quarta: 4, quarto: 4 };
    const position = positions[selection[1]!] ?? Number(selection[1]);
    const selected = state?.proposals?.[position - 1];
    if (!selected || !snapshot.blocks.some(b => b.kind === 'PROPOSAL' && b.proposalRef === selected.proposalId)) return reply('Essa opção não está disponível na lista atual. Peça novas sugestões.');
    return { proposal: { actions: [{ action: 'SELECT_PROPOSAL', position }] }, policyMessage: message };
  }
  if (/^(essa|esse|quero essa|quero esse)[.!]?$/.test(text)) {
    const shown = snapshot.blocks.filter(b => b.kind === 'PROPOSAL');
    if (shown.length !== 1) return reply('Qual opção você quer? Pode tocar no botão ou dizer o número.');
    const index = state?.proposals?.findIndex(p => p.proposalId === shown[0]!.proposalRef) ?? -1;
    if (index >= 0) return { proposal: { actions: [{ action: 'SELECT_PROPOSAL', position: index + 1 }] }, policyMessage: message };
  }
  if (/^(?:tem (?:uma |algo )?)?(?:mais barat[ao]|ver outras|buscar novamente)[?!.]?$/.test(text)) {
    if (!state?.searchQuery) return reply('Que tipo de comida você quer buscar?');
    return { proposal: { actions: [...(/barat/.test(text) ? [{ action: 'SET_PRIORITY' as const, value: 'ECONOMY' as const }] : []),
      { action: 'SUGGEST_PROPOSALS', query: state.searchQuery }] }, policyMessage: message,
      note: 'Vou consultar as opções de novo, mantendo as restrições e o orçamento. Algumas opções podem se repetir.' };
  }
  if (/^(?:qual (?:e |a |e a )?mais barata|comparar (?:as )?opcoes)[?!.]?$/.test(text)) {
    if (!snapshot.blocks.some(b => b.kind === 'PROPOSAL')) return reply('Vamos buscar opções para comparar. Que tipo de comida você quer?');
    return reply('Compare a soma dos preços observados e a entrega de cada opção abaixo. O total final ainda depende das taxas do carrinho; não posso garantir qual será a mais barata no fechamento.');
  }
  // Escolha do início da conversa (botões do bot). Individual cria uma única pessoa "Você", sem modelo.
  if (/^e um pedido individual, so para mim[.!]?$/.test(text)) {
    if (state && state.status === 'ACTIVE' && state.participants.length) return null; // já há pessoas: o modelo decide
    return { proposal: { actions: [{ action: 'ADD_PARTICIPANT', name: 'Você' }] }, policyMessage: message };
  }
  // Grupo: nenhuma ação; o servidor pergunta quem participa.
  if (/^e um pedido em grupo[.!]?$/.test(text) && !(state && state.status === 'ACTIVE' && state.participants.length))
    return { proposal: { actions: [] }, policyMessage: message };
  // Comando humano exato: limpa só a composição local, nunca o carrinho remoto.
  if (/^(?:esvaziar|esvazia|limpar|limpa) (?:a )?sacola(?: simulada)?[.!]?$/.test(text)) {
    return { proposal: { actions: [{ action: 'CLEAR_BAG' }] }, policyMessage: message };
  }
  if (!/^(?:nao|nenhuma|nao tenho(?: (?:nenhuma )?(?:restricao|restricoes|alergia|alergias))?|sem restricoes)[.!]?$/.test(text)) return null;
  const person = restrictionQuestionTarget(state, snapshot);
  if (!person) return null;
  // DECLARED nunca é alvo: nenhuma alergia/dieta existente pode ser apagada aqui.
  return { proposal: { actions: [{ action: 'SET_NO_RESTRICTIONS', participant: { ref: person.participantId } }] },
    policyMessage: `${person.displayName} sem restrições` };
}
