// F3 — Validação de restrições em tri-estado (PASS | FAIL | UNKNOWN).
//
// Fontes de evidência (as únicas disponíveis no MCP — getItem não traz ingredientes/alérgenos):
//  1. SERVER_FILTER: o candidato veio de searchOffers com refinements.itemRestrictions contendo a
//     restrição (classificação do catálogo iFood).
//  2. HEURISTIC: palavras-chave em nome/descrição do item e nomes/descrições de opções.
//     Heurística só serve para encontrar violações (FAIL/aviso) — ausência de palavra-chave
//     NUNCA vira PASS.
//
// Política:
//  - Restrição OBRIGATÓRIA (MANDATORY; alergias sempre são): só PASS é elegível — FAIL e UNKNOWN bloqueiam.
//  - Alergia NUNCA resulta PASS (nem com filtro do iFood): desfechos possíveis são FAIL ou UNKNOWN.
//  - PREFERÊNCIA (PREFERENCE; só restrições alimentares): nunca bloqueia; FAIL/UNKNOWN viram aviso.
//  - Heurística textual nunca comprova segurança (nunca gera PASS).
//  - Conflito entre o filtro do iFood e o texto do item ⇒ UNKNOWN (não concluir).
//  - Para alergias, a classificação do iFood cobre o item-base, não as opções (ver eligibility).
// Função pura.

import { val } from './fields.js';
import type { NormalizedItemDetail, NormalizedOption, NormalizedOptionGroup } from './normalize.js';
import type { ItemRestriction } from '../mcp/types.js';

export const DIETARY = ['VEGAN', 'VEGETARIAN', 'LACTOSE_FREE', 'GLUTEN_FREE', 'NO_PORK', 'SUGAR_FREE', 'ORGANIC'] as const;
export type Dietary = (typeof DIETARY)[number];

export const ALLERGENS = ['GLUTEN', 'MILK', 'EGG', 'PEANUT', 'TREE_NUTS', 'SOY', 'FISH', 'SEAFOOD'] as const;
export type Allergen = (typeof ALLERGENS)[number];

export type Requirement = 'MANDATORY' | 'PREFERENCE';
/** `requirement` omitido = MANDATORY. Alergia não aceita PREFERENCE. */
export type RestrictionKey =
  | { kind: 'DIETARY'; code: Dietary; requirement?: Requirement }
  | { kind: 'ALLERGY'; code: Allergen; requirement?: 'MANDATORY' };

export function requirementOf(r: RestrictionKey): Requirement {
  if (r.kind === 'ALLERGY') {
    if ((r as { requirement?: string }).requirement === 'PREFERENCE') throw new Error('Alergia não pode ser preferência');
    return 'MANDATORY';
  }
  return r.requirement ?? 'MANDATORY';
}
export type TriState = 'PASS' | 'FAIL' | 'UNKNOWN';
export type EvidenceSource =
  | 'SERVER_FILTER'
  | 'SERVER_FILTER_IMPLIED'
  /** Alergia: o item veio do filtro do iFood, mas isso não comprova segurança (nunca gera PASS). */
  | 'SERVER_FILTER_INSUFFICIENT'
  | 'HEURISTIC'
  | 'CONFLICT'
  | 'NO_DATA';

export interface KeywordHit {
  term: string;
  where: 'ITEM_NAME' | 'ITEM_DESCRIPTION' | 'OPTION';
  optionId?: string;
  optionGroupId?: string;
  text: string;
}

export interface RestrictionCheck {
  restriction: RestrictionKey;
  requirement: Requirement;
  status: TriState;
  source: EvidenceSource;
  /** true quando o status depende de heurística textual (UI deve rotular como tal). */
  heuristic: boolean;
  /** MANDATORY sem PASS bloqueia: ausência de dado não comprova adequação. */
  blocking: boolean;
  /** A evidência (filtro do iFood) se refere ao item-base; opções nunca são verificadas por ela. */
  coversOptions: false;
  hits: KeywordHit[];
  /** Opções que violam a restrição (heurística) e não devem ser escolhidas. */
  blockedOptionIds: string[];
  reasons: string[];
}

// ---------- mapeamentos para o filtro server-side (enum observado em tools-list.json) ----------

