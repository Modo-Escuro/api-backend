import { describe, expect, it } from 'vitest';
import { createApp, errorBody } from '../src/server/app';
import { AuthError } from '../src/server/auth';
import { McpToolError } from '../src/server/mcp/errors';

describe('superfícies retiradas', () => {
  it('raiz informa o canal atual sem redirecionar para o painel retirado', async () => {
    const response = await createApp().request('/');
    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
    expect(await response.text()).toContain('Telegram');
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
