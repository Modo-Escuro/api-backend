// INT-01: regressões adversariais com respostas SINTÉTICAS, nunca capturas de pedidos reais.
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { describe, expect, it, vi } from 'vitest';
import { cartGateway } from '../../src/server/mcp/cart';
import { createApp } from '../../src/server/app';
import { WRITES, parseSnapshot } from '../../src/server/cart/contracts';
import { callReadTool } from '../../src/server/mcp/tools';
import { loadConfig } from '../../src/server/config';
import { BOT_TOKEN, ORG_A, setup } from '../helpers/fakes';

describe('INT-01 integrada à main: fronteira de leitura da DEC-01', () => {
  it('rota F7 retirada retorna 404; configuração antiga não a reativa', async () => {
    expect(() => loadConfig({ IFOOD_CART_ENABLED: 'true' })).toThrow('retiradas');
    const env = setup();
    const app = createApp({ config: env.cfg, links: env.links });
    for (const [method, path] of [['POST', '/api/bot/cart'], ['POST', '/api/bot/cart/catalog'], ['GET', '/api/bot/cart/old-cart']]) {
      const response = await app.request(path!, { method, headers: {
        authorization: `Bearer ${BOT_TOKEN}`, 'x-telegram-user-id': ORG_A,
      } });
      expect(response.status).toBe(404);
    }
    expect(env.mcp.used).toHaveLength(0);
  });

  it('pipeline de leitura rejeita todas as mutações F7 e envio antes de obter resposta do MCP', async () => {
    const callTool = vi.fn();
    const client = { callTool } as unknown as Client;
    // eslint-disable-next-line no-restricted-syntax -- Nome adversarial: verificar rejeição, nunca executar envio.
    for (const tool of [...WRITES, 'submitOrder']) {
      await expect(callReadTool(tool, {}, client)).rejects.toThrow(/não permitida/);
    }
    expect(callTool).not.toHaveBeenCalled();
  });
});

describe('INT-01: saída desconhecida não confirma escrita', () => {
  it.each([undefined, null, {}, 'OK', { queued: true }, { success: 'true' },
    { success: true, error: { code: 'FAILED' } }, { success: true, data: { error: { code: 'FAILED' } } },
  ])('gateway bloqueia confirmação não reconhecida %j', async (raw) => {
    const callTool = vi.fn().mockResolvedValue({ structuredContent: raw });
    const gateway = cartGateway(async () => ({ callTool }) as unknown as Client);
    await expect(gateway.writeConfirmed!('addItemToCart', {})).rejects.toBeDefined();
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it('erro dentro de data não pode ser descartado por projeção de getCart', async () => {
    const snapshot = { cartId: 'synthetic-cart', items: [] };
    expect(() => parseSnapshot({ success: false, data: snapshot })).toThrow();
    expect(() => parseSnapshot({ success: 'true', data: snapshot })).toThrow();
    expect(() => parseSnapshot({ success: null, data: snapshot })).toThrow();
    expect(() => parseSnapshot({ data: { ...snapshot, error: { code: 'FAILED' } } })).toThrow();
  });

});
