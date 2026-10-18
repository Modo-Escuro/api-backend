// DOM-01: dinheiro no domínio é centavo inteiro não negativo e seguro para JSON.
// BigInt é intermediário de aritmética/rateio; nunca sai no contrato HTTP.
export type Cents = number;

export function cents(value: number): Cents {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('Valor monetário deve ser centavo inteiro não negativo e seguro');
  return value;
}

/** Fronteira MCP: não arredonda subcentavos nem corrige negativos por suposição. */
export function brlToCents(value: number): Cents {
  if (!Number.isFinite(value) || value < 0) throw new RangeError('BRL inválido');
  const [mantissa, exponent = '0'] = String(value).toLowerCase().split('e');
  const [whole, fraction = ''] = mantissa!.split('.');
  const digits = BigInt(whole! + fraction);
  const power = Number(exponent) + 2 - fraction.length;
  const factor = 10n ** BigInt(Math.abs(power));
  if (power < 0 && digits % factor !== 0n) throw new RangeError('BRL com precisão inferior a um centavo');
  return cents(Number(power < 0 ? digits / factor : digits * factor));
}

/** Exclusivamente na fronteira de entrada MCP (filtros em BRL). */
export const centsToBrl = (value: Cents): number => cents(value) / 100;

export function formatCents(value: Cents): string {
  const n = BigInt(cents(value));
  return `R$ ${n / 100n}.${String(n % 100n).padStart(2, '0')}`;
}

export function addCents(...values: Cents[]): Cents {
  return cents(Number(values.reduce((sum, value) => sum + BigInt(cents(value)), 0n)));
}

export function multiplyCents(value: Cents, quantity: number): Cents {
  if (!Number.isSafeInteger(quantity) || quantity < 0) throw new RangeError('Quantidade inválida');
  return cents(Number(BigInt(cents(value)) * BigInt(quantity)));
}

export const compareIds = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));

/** Maiores restos da DEC-01 D3; empate por bytes de participantId, sem arredondamento float. */
export function splitCents(total: Cents, weights: ReadonlyArray<{ participantId: string; weight: number }>): Record<string, Cents> {
  cents(total);
  const ordered = [...weights].sort((a, b) => compareIds(a.participantId, b.participantId));
  if (new Set(ordered.map((x) => x.participantId)).size !== ordered.length || ordered.some((x) => !x.participantId)) {
    throw new RangeError('Participantes inválidos ou duplicados no rateio');
  }
  const sum = ordered.reduce((n, x) => n + BigInt(cents(x.weight)), 0n);
  if (sum === 0n) {
    if (total !== 0) throw new RangeError('Rateio sem peso positivo');
    return Object.fromEntries(ordered.map((x) => [x.participantId, 0]));
  }
  const parts = ordered.map((x) => {
    const product = BigInt(total) * BigInt(x.weight);
    return { ...x, amount: product / sum, remainder: product % sum };
  });
  const remaining = Number(BigInt(total) - parts.reduce((n, x) => n + x.amount, 0n));
  const byRemainder = [...parts].sort((a, b) => a.remainder === b.remainder
    ? compareIds(a.participantId, b.participantId) : a.remainder > b.remainder ? -1 : 1);
  for (const part of byRemainder.slice(0, remaining)) part.amount++;
  return Object.fromEntries(parts.map((x) => [x.participantId, cents(Number(x.amount))]));
}
