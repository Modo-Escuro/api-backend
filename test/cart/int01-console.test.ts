import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { confirmedAuditToken, runConsoleProbe } from '../../scripts/int01-console-probe';

const now = 1_800_000_000_000;
const env = { ALLOWED_ORGANIZER_IDS: '111', IFOOD_CLIENT_ID: 'client-test' };
const links = { version: 1, links: { '111': { organizerId: '111', confirmedAt: now - 1000, tokenFileName: 'link-test.json', reconnectReason: null } } };
const token = { accessToken: 'synthetic-private-token', clientId: 'client-test', expiresAt: now + 120_000 };
const readText = async (path: string) => JSON.stringify(path.endsWith('links.json') ? links : token);

describe('INT-01: consulta manual pelo Console, sem SSH nem mutações', () => {
  it('comando gerado corresponde ao fonte TypeScript', () => {
    const js = ts.transpileModule(readFileSync('scripts/int01-console-probe.ts', 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext },
    }).outputText;
    expect(readFileSync('docs/int-01-console-command.sh', 'utf8')).toContain(js);
  });
  it('lê somente o token do vínculo confirmado, sem sessão global', async () => {
    const read = vi.fn(readText);
    expect(await confirmedAuditToken(env, read, now)).toBe(token.accessToken);
    expect(read.mock.calls).toHaveLength(2);
    expect(read.mock.calls.every(([path]) => !path.endsWith('.tokens.json'))).toBe(true);
  });
  it('exige allowlist e um vínculo inequívoco, sem fazer rede', async () => {
    const connect = vi.fn();
    const result = await runConsoleProbe({ env: {}, readText, connect, now: () => now });
    expect(result).toMatchObject({ status: 'BLOCKED', reason: 'NO_ALLOWED_ORGANIZER' });
    expect(connect).not.toHaveBeenCalled();
    await expect(confirmedAuditToken(env, async () => JSON.stringify({ version: 1, links: {} }), now)).rejects.toThrow('REQUIRE_ONE_CONFIRMED_LINK');
  });
  it('distingue arquivo ausente, leitura recusada e JSON inválido sem expor conteúdo ou caminho', async () => {
    const connect = vi.fn();
    for (const kind of ['LINKS', 'TOKEN'] as const) {
      for (const code of ['ENOENT', 'EACCES', 'INVALID_JSON', 'INVALID_SHAPE']) {
        const read = async (path: string) => {
          if (kind === 'TOKEN' && path.endsWith('links.json')) return JSON.stringify(links);
          if (code === 'INVALID_JSON') return 'private-file-content';
          if (code === 'INVALID_SHAPE') return 'null';
          throw Object.assign(new Error('private-path-and-error'), { code });
        };
        const result = await runConsoleProbe({ env, readText: read, connect, now: () => now });
        const suffix = { ENOENT: 'FILE_MISSING', EACCES: 'FILE_UNREADABLE', INVALID_JSON: 'JSON_INVALID', INVALID_SHAPE: 'FORMAT_UNRECOGNIZED' }[code];
        expect(result).toMatchObject({ status: 'BLOCKED', stage: 'READ_CONFIRMED_LINK', reason: `${kind}_${suffix}`, businessToolsCalled: false });
        expect(JSON.stringify(result)).not.toMatch(/private-|synthetic-private-token/);
      }
    }
    expect(connect).not.toHaveBeenCalled();
  });
  it('identifica a etapa de rede sem divulgar o erro privado', async () => {
    const connect = vi.fn().mockRejectedValue(new Error('private-connect-error'));
    const result = await runConsoleProbe({ env, readText, connect, now: () => now });
    expect(result).toMatchObject({ stage: 'CONNECT_MCP', reason: 'PROBE_FAILED_NO_PRIVATE_DETAILS' });
    expect(JSON.stringify(result)).not.toContain('private-connect-error');
  });
  it('token expirado, client divergente e caminho fora do vínculo bloqueiam sem refresh', async () => {
    for (const bad of [{ ...token, expiresAt: now }, { ...token, clientId: 'other-client' }]) {
      await expect(confirmedAuditToken(env, async (p) => JSON.stringify(p.endsWith('links.json') ? links : bad), now)).rejects.toThrow();
    }
    const invalid = structuredClone(links); invalid.links['111'].tokenFileName = '../.tokens.json';
    await expect(confirmedAuditToken(env, async () => JSON.stringify(invalid), now)).rejects.toThrow('INVALID_TOKEN_LOCATION');
  });
  it('percorre paginação e retorna só metadados, sem valores de schema, tokens ou corpo privado', async () => {
    const client = { listTools: vi.fn()
      .mockResolvedValueOnce({ tools: [{ name: 'getCart', inputSchema: { properties: { cartId: { default: 'private-value' } }, required: ['cartId'] } }], nextCursor: 'private-cursor' })
      .mockResolvedValueOnce({ tools: [{ name: 'getOrder', inputSchema: { properties: { orderId: {} }, required: ['orderId'] } }] }), close: vi.fn().mockResolvedValue(undefined) };
    const result = await runConsoleProbe({ env, readText, now: () => now, connect: async () => client });
    expect(result).toMatchObject({ status: 'OBSERVED_METADATA', pages: 2, businessToolsCalled: false, outputResponsesCaptured: false });
    expect(JSON.stringify(result)).not.toMatch(/private-value|private-cursor|synthetic-private-token/);
    expect(client.listTools.mock.calls[1]![0]).toEqual({ cursor: 'private-cursor' });
    expect(client.close).toHaveBeenCalledOnce();
  });
  it('cursor repetido e erro privado fecham a sessão sem divulgar conteúdo', async () => {
    const client = { listTools: vi.fn().mockResolvedValue({ tools: [], nextCursor: 'secret-cursor' }), close: vi.fn().mockResolvedValue(undefined) };
    expect(await runConsoleProbe({ env, readText, now: () => now, connect: async () => client })).toMatchObject({ status: 'BLOCKED', reason: 'REPEATED_CURSOR' });
    client.listTools.mockRejectedValue(new Error('private-provider-response'));
    const result = await runConsoleProbe({ env, readText, now: () => now, connect: async () => client });
    expect(result).toMatchObject({ stage: 'LIST_TOOLS', reason: 'PROBE_FAILED_NO_PRIVATE_DETAILS' });
    expect(JSON.stringify(result)).not.toMatch(/private-provider-response|secret-cursor/);
  });
});
