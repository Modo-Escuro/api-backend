# Executar na pasta da API pelo Console autenticado da Railway. Não imprime credenciais.
node --import tsx --input-type=module <<'INT01_PROBE'
import { config } from './src/server/config.ts';
// Consulta de metadados para execução manual no Console autenticado da Railway.
// Não refresca tokens, não grava storage, não chama tools/call e não devolve dados da conta.
import { readFile } from 'node:fs/promises';
import { basename, resolve, sep } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const endpoint = 'https://consumer-mcp.ifood.com.br/marketplace';
const relevantTool = /^(createCart|getCart|addItemToCart|updateCartItem|removeItemFromCart|getCartDeliveryMethods|setCartDelivery|listPaymentMethods|setCartPayment|listVouchers|setVoucher|removeVoucher|submitOrder|getOrder|trackOrder)$/;
class ProbeBlocked extends Error {
    reason;
    constructor(reason) {
        super(reason);
        this.reason = reason;
    }
}
async function readPrivateJson(path, kind, readText) {
    let text;
    try {
        text = await readText(path);
    }
    catch (error) {
        const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;
        throw new ProbeBlocked(`${kind}_FILE_${code === 'ENOENT' ? 'MISSING' : 'UNREADABLE'}`);
    }
    let value;
    try {
        value = JSON.parse(text);
    }
    catch {
        throw new ProbeBlocked(`${kind}_JSON_INVALID`);
    }
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new ProbeBlocked(`${kind}_FORMAT_UNRECOGNIZED`);
    return value;
}
/** Obtém somente a credencial do vínculo confirmado permitido; nunca usa .tokens.json global. */
export async function confirmedAuditToken(env, readText, now) {
    if ((env.IFOOD_MCP_URL || endpoint) !== endpoint)
        throw new ProbeBlocked('ENDPOINT_MISMATCH');
    const allowed = (env.ALLOWED_ORGANIZER_IDS || '').split(',').map((s) => s.trim()).filter((s) => /^[1-9][0-9]{0,19}$/.test(s));
    if (!allowed.length)
        throw new ProbeBlocked('NO_ALLOWED_ORGANIZER');
    const dir = resolve(env.IFOOD_LINKS_DIR || '.ifood-links');
    const raw = await readPrivateJson(resolve(dir, 'links.json'), 'LINKS', readText);
    if (raw.version !== 1 || !raw.links || typeof raw.links !== 'object')
        throw new ProbeBlocked('LINK_FORMAT_UNRECOGNIZED');
    const records = Object.values(raw.links).filter((r) => r !== null && typeof r === 'object' && allowed.includes(String(r.organizerId)));
    if (records.length !== 1)
        throw new ProbeBlocked('REQUIRE_ONE_CONFIRMED_LINK');
    const link = records[0];
    if (link.reconnectReason || typeof link.confirmedAt !== 'number' || !Number.isFinite(link.confirmedAt) || link.confirmedAt <= 0)
        throw new ProbeBlocked('LINK_NOT_READY');
    const name = link.tokenFileName;
    if (typeof name !== 'string' || !name || basename(name) !== name || !resolve(dir, name).startsWith(dir + sep))
        throw new ProbeBlocked('INVALID_TOKEN_LOCATION');
    const tokens = await readPrivateJson(resolve(dir, name), 'TOKEN', readText);
    if (tokens.clientId && env.IFOOD_CLIENT_ID && tokens.clientId !== env.IFOOD_CLIENT_ID)
        throw new ProbeBlocked('CLIENT_MISMATCH');
    if (typeof tokens.accessToken !== 'string' || !tokens.accessToken || /[\r\n]/.test(tokens.accessToken))
        throw new ProbeBlocked('TOKEN_UNAVAILABLE');
    if (typeof tokens.expiresAt !== 'number' || !Number.isFinite(tokens.expiresAt) || tokens.expiresAt < now + 60_000)
        throw new ProbeBlocked('VERIFY_LINK_THROUGH_EXISTING_API');
    return tokens.accessToken;
}
function metadata(tool) {
    const fields = Object.keys(tool.inputSchema?.properties ?? {}).filter((k) => /^[a-z][a-zA-Z0-9]{0,80}$/.test(k));
    const required = Array.isArray(tool.inputSchema?.required) ? tool.inputSchema.required.filter((k) => typeof k === 'string' && fields.includes(k)) : [];
    return {
        name: tool.name, inputProperties: fields, inputRequired: required, outputSchemaPresent: tool.outputSchema !== undefined,
        annotations: Object.fromEntries(['readOnlyHint', 'destructiveHint', 'idempotentHint'].map((key) => [key, typeof tool.annotations?.[key] === 'boolean' ? tool.annotations[key] : null])),
    };
}
async function connect(token) {
    const client = new Client({ name: 'int01-readonly-metadata-audit', version: '1.0.0' });
    let transportFailure;
    const failTransport = (reason) => { transportFailure = new ProbeBlocked(reason); throw transportFailure; };
    const transport = new StreamableHTTPClientTransport(new URL(endpoint), { fetch: async (url, init) => {
            // Impede encaminhar a credencial a outra origem ou seguir redirects. Nenhum authProvider/refresh.
            if (new URL(String(url)).origin !== new URL(endpoint).origin)
                failTransport('UNEXPECTED_ORIGIN');
            const headers = new Headers(init?.headers);
            headers.set('Authorization', `Bearer ${token}`);
            const response = await fetch(url, { ...init, headers, redirect: 'manual' });
            if ([301, 302, 303, 307, 308].includes(response.status))
                failTransport('REDIRECT_REFUSED');
            if (response.status === 401 || response.status === 403)
                failTransport('SESSION_REJECTED');
            return response;
        } });
    try {
        await client.connect(transport, { timeout: 15_000 });
    }
    catch (error) {
        await client.close().catch(() => undefined);
        throw transportFailure ?? error;
    }
    return client;
}
export async function runConsoleProbe(options = {}) {
    let client;
    let stage = 'READ_CONFIRMED_LINK';
    const now = options.now ?? Date.now;
    try {
        const token = await confirmedAuditToken(options.env ?? process.env, options.readText ?? ((path) => readFile(path, 'utf8')), now());
        stage = 'CONNECT_MCP';
        client = await (options.connect ?? connect)(token);
        stage = 'LIST_TOOLS';
        const deadline = now() + 30_000;
        const cursors = new Set();
        const tools = new Map();
        let cursor;
        let pages = 0;
        do {
            if (++pages > 20 || now() >= deadline)
                throw new ProbeBlocked('PAGINATION_LIMIT');
            const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: Math.max(1, Math.min(15_000, deadline - now())) });
            if (!Array.isArray(page.tools))
                throw new ProbeBlocked('TOOLS_LIST_UNRECOGNIZED');
            for (const tool of page.tools)
                if (relevantTool.test(tool.name)) {
                    if (tools.has(tool.name))
                        throw new ProbeBlocked('DUPLICATE_TOOL_METADATA');
                    tools.set(tool.name, metadata(tool));
                }
            cursor = page.nextCursor;
            if (cursor) {
                if (cursors.has(cursor))
                    throw new ProbeBlocked('REPEATED_CURSOR');
                cursors.add(cursor);
            }
        } while (cursor);
        return { audit: 'INT-01', status: 'OBSERVED_METADATA', observedAt: new Date(now()).toISOString(), operation: 'tools/list', pages,
            tools: [...tools.values()], businessToolsCalled: false, outputResponsesCaptured: false };
    }
    catch (error) {
        return { audit: 'INT-01', status: 'BLOCKED', stage, reason: error instanceof ProbeBlocked ? error.reason : 'PROBE_FAILED_NO_PRIVATE_DETAILS', businessToolsCalled: false };
    }
    finally {
        await client?.close().catch(() => undefined);
    }
}

console.log(JSON.stringify(await runConsoleProbe({ env: { ...process.env, IFOOD_LINKS_DIR: config.linksDir } })));
INT01_PROBE
