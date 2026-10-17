import { describe, expect, it } from 'vitest';
import { errorBody, pickAddress } from '../src/server/app';
import { AuthError } from '../src/server/auth';
import { McpToolError } from '../src/server/mcp/errors';

const A = (id: string) => ({ addressId: id, coordinates: { latitude: 0, longitude: 0 } });

describe('pickAddress (FR-2)', () => {
  it('1 endereço → usa direto', () => expect(pickAddress([A('a')])).toMatchObject({ addressId: 'a' }));
  it('0 endereços → erro', () => expect(pickAddress([])).toHaveProperty('error'));
  it('vários sem escolha → erro', () => expect(pickAddress([A('a'), A('b')])).toHaveProperty('error'));
  it('id escolhido precisa existir na lista (nunca inventa)', () => {
    expect(pickAddress([A('a'), A('b')], 'b')).toMatchObject({ addressId: 'b' });
    expect(pickAddress([A('a')], 'zzz')).toHaveProperty('error');
  });
});

describe('errorBody', () => {
  it('MCP → 502 com mensagem do MCP', () => {
    const r = errorBody(new McpToolError('searchOffers', [{ message: 'msg', code: 'C', retryable: true }]));
    expect(r.status).toBe(502);
    expect(r.body.error).toMatchObject({ tool: 'searchOffers', message: 'msg', code: 'C', retryable: true });
  });
  it('login requerido → 401 sem apontar para sessão global', () => {
    const r = errorBody(new AuthError('x', 'LOGIN_REQUIRED', 401));
    expect(r.status).toBe(401);
    expect(r.body.error).toMatchObject({ kind: 'AUTH_ERROR', code: 'LOGIN_REQUIRED' });
    expect(r.body.error).not.toHaveProperty('loginUrl');
  });
});