const DIETARY_TO_SERVER: Partial<Record<Dietary, ItemRestriction>> = {
  VEGAN: 'VEGAN',
  VEGETARIAN: 'VEGETARIAN',
  LACTOSE_FREE: 'LAC_FREE',
  GLUTEN_FREE: 'GLUTEN_FREE',
  SUGAR_FREE: 'SUGAR_FREE',
  ORGANIC: 'ORGANIC',
};

/** Implicações lógicas apenas para restrições alimentares (não para alergias). */
const DIETARY_IMPLIED_BY: Partial<Record<Dietary, ItemRestriction[]>> = {
  VEGETARIAN: ['VEGAN'],
  LACTOSE_FREE: ['VEGAN'],
  NO_PORK: ['VEGAN', 'VEGETARIAN'],
};

/**
 * Filtro do iFood usado só para ESTREITAR a busca em caso de alergia. Nunca comprova segurança: a classificação
 * do catálogo não informa contaminação cruzada nem cobre opções ⇒ alergia nunca resulta PASS (issue #3).
 * LAC_FREE NÃO cobre alergia à proteína do leite, por isso nem é usado para MILK.
 */
const ALLERGY_TO_SERVER: Partial<Record<Allergen, ItemRestriction>> = { GLUTEN: 'GLUTEN_FREE' };

/** Filtros server-side a enviar em searchOffers.refinements.itemRestrictions para as restrições pedidas. */
export function serverFiltersFor(restrictions: RestrictionKey[]): ItemRestriction[] {
  const out = new Set<ItemRestriction>();
  for (const r of restrictions) {
    if (requirementOf(r) !== 'MANDATORY') continue; // preferência nunca vira filtro obrigatório de busca
    const f = r.kind === 'DIETARY' ? DIETARY_TO_SERVER[r.code] : ALLERGY_TO_SERVER[r.code];
    if (f) out.add(f);
  }
  return [...out];
}

// ---------- heurística textual ----------

const MEAT = [
  'carne', 'carnes', 'frango', 'bacon', 'calabresa', 'presunto', 'peito de peru', 'pepperoni', 'linguica', 'costela',
  'costelinha', 'picanha', 'file mignon', 'alcatra', 'fraldinha', 'cupim', 'carne seca', 'charque', 'lombo', 'pernil',
  'salame', 'mortadela', 'parma', 'nuggets', 'porco', 'suino', 'bovino', 'cordeiro', 'kafta', 'peixe', 'atum', 'salmao',
  'camarao', 'bacalhau', 'tilapia', 'sardinha', 'anchova', 'frutos do mar', 'lula', 'polvo', 'kani',
];
const DAIRY = [
  'queijo', 'queijos', 'mucarela', 'mussarela', 'muzzarella', 'catupiry', 'cheddar', 'parmesao', 'requeijao', 'provolone',
  'gorgonzola', 'cream cheese', 'ricota', 'leite', 'creme de leite', 'leite condensado', 'manteiga', 'nata', 'iogurte',
  'chantilly', 'sorvete', 'sour cream', 'brigadeiro', 'whey',
];
const EGG = ['ovo', 'ovos', 'gema', 'maionese', 'omelete', 'merengue', 'suspiro'];
const PORK = [
  'bacon', 'calabresa', 'presunto', 'pernil', 'lombo', 'linguica', 'salame', 'pepperoni', 'torresmo', 'porco', 'suino',
  'parma', 'mortadela', 'costelinha', 'panceta', 'copa lombo',
];
const GLUTEN = [
  'pao', 'paes', 'massa', 'trigo', 'farinha', 'macarrao', 'pizza', 'pizzas', 'empanado', 'empanada', 'cerveja', 'biscoito',
  'bolacha', 'bolo', 'lasanha', 'esfiha', 'esfirra', 'coxinha', 'pastel', 'panqueca', 'crepe', 'wrap', 'croissant',
  'torrada', 'crouton', 'granola', 'aveia', 'cevada', 'centeio', 'malte', 'nhoque', 'talharim', 'espaguete', 'penne',
  'kibe', 'quibe', 'tabule', 'panko', 'brioche',
];
const PEANUT = ['amendoim', 'pacoca'];
const TREE_NUTS = ['castanha', 'castanhas', 'nozes', 'noz', 'amendoa', 'amendoas', 'avela', 'nutella', 'pistache', 'macadamia', 'pecan'];
const SOY = ['soja', 'shoyu', 'tofu', 'misso', 'edamame'];
const FISH = ['peixe', 'atum', 'salmao', 'bacalhau', 'tilapia', 'sardinha', 'anchova', 'merluza', 'pescada', 'sashimi'];
const SEAFOOD = ['camarao', 'lula', 'polvo', 'marisco', 'mexilhao', 'ostra', 'lagosta', 'siri', 'caranguejo', 'kani', 'frutos do mar', 'vieira'];
const SUGAR = ['acucar', 'leite condensado', 'calda', 'brigadeiro', 'mel'];

