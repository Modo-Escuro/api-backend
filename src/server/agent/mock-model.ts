// Modelo determinístico baseado em regras (português), para testes e ensaios locais sem provedor (AI-01 pendente).
// Não é instalado em produção. Implementa a mesma interface de provedor e só devolve ações do vocabulário fechado;
// por construção ignora pedidos de aprovar, confirmar ou trocar vínculo contidos na mensagem.
import type { AgentAction, AgentProposal, ConversationModel, ModelRequest } from './model.js';

const ALLERGENS: [RegExp, string][] = [
  [/amendoim/, 'PEANUT'], [/leite/, 'MILK'], [/ovo/, 'EGG'], [/gl[uú]ten/, 'GLUTEN'], [/castanha|noz|nozes/, 'TREE_NUTS'],
  [/soja/, 'SOY'], [/peixe/, 'FISH'], [/camar[aã]o|frutos do mar/, 'SEAFOOD'],
];
const NAME = '([A-ZÀ-Ú][a-zà-ú]+)';

/** "180", "180,50", "1.200,00" → centavos. */
function toCents(raw: string): number | null {
  const m = raw.replace(/\./g, '').match(/^(\d{1,9})(?:,(\d{1,2}))?$/);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? '0').padEnd(2, '0'));
}
const names = (list: string) => list.split(/,|\se\s/).map((s) => s.trim()).filter((s) => /^[A-ZÀ-Ú][a-zà-ú]+$/.test(s));

