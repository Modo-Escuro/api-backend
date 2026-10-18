// Representação explícita de campos vindos do MCP: ausente ≠ null ≠ valor (CLAUDE.md regra 3).
// Lista vazia é um valor PRESENT ([]), distinto de ABSENT.

export type Field<T> =
  | { state: 'PRESENT'; value: T }
  | { state: 'NULL' }
  | { state: 'ABSENT' }
  | { state: 'INVALID'; raw: unknown };

export const present = <T>(value: T): Field<T> => ({ state: 'PRESENT', value });
export const ABSENT: Field<never> = Object.freeze({ state: 'ABSENT' });

/** Valor se presente; undefined em qualquer outro estado. */
export function val<T>(f: Field<T>): T | undefined {
  return f.state === 'PRESENT' ? f.value : undefined;
}

export function readField<T>(obj: unknown, key: string, guard: (v: unknown) => v is T): Field<T> {
  if (!obj || typeof obj !== 'object' || !(key in obj)) return ABSENT;
  const raw = (obj as Record<string, unknown>)[key];
  if (raw === undefined) return ABSENT;
  if (raw === null) return { state: 'NULL' };
  return guard(raw) ? present(raw) : { state: 'INVALID', raw };
}

export const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
export const isString = (v: unknown): v is string => typeof v === 'string';
export const isBoolean = (v: unknown): v is boolean => typeof v === 'boolean';

export const readNumber = (o: unknown, k: string) => readField(o, k, isNumber);
export const readString = (o: unknown, k: string) => readField(o, k, isString);
export const readBoolean = (o: unknown, k: string) => readField(o, k, isBoolean);

export function mapField<T, U>(f: Field<T>, fn: (v: T) => U): Field<U> {
  return f.state === 'PRESENT' ? present(fn(f.value)) : f;
}

/** Descrição curta do estado para avisos de UI. */
export function describeMissing(name: string, f: Field<unknown>): string | null {
  switch (f.state) {
    case 'ABSENT':
      return `${name}: não informado pelo iFood`;
    case 'NULL':
      return `${name}: retornado vazio (null) pelo iFood`;
    case 'INVALID':
      return `${name}: valor em formato inesperado`;
    default:
      return null;
  }
}
