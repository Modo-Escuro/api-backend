// F3 — Validação de configuração do item (optionGroups: minSelections/maxSelections).
// Seleções só podem referenciar optionIds retornados pelo getItem (nunca inventados).
// Função pura.

import { val } from './fields.js';
import { indexOptions, type NormalizedItemDetail, type NormalizedOption } from './normalize.js';

// Quantidades de opção — o que é e o que não é conhecido:
//  - addItemToCart (schema em tools-list.json) aceita options[].quantity ("almost always 1"): repetir existe no modelo.
//  - getItem NÃO expõe limite por opção nem se min/maxSelections contam opções distintas ou unidades.
//  ⇒ quantity omitida = 1 (uma seleção). quantity > 1 nunca gera VALID: no máximo UNKNOWN.
export interface OptionSelection {
  optionId: string;
  quantity?: number;
}

export type ConfigStatus = 'VALID' | 'INVALID' | 'UNKNOWN';

export interface ConfigIssue {
  code:
    | 'UNKNOWN_OPTION'
    | 'INVALID_QUANTITY'
    | 'BELOW_MIN'
    | 'ABOVE_MAX'
    | 'LIMITS_UNKNOWN'
    | 'OPTIONS_UNKNOWN'
    | 'BLOCKED_OPTION'
    /** Incompatível só com PREFERENCE: aviso, nunca invalida a configuração. */
    | 'PREFERENCE_OPTION'
    | 'OPTION_REPEAT_UNVERIFIED'
    | 'LIMIT_SEMANTICS_UNKNOWN';
  message: string;
  optionGroupId?: string;
  optionId?: string;
}

export interface GroupSummary {
  optionGroupId: string;
  name: string | null;
  min: number | null;
  max: number | null;
  required: boolean | null;
  /** Opções distintas escolhidas. */
  selectedCount: number;
  /** Soma das quantidades (difere de selectedCount quando há repetição). */
  selectedUnits: number;
}

export interface ConfigValidation {
  status: ConfigStatus;
  issues: ConfigIssue[];
  groups: GroupSummary[];
}

export function validateSelection(
  detail: NormalizedItemDetail,
  selection: OptionSelection[],
  blocked: ReadonlySet<string> = new Set(),
  avoided: ReadonlySet<string> = new Set(),
): ConfigValidation {
  const issues: ConfigIssue[] = [];
  let unknown = false;
  if (detail.optionGroups.state !== 'PRESENT') {
    return {
      status: 'UNKNOWN',
      issues: [{ code: 'OPTIONS_UNKNOWN', message: 'getItem não informou optionGroups — configuração não verificável' }],
      groups: [],
    };
  }
  const index = indexOptions(detail);
  const distinct = new Map<string, Set<string>>();
  const units = new Map<string, number>();
  for (const s of selection) {
    const q = s.quantity ?? 1;
    const entry = index.get(s.optionId);
    if (!entry) {
      issues.push({ code: 'UNKNOWN_OPTION', message: `optionId não pertence a este item: ${s.optionId}`, optionId: s.optionId });
      continue;
    }
    if (!Number.isInteger(q) || q < 1) {
      issues.push({ code: 'INVALID_QUANTITY', message: `quantidade inválida (${q})`, optionId: s.optionId });
      continue;
    }
    if (q > 1) {
      unknown = true;
      issues.push({
        code: 'OPTION_REPEAT_UNVERIFIED',
        message: `"${val(entry.option.name) ?? s.optionId}" ×${q}: o iFood não informa se a opção pode repetir`,
        optionId: s.optionId,
        optionGroupId: entry.group.optionGroupId,
      });
    }
    if (blocked.has(s.optionId)) {
      issues.push({
        code: 'BLOCKED_OPTION',
        message: `"${val(entry.option.name) ?? s.optionId}" viola uma restrição informada (heurística)`,
        optionId: s.optionId,
        optionGroupId: entry.group.optionGroupId,
      });
    } else if (avoided.has(s.optionId)) {
      issues.push({
        code: 'PREFERENCE_OPTION',
        message: `"${val(entry.option.name) ?? s.optionId}" é incompatível com uma preferência informada (não bloqueante — heurística)`,
        optionId: s.optionId,
        optionGroupId: entry.group.optionGroupId,
      });
    }
    const gid = entry.group.optionGroupId;
    if (!distinct.has(gid)) distinct.set(gid, new Set());
    distinct.get(gid)!.add(s.optionId);
    units.set(gid, (units.get(gid) ?? 0) + q);
  }

  const groups: GroupSummary[] = [];
  for (const g of val(detail.optionGroups) ?? []) {
    const n = distinct.get(g.optionGroupId)?.size ?? 0;
    const u = units.get(g.optionGroupId) ?? 0;
    const min = val(g.minSelections);
    const max = val(g.maxSelections);
    const name = val(g.name) ?? null;
    const label = name ?? g.optionGroupId;
    groups.push({ optionGroupId: g.optionGroupId, name, min: min ?? null, max: max ?? null, required: g.required, selectedCount: n, selectedUnits: u });
    if (min === undefined || max === undefined) {
      unknown = true;
      issues.push({ code: 'LIMITS_UNKNOWN', message: `limites do grupo "${label}" não informados`, optionGroupId: g.optionGroupId });
    }
    // Interpretações possíveis de min/max: por opções distintas (n) ou por unidades (u). n <= u sempre.
    if (min !== undefined) {
      if (u < min) issues.push({ code: 'BELOW_MIN', message: `"${label}": escolha ao menos ${min} (selecionado: ${u})`, optionGroupId: g.optionGroupId });
      else if (n < min) {
        unknown = true;
        issues.push({ code: 'LIMIT_SEMANTICS_UNKNOWN', message: `"${label}": mínimo ${min} só é atingido contando repetições (${n} distintas, ${u} unidades)`, optionGroupId: g.optionGroupId });
      }
    }
    if (max !== undefined) {
      if (n > max) issues.push({ code: 'ABOVE_MAX', message: `"${label}": no máximo ${max} (selecionado: ${n})`, optionGroupId: g.optionGroupId });
      else if (u > max) {
        unknown = true;
        issues.push({ code: 'LIMIT_SEMANTICS_UNKNOWN', message: `"${label}": ${u} unidades excedem o máximo ${max} se repetições contarem (${n} distintas)`, optionGroupId: g.optionGroupId });
      }
    }
  }

  const hard = issues.some((i) => ['UNKNOWN_OPTION', 'INVALID_QUANTITY', 'BELOW_MIN', 'ABOVE_MAX', 'BLOCKED_OPTION'].includes(i.code));
  return { status: hard ? 'INVALID' : unknown ? 'UNKNOWN' : 'VALID', issues, groups };
}