const VEG_MARKERS = ['vegano', 'vegana', 'veganos', 'veganas', 'vegetal', 'vegetariano', 'vegetariana', 'veg', 'plant based', 'de soja'];

interface Rule {
  terms: string[];
  /** Marcadores que, logo após o termo (até 3 palavras), indicam versão que não viola (ex.: "muçarela vegana"). */
  markersAfter: string[];
}

function rule(terms: string[], markersAfter: string[] = []): Rule {
  return { terms, markersAfter };
}

/** Regras por restrição. ORGANIC não tem heurística (ausência de termo não prova nada). */
export const RULES: Record<string, Rule | null> = {
  'DIETARY:VEGAN': rule([...MEAT, ...DAIRY, ...EGG, 'mel'], VEG_MARKERS),
  'DIETARY:VEGETARIAN': rule(MEAT, VEG_MARKERS),
  'DIETARY:LACTOSE_FREE': rule(DAIRY, [...VEG_MARKERS, 'sem lactose', 'zero lactose', 'de mandioca', 'de castanha']),
  'DIETARY:GLUTEN_FREE': rule(GLUTEN, ['sem gluten', 'gluten free', 'de queijo', 'de mandioca', 'de arroz', 'de tapioca']),
  'DIETARY:NO_PORK': rule(PORK, [...VEG_MARKERS, 'de frango', 'de peru', 'bovino', 'bovina']),
  'DIETARY:SUGAR_FREE': rule(SUGAR, ['zero', 'diet', 'sem acucar']),
  'DIETARY:ORGANIC': null,
  'ALLERGY:GLUTEN': rule(GLUTEN, ['sem gluten', 'gluten free', 'de queijo', 'de mandioca', 'de arroz', 'de tapioca']),
  'ALLERGY:MILK': rule(DAIRY, VEG_MARKERS),
  'ALLERGY:EGG': rule(EGG, VEG_MARKERS),
  'ALLERGY:PEANUT': rule(PEANUT),
  'ALLERGY:TREE_NUTS': rule(TREE_NUTS),
  'ALLERGY:SOY': rule(SOY),
  'ALLERGY:FISH': rule(FISH, VEG_MARKERS),
  'ALLERGY:SEAFOOD': rule(SEAFOOD, VEG_MARKERS),
};

const NEGATIONS_BEFORE = ['sem', 'zero', 'nao contem', 'livre de'];

/**
 * As palavras imediatamente anteriores a um termo terminam com uma negação?
 * Só o marcador colado ao termo nega: "sem bacon" nega "bacon", mas "sem gluten e bacon" NÃO nega "bacon".
 * Reutilizado pela heurística de restrições (findTerms) e pela detecção de preferências (findTermMention).
 */
export function negatedContext(before: string): boolean {
  const words = before.split(' ').filter(Boolean);
  if (!words.length) return false;
  return NEGATIONS_BEFORE.some((n) => {
    const nw = n.split(' ');
    return words.length >= nw.length && words.slice(words.length - nw.length).join(' ') === n;
  });
}

