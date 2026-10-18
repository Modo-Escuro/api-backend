import type { ErrorCode } from './conversation.js';

// Nunca copiar error.message, texto de catálogo/modelo ou corpo do provedor para esta resposta.
const errors = {
  INVALID_REQUEST: [400, 'Requisição inválida.', 'FIX_REQUEST'],
  UNSUPPORTED_VERSION: [400, 'Versão do contrato não suportada.', 'FIX_REQUEST'],
  UNAUTHENTICATED: [401, 'Autenticação necessária.', 'FIX_REQUEST'],
  FORBIDDEN: [403, 'Acesso não permitido.', 'NONE'],
  NOT_FOUND: [404, 'Recurso não encontrado.', 'NONE'],
  EVENT_CONFLICT: [409, 'Evento já recebido com outro conteúdo.', 'FIX_REQUEST'],
  STALE_VERSION: [409, 'A conversa mudou. Consulte a revisão atual.', 'READ_SNAPSHOT'],
  INVALID_SOURCE: [400, 'Origem incompatível com a conversa autenticada.', 'FIX_REQUEST'],
  ACTION_UNAVAILABLE: [409, 'Ação indisponível nesta revisão.', 'READ_SNAPSHOT'],
  REFERENCE_EXPIRED: [410, 'Referência expirada. Consulte a revisão atual.', 'READ_SNAPSHOT'],
  LINK_CHANGED: [409, 'O vínculo mudou. Uma nova revisão é necessária.', 'READ_SNAPSHOT'],
  DEADLINE_EXCEEDED: [409, 'Prazo de processamento excedido.', 'POLL_OPERATION'],
  LIMIT_EXCEEDED: [429, 'Limite de processamento atingido.', 'POLL_OPERATION'],
  UNAVAILABLE: [503, 'Serviço temporariamente indisponível.', 'POLL_OPERATION'],
  RESULT_UNKNOWN: [409, 'Resultado externo desconhecido. Não repita o envio.', 'CONTACT_SUPPORT'],
  INTERNAL: [500, 'Não foi possível concluir o processamento.', 'POLL_OPERATION'],
} as const;

export function contractErrorResponse(code: ErrorCode) {
  const [status, message, recovery] = errors[code];
  return { status, body: { contractVersion: '1.0' as const, error: { code, message, recovery } } };
}