export interface MinimalSelectionResult {
  selection: OptionSelection[] | null;
  /** Por que não foi possível montar (grupo obrigatório sem opções compatíveis/precificadas). */
  problems: string[];
  /** Grupos obrigatórios cuja preferência opcional não pôde ser atendida (aviso; nunca bloqueia). */
  preferenceGaps: string[];
}

/**
 * Configuração mínima mais barata: em cada grupo obrigatório escolhe `minSelections` opções distintas,
 * não bloqueadas, de menor additionalPrice (opções sem preço só entram se não houver alternativa).
 * `avoided` (PREFERENCE) nunca exclui opção: só desempata preços iguais.
 * Grupos opcionais ficam vazios.
 */
export function cheapestRequiredSelection(
  detail: NormalizedItemDetail,
  blocked: ReadonlySet<string> = new Set(),
  avoided: ReadonlySet<string> = new Set(),
): MinimalSelectionResult {
  return requiredSelection(detail, blocked, avoided, false);
}

/** Candidata preferida; o chamador deve validar configuração e orçamento antes de adotá-la. */
export function preferredRequiredSelection(
  detail: NormalizedItemDetail,
  blocked: ReadonlySet<string>,
  avoided: ReadonlySet<string>,
): MinimalSelectionResult {
  return requiredSelection(detail, blocked, avoided, true);
}

function requiredSelection(
  detail: NormalizedItemDetail,
  blocked: ReadonlySet<string>,
  avoided: ReadonlySet<string>,
  preferenceFirst: boolean,
): MinimalSelectionResult {
  if (detail.optionGroups.state !== 'PRESENT') {
    return { selection: null, problems: ['optionGroups não informado pelo getItem'], preferenceGaps: [] };
  }
  const selection: OptionSelection[] = [];
  const problems: string[] = [];
  const preferenceGaps: string[] = [];
  for (const g of detail.optionGroups.value) {
    const min = val(g.minSelections);
    const name = val(g.name) ?? g.optionGroupId;
    if (min === undefined) {
      problems.push(`grupo "${name}": minSelections não informado`);
      continue;
    }
    if (min < 1) continue;
    const allowed = g.options.filter((o) => !blocked.has(o.optionId));
    const priceKey = (o: NormalizedOption) => val(o.additionalPrice) ?? Number.POSITIVE_INFINITY;
    // O mínimo real ordena por preço; a candidata preferida é validada separadamente.
    const rank = (o: NormalizedOption) => (avoided.has(o.optionId) ? 1 : 0);
    const sorted = allowed
      .map((o, i) => ({ o, i }))
      .sort((a, b) => (preferenceFirst
        ? rank(a.o) - rank(b.o) || priceKey(a.o) - priceKey(b.o)
        : priceKey(a.o) - priceKey(b.o) || rank(a.o) - rank(b.o)) || a.i - b.i);
    if (sorted.length < min) {
      problems.push(`grupo obrigatório "${name}": ${sorted.length} opção(ões) compatível(is), mínimo ${min}`);
      continue;
    }
    const chosen = sorted.slice(0, min);
    if (chosen.some(({ o }) => avoided.has(o.optionId))) {
      preferenceGaps.push(
        `grupo obrigatório "${name}": preferência não atendida na configuração escolhida — mantida uma configuração obrigatoriamente válida`,
      );
    }
    for (const { o } of chosen) selection.push({ optionId: o.optionId, quantity: 1 });
  }
  return { selection: problems.length ? null : selection, problems, preferenceGaps: problems.length ? [] : preferenceGaps };
}
