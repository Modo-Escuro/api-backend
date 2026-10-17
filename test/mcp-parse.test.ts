import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { extractErrors, McpToolError } from '../src/server/mcp/errors';
import { ALLOWED_TOOLS, callReadTool, parseToolResult } from '../src/server/mcp/tools';
import type { GetItemResult, SearchOffersResult } from '../src/server/mcp/types';

const fx = (name: string) => JSON.parse(readFileSync(`fixtures/${name}`, 'utf8'));

describe('parseToolResult (fixtures reais)', () => {
  it('lê structuredContent de searchOffers', () => {
    const search = fx('searchOffers-pizza.json');
    const out = parseToolResult('searchOffers', { structuredContent: search, content: [], isError: false }) as SearchOffersResult;
    expect(out.results.length).toBeGreaterThan(0);
    for (const r of out.results) {
      expect(r.itemId).toMatch(/^[0-9a-f-]{36}$/);
      expect(r.merchant.merchantId).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it('faz fallback para content[].text JSON', () => {
    const item = fx('getItem-pizza.json');
    const out = parseToolResult('getItem', { content: [{ type: 'text', text: JSON.stringify(item) }] }) as GetItemResult;
    expect(out.optionGroups?.[0]?.options.length).toBeGreaterThan(0);
  });

  it('erro observado: isError + {"error": string} vira McpToolError sem inventar code/retryable', () => {
    const raw = fx('searchOffers-error-empty-query.json');
    let caught: unknown;
    try {
      parseToolResult('searchOffers', raw);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(McpToolError);
    const err = caught as McpToolError;
    expect(err.message).toContain('`query`');
    expect(err.code).toBeUndefined();
    expect(err.retryable).toBe(false);
  });
});

describe('erro upstream real ({code, message, agent_instruction} na raiz)', () => {
  it('preserva code, mensagem e instrução; não inventa retryable', () => {
    let caught: unknown;
    try {
      parseToolResult('listAddresses', fx('mcp-error-upstream-internal.json'));
    } catch (e) {
      caught = e;
    }
    const err = caught as McpToolError;
    expect(err).toBeInstanceOf(McpToolError);
    expect(err.code).toBe('INTERNAL');
    expect(err.message).toMatch(/internal failure at an upstream service/);
    expect(err.errors[0]!.agentInstruction).toMatch(/Do not retry immediately/);
    expect(err.errors[0]!.retryable).toBeUndefined();
    expect(err.retryable).toBe(false);
  });
});

describe('extractErrors (formatos documentados)', () => {
  it('discovery: errors[] com code/retryable', () => {
    expect(extractErrors({ errors: [{ code: 'X', message: 'm', retryable: true }] })).toEqual([{ code: 'X', message: 'm', retryable: true }]);
  });
  it('cart: error objeto', () => {
    expect(extractErrors({ error: { code: 'C', message: 'n' } })[0]).toMatchObject({ code: 'C', message: 'n' });
  });
  it('payload normal não tem erro', () => {
    expect(extractErrors(fx('searchOffers-pizza.json'))).toEqual([]);
  });
});

describe('allowlist de tools', () => {
  it('não inclui tools de escrita', () => {
    // eslint-disable-next-line no-restricted-syntax
    for (const t of ['createCart', 'addItemToCart', 'submitOrder', 'createAddress']) expect(ALLOWED_TOOLS.has(t)).toBe(false);
  });
  it('callReadTool recusa tool fora da allowlist antes de qualquer rede', async () => {
    // eslint-disable-next-line no-restricted-syntax
    await expect(callReadTool('submitOrder', {})).rejects.toThrow(/não permitida/);
  });
});
