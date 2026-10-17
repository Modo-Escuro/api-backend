// Normalização dos erros inline do MCP. Formatos tratados:
//  - observado (2026-10-17): isError=true + texto JSON {"error": "<mensagem>"}
//  - documentado (discovery): { errors: [{ code, message, retryable }] }
//  - documentado (cart):      { error: { code, message, ... } }
// Campos ausentes ficam undefined (nunca inventamos code/retryable).

export interface McpToolErrorInfo {
  message: string;
  code?: string;
  retryable?: boolean;
}

export class McpToolError extends Error {
  constructor(
    readonly tool: string,
    readonly errors: McpToolErrorInfo[],
  ) {
    super(errors.map((e) => e.message).join('; ') || `Falha em ${tool}`);
    this.name = 'McpToolError';
  }
  get code(): string | undefined {
    return this.errors.find((e) => e.code)?.code;
  }
  get retryable(): boolean {
    return this.errors.some((e) => e.retryable === true);
  }
}

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

function fromObject(o: Record<string, unknown>): McpToolErrorInfo {
  return {
    message: str(o.message) ?? str(o.description) ?? JSON.stringify(o),
    code: str(o.code),
    retryable: typeof o.retryable === 'boolean' ? o.retryable : undefined,
  };
}

/** Extrai erros de um payload já parseado; [] se não houver erro. */
export function extractErrors(payload: unknown): McpToolErrorInfo[] {
  if (!payload || typeof payload !== 'object') return [];
  const p = payload as Record<string, unknown>;
  const out: McpToolErrorInfo[] = [];
  if (Array.isArray(p.errors)) {
    for (const e of p.errors) out.push(e && typeof e === 'object' ? fromObject(e as Record<string, unknown>) : { message: String(e) });
  } else if (p.errors && typeof p.errors === 'object') {
    out.push(fromObject(p.errors as Record<string, unknown>));
  }
  if (typeof p.error === 'string') out.push({ message: p.error });
  else if (p.error && typeof p.error === 'object') out.push(fromObject(p.error as Record<string, unknown>));
  // Formato do Order Tracking: campos na raiz.
  if (!out.length && typeof p.errorType === 'string' && typeof p.message === 'string') out.push(fromObject(p));
  return out;
}