/** minúsculas, sem acentos, só [a-z0-9 ]. */
export function normalizeText(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Termos da regra que aparecem no texto, desconsiderando "sem X" e "X vegano" etc. */
export function findTerms(text: string, r: Rule): string[] {
  const words = normalizeText(text).split(' ').filter(Boolean);
  const found = new Set<string>();
  for (const term of r.terms) {
    const tw = term.split(' ');
    for (let i = 0; i + tw.length <= words.length; i++) {
      if (!tw.every((w, k) => words[i + k] === w)) continue;
      const before = words.slice(Math.max(0, i - 2), i).join(' ');
      const after = words.slice(i + tw.length, i + tw.length + 3).join(' ');
      const negated = negatedContext(before);
      const marked = r.markersAfter.some((m) => ` ${after} `.includes(` ${m} `));
      if (!negated && !marked) found.add(term);
    }
  }
  return [...found];
}

export interface TermMention {
  /** O termo aparece no texto (qualquer polaridade). */
  mentioned: boolean;
  /** Aparece ao menos uma vez SEM negação — presença afirmada. */
  asserted: boolean;
}

/**
 * Menções de um termo livre (texto de preferência do usuário) em um texto qualquer.
 * Reaproveita normalização e detecção de negações das regras de restrição ("sem bacon", "zero açúcar",
 * "livre de lactose" NÃO são presença). Fronteira de palavra: "baconhouse" não casa com "bacon".
 * Heurística de texto: serve só para pontuar preferência, nunca para concluir segurança.
 */
export function findTermMention(text: string, term: string): TermMention {
  const tw = normalizeText(term).split(' ').filter(Boolean);
  if (!tw.length) return { mentioned: false, asserted: false };
  const words = normalizeText(text).split(' ').filter(Boolean);
  let mentioned = false;
  let asserted = false;
  for (let i = 0; i + tw.length <= words.length; i++) {
    if (!tw.every((w, k) => words[i + k] === w)) continue;
    mentioned = true;
    if (!negatedContext(words.slice(Math.max(0, i - 2), i).join(' '))) asserted = true;
  }
  return { mentioned, asserted };
}

// ---------- avaliação ----------

export interface EvaluationInput {
  detail: NormalizedItemDetail;
  /** itemRestrictions do searchOffers que retornou este candidato. */
  serverFilters: ItemRestriction[];
}

const label = (r: RestrictionKey) => `${r.kind}:${r.code}`;

function serverEvidence(r: RestrictionKey, filters: ItemRestriction[]): EvidenceSource | null {
  if (r.kind === 'ALLERGY') {
    const f = ALLERGY_TO_SERVER[r.code];
    return f && filters.includes(f) ? 'SERVER_FILTER' : null;
  }
  const direct = DIETARY_TO_SERVER[r.code];
  if (direct && filters.includes(direct)) return 'SERVER_FILTER';
  if ((DIETARY_IMPLIED_BY[r.code] ?? []).some((f) => filters.includes(f))) return 'SERVER_FILTER_IMPLIED';
  return null;
}

const optionText = (o: NormalizedOption) => `${val(o.name) ?? ''} ${val(o.description) ?? ''}`.trim();

export function evaluateRestriction(r: RestrictionKey, input: EvaluationInput): RestrictionCheck {
  const { detail } = input;
  const requirement = requirementOf(r);
  const ruleDef = RULES[label(r)] ?? null;
  const evidence = serverEvidence(r, input.serverFilters);
  const hits: KeywordHit[] = [];
  const reasons: string[] = [];
  const blockedOptionIds: string[] = [];
  const groups: NormalizedOptionGroup[] = val(detail.optionGroups) ?? [];
  const impossibleGroups: string[] = [];

  if (ruleDef) {
    const name = val(detail.itemName) ?? '';
    const desc = val(detail.itemDescription) ?? '';
    for (const term of findTerms(name, ruleDef)) hits.push({ term, where: 'ITEM_NAME', text: name });
    for (const term of findTerms(desc, ruleDef)) hits.push({ term, where: 'ITEM_DESCRIPTION', text: desc });
    for (const g of groups) {
      let compliant = 0;
      for (const o of g.options) {
        const t = optionText(o);
        const terms = findTerms(t, ruleDef);
        if (terms.length) {
          blockedOptionIds.push(o.optionId);
          for (const term of terms) hits.push({ term, where: 'OPTION', optionId: o.optionId, optionGroupId: g.optionGroupId, text: t });
        } else compliant++;
      }
      const min = val(g.minSelections);
      if (min !== undefined && min >= 1 && compliant < min) impossibleGroups.push(val(g.name) ?? g.optionGroupId);
    }
  }

  const nameHits = hits.filter((h) => h.where === 'ITEM_NAME');
  const descHits = hits.filter((h) => h.where === 'ITEM_DESCRIPTION');
  const optionHits = hits.filter((h) => h.where === 'OPTION');
  const termsOf = (hs: KeywordHit[]) => [...new Set(hs.map((h) => h.term))].join(', ');
  const strongHit = nameHits.length > 0 || impossibleGroups.length > 0;

  let status: TriState;
  let source: EvidenceSource;
  if (r.kind === 'ALLERGY') {
    // Alergia: só há dois desfechos possíveis — FAIL (heurística encontrou o alérgeno) ou UNKNOWN. Nunca PASS.
    // Alérgeno citado na descrição também é conflito; ausência de menção continua UNKNOWN, não PASS.
    if (strongHit || descHits.length) {
      if (nameHits.length) reasons.push(`nome do item menciona: ${termsOf(nameHits)} (heurística)`);
      if (descHits.length) reasons.push(`descrição menciona: ${termsOf(descHits)} (heurística)`);
      if (impossibleGroups.length) reasons.push(`grupo obrigatório sem opção compatível: ${impossibleGroups.join(', ')} (heurística)`);
      status = 'FAIL';
      source = 'HEURISTIC';
    } else {
      status = 'UNKNOWN';
      if (evidence) {
        source = 'SERVER_FILTER_INSUFFICIENT';
        reasons.push(
          'o item aparece no filtro do iFood, mas essa classificação não comprova segurança para alergia ' +
            '(contaminação cruzada e opções não são informadas) — confirme com a loja',
        );
      } else {
        source = 'NO_DATA';
        reasons.push('informação indisponível — verifique com a loja');
      }
    }
  } else if (strongHit) {
    if (nameHits.length) reasons.push(`nome do item menciona: ${termsOf(nameHits)} (heurística)`);
    if (impossibleGroups.length) reasons.push(`grupo obrigatório sem opção compatível: ${impossibleGroups.join(', ')} (heurística)`);
    if (evidence) {
      status = 'UNKNOWN';
      source = 'CONFLICT';
      reasons.push('conflito com a classificação do iFood — não é possível concluir');
    } else {
      status = 'FAIL';
      source = 'HEURISTIC';
    }
  } else if (evidence) {
    if (descHits.length) {
      status = 'UNKNOWN';
      source = 'CONFLICT';
      reasons.push(`classificado pelo iFood, mas a descrição menciona: ${termsOf(descHits)} (heurística) — não é possível concluir`);
    } else {
      status = 'PASS';
      source = evidence;
      reasons.push(
        evidence === 'SERVER_FILTER'
          ? 'classificação do catálogo iFood (filtro de busca) para o item-base'
          : 'implicado pela classificação do catálogo iFood (ex.: vegano ⇒ vegetariano)',
      );
    }
  } else {
    status = 'UNKNOWN';
    source = 'NO_DATA';
    reasons.push('informação indisponível — verifique com a loja');
    if (descHits.length) reasons.push(`descrição menciona: ${termsOf(descHits)} (heurística; pode listar opções)`);
  }
  if (optionHits.length && status !== 'FAIL') reasons.push(`evitar opções: ${termsOf(optionHits)} (heurística)`);

  const blocking = requirement === 'MANDATORY' && status !== 'PASS';
  return {
    restriction: r,
    requirement,
    status,
    source,
    heuristic: hits.length > 0 || source === 'HEURISTIC',
    blocking,
    coversOptions: false,
    hits,
    blockedOptionIds: [...new Set(blockedOptionIds)],
    reasons,
  };
}

export function evaluateRestrictions(restrictions: RestrictionKey[], input: EvaluationInput): RestrictionCheck[] {
  return restrictions.map((r) => evaluateRestriction(r, input));
}

/** União dos optionIds proibidos por restrições OBRIGATÓRIAS (preferência nunca proíbe opção). */
export function blockedOptions(checks: RestrictionCheck[]): Set<string> {
  return new Set(checks.filter((c) => c.requirement === 'MANDATORY').flatMap((c) => c.blockedOptionIds));
}

/** Opções indesejadas apenas por PREFERENCE: desempregam na configuração, nunca invalidam. */
export function preferenceAvoidedOptions(checks: RestrictionCheck[]): Set<string> {
  return new Set(checks.filter((c) => c.requirement === 'PREFERENCE').flatMap((c) => c.blockedOptionIds));
}
