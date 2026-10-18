// INT-02: respostas REAIS observadas em 18/10/2026 (fixtures/int02). Não são outputs de carrinho.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { payload } from '../../src/server/cart/contracts';
import { McpToolError } from '../../src/server/mcp/errors';
import { parseToolResult, type RawToolResult } from '../../src/server/mcp/tools';

const sample = (name: string) => JSON.parse(readFileSync(new URL(`../../fixtures/int02/${name}`, import.meta.url), 'utf8'));

describe('INT-02 observado: envelope e erros inline do MCP', () => {
  it('erro de negócio vem com isError=false e errors como OBJETO; o parser rejeita', () => {
    const s = sample('createAddress-error-ADR-2001.json'), r = s.response as RawToolResult;
    expect(r.isError).toBe(false);
    expect(() => parseToolResult(s.tool, r)).toThrow(McpToolError);
    try { parseToolResult(s.tool, r); } catch (e) {
      expect((e as McpToolError).errors[0]).toMatchObject({ code: 'ADDRESS_CREATION_FAILED', retryable: true });
    }
    expect(() => payload((r as { structuredContent: unknown }).structuredContent)).toThrow(/erro/);
  });

  it('sucesso usa {success:true,data}; payload desembrulha data sem inventar campos', () => {
    const s = sample('createAddress-geocode.json'), r = s.response as RawToolResult;
    const data = payload(parseToolResult(s.tool, r)) as { matchConfidence: string; candidates: unknown[] };
    expect(data.matchConfidence).toBe('SINGLE');
    expect(data.candidates).toHaveLength(1);
  });

  it('lista vazia é explícita (results: []), diferente de ausente', () => {
    const p = parseToolResult('listAddresses', sample('listAddresses-empty.json').response) as { results: unknown[] };
    expect(p.results).toEqual([]);
  });

  it('manifesto INT-02 não declara ferramentas de carrinho observadas', () => {
    const m = sample('manifest.json');
    expect(m.cartToolsCalled).toBe(false);
    expect(m.toolsListMatchesFixture).toBe(true);
  });
});
