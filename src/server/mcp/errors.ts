// Normalização dos erros inline do MCP. Formatos tratados:
//  - observado (2026-10-17): isError=true + texto JSON {"error": "<mensagem>"}
//  - documentado (discovery): { errors: [{ code, message, retryable }] }
//  - documentado (cart):      { error: { code, message, ... } }
//  - observado (2026-10-17, falha upstream): isError=true + {"code":"INTERNAL","message":...,"agent_instruction":...}
// Campos ausentes ficam undefined (nunca inventamos code/retryable).

export interface McpToolErrorInfo {
  message: string;
  code?: string;
  retryable?: boolean;
  /** Orientação do gateway (ex.: "Do not retry immediately"). */
  agentInstruction?: string;
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
  const info: McpToolErrorInfo = {
    message: str(o.message) ?? str(o.description) ?? JSON.stringify(o),
    code: str(o.code),
    retryable: typeof o.retryable === 'boolean' ? o.retryable : undefined,
  };
  const instruction = str(o.agent_instruction) ?? str(o.agentInstruction);
  if (instruction) info.agentInstruction = instruction;
  return info;
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
  // Campos na raiz: Order Tracking (errorType) e falha upstream observada (code + message).
  if (!out.length && typeof p.message === 'string' && (typeof p.errorType === 'string' || typeof p.code === 'string')) out.push(fromObject(p));
  return out;
}