export function interpret(message: string): AgentProposal {
  const actions: AgentAction[] = [];
  const sentences = message.split(/[.;!\n]+/).map((s) => s.trim()).filter(Boolean);
  for (const s of sentences) {
    const low = s.toLocaleLowerCase('pt-BR');
    let m: RegExpMatchArray | null;
    if ((m = s.match(/\b(?:[Ss]omos|[Pp]articipantes:?|[Vv]amos ser)\s+(.+)/))) {
      for (const name of names(m[1]!)) actions.push({ action: 'ADD_PARTICIPANT', name });
      continue;
    }
    if ((m = s.match(new RegExp(`\\b(?:[Aa]diciona|[Aa]dicione|[Ii]nclui|[Ii]nclua)\\s+(?:a |o )?${NAME}`)))) {
      actions.push({ action: 'ADD_PARTICIPANT', name: m[1]! });
      continue;
    }
    if ((m = s.match(new RegExp(`\\b(?:[Rr]emove|[Tt]ira)\\s+(?:a |o )?${NAME}\\s+(?:da compra|do pedido)`)))) {
      actions.push({ action: 'REMOVE_PARTICIPANT', participant: { name: m[1]! } });
      continue;
    }
    if ((m = s.match(new RegExp(`\\b(?:[Tt]ira|[Rr]emove|[Rr]etire)\\s+a alergia (?:da|do|de)\\s+${NAME}`)))) {
      const code = ALLERGENS.find(([re]) => re.test(low))?.[1] ?? 'PEANUT';
      actions.push({ action: 'REMOVE_RESTRICTION', participant: { name: m[1]! }, restriction: { kind: 'ALLERGY', code } });
      continue;
    }
    if ((m = s.match(new RegExp(`${NAME}\\s+n[aã]o tem (?:nenhuma )?restri`)))) {
      actions.push({ action: 'SET_NO_RESTRICTIONS', participant: { name: m[1]! } });
      continue;
    }
    if ((m = s.match(new RegExp(`${NAME}\\s+(?:é|e)\\s+al[eé]rgic[oa]`)))) {
      for (const [re, code] of ALLERGENS) {
        if (re.test(low)) actions.push({ action: 'ADD_RESTRICTION', participant: { name: m[1]! }, restriction: { kind: 'ALLERGY', code: code as 'PEANUT' } });
      }
      continue;
    }
    if ((m = s.match(new RegExp(`${NAME}\\s+prefere\\s+(?:comida\\s+)?(vegan|vegetarian)`, 'i')))) {
      actions.push({ action: 'ADD_RESTRICTION', participant: { name: m[1]! }, restriction: { kind: 'DIETARY', code: /vegan/i.test(m[2]!) ? 'VEGAN' : 'VEGETARIAN', requirement: 'PREFERENCE' } });
      continue;
    }
    if ((m = s.match(new RegExp(`${NAME}\\s+(?:é|e)\\s+(vegan[oa]|vegetarian[oa])`)))) {
      actions.push({ action: 'ADD_RESTRICTION', participant: { name: m[1]! }, restriction: { kind: 'DIETARY', code: /vegan/.test(m[2]!) ? 'VEGAN' : 'VEGETARIAN', requirement: 'MANDATORY' } });
      continue;
    }
    if (/sem (?:teto|limite)/.test(low)) { actions.push({ action: 'SET_NO_LIMIT', target: 'GROUP' }); continue; }
    if ((m = s.match(/R\$\s*([\d.,]+)/))) {
      const amountCents = toCents(m[1]!);
      const who = s.match(new RegExp(`(?:para|pra)\\s+(?:a |o )?${NAME}`));
      const target = who ? { name: who[1]! } : 'GROUP' as const;
      if (amountCents === null) continue;
      if (/talvez|n[aã]o sei/.test(low)) {
        actions.push({ action: 'ASK_CLARIFICATION', target, field: 'LIMIT', question: `O teto de R$ ${m[1]} está confirmado?` });
      } else if (/no m[aá]ximo|at[eé]\s+r\$|teto|limite|or[cç]amento/.test(low)) {
        actions.push({ action: 'SET_LIMIT', target, amountCents, kind: 'MANDATORY' });
      } else if (/\buns\b|cerca de|por volta|mais ou menos|aproximad/.test(low)) {
        actions.push({ action: 'SET_LIMIT', target, amountCents, kind: 'PREFERENCE' });
      } else {
        actions.push({ action: 'SET_LIMIT', target, amountCents }); // sem marcador: o servidor pergunta
      }
    }
    if (/mais barat|econom/.test(low)) actions.push({ action: 'SET_PRIORITY', value: 'ECONOMY' });
    else if (/mais r[aá]pid|rapidez|urgente/.test(low)) actions.push({ action: 'SET_PRIORITY', value: 'SPEED' });
    if (/pode pedir|faz o pedido|fecha o pedido|finaliza o pedido/.test(low)) actions.push({ action: 'REQUEST_ORDER' });
    if ((m = low.match(/(?:sugere|sugira|sugest[oõ]es de|op[cç][oõ]es de|procura|busca)\s+([a-zà-ú ]{2,40})/))) actions.push({ action: 'SUGGEST_PROPOSALS', query: m[1]!.trim() });
    if ((m = low.match(/(?:quero|escolho|fico com|pode ser)\s+(?:a\s+)?(?:proposta|op[cç][aã]o)\s+([1-4])\b/))) actions.push({ action: 'SELECT_PROPOSAL', position: Number(m[1]) });
    if (/(?:esvazia|limpa|zera)\s+a sacola/.test(low)) actions.push({ action: 'CLEAR_BAG' });
    if (/cancela(?:r)? a compra/.test(low)) actions.push({ action: 'CLOSE_PURCHASE', reason: 'CANCELLED' });
    else if (/encerra(?:r)? a compra/.test(low)) actions.push({ action: 'CLOSE_PURCHASE', reason: 'CLOSED' });
  }
  return { actions: actions.slice(0, 20) };
}

export class DeterministicModel implements ConversationModel {
  readonly id = 'deterministic-rules-v1';
  async propose(request: ModelRequest): Promise<unknown> {
    if (request.signal.aborted) throw new Error('aborted');
    return interpret(request.input.message);
  }
}
