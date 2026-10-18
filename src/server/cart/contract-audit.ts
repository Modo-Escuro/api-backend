// Inventário de evidência: analisa tools/list; nunca chama ferramentas ou habilita flags.
import { createHash } from 'node:crypto';
import { WRITES } from './contracts.js';

export interface CapturedTool {
  name: string;
  inputSchema: { properties?: Record<string, unknown>; required?: string[] };
  outputSchema?: unknown;
  annotations?: Record<string, unknown>;
}
const reads = new Set(['getCart', 'getCartDeliveryMethods', 'listPaymentMethods', 'listVouchers']);

export function auditCartCapture(rawCapture: string) {
  const captured = JSON.parse(rawCapture) as CapturedTool[] | { tools: CapturedTool[] };
  const tools = Array.isArray(captured) ? captured : captured.tools;
  const selected = tools.filter((t) => WRITES.has(t.name) || reads.has(t.name) || /^(submitOrder|getOrder|trackOrder)$/.test(t.name));
  return {
    evidence: 'PREEXISTING_TOOLS_LIST_NOT_A_NEW_PROVIDER_RUN',
    source: 'fixtures/tools-list.json',
    hashEncoding: 'UTF8_WITH_LF_LINE_ENDINGS',
    sha256: createHash('sha256').update(rawCapture.replace(/\r\n/g, '\n')).digest('hex'),
    capturedToolCount: tools.length,
    liveOutputsCaptured: false,
    checkoutEnabled: false,
    tools: selected.map((tool) => ({
      name: tool.name,
      inputRequired: tool.inputSchema.required ?? [],
      inputProperties: Object.keys(tool.inputSchema.properties ?? {}),
      outputSchemaPresent: tool.outputSchema !== undefined,
      annotations: tool.annotations ?? null,
      idempotencyInputFields: Object.keys(tool.inputSchema.properties ?? {}).filter((k) => /idempoten|requestId|clientRequest|intentId/i.test(k)),
      f7GatewayAllowed: WRITES.has(tool.name) || reads.has(tool.name),
      outputEvidence: 'NOT_CAPTURED',
    })),
    reconciliation: {
      orderLookupWithoutOrderId: selected.some((t) => /^(getOrder|trackOrder)$/.test(t.name) && !(t.inputSchema.required ?? []).includes('orderId')),
      cartLookupWithoutCartId: selected.some((t) => t.name === 'getCart' && !(t.inputSchema.required ?? []).includes('cartId')),
      guarantee: 'NOT_ESTABLISHED_BY_THIS_CAPTURE',
    },
  };
}
