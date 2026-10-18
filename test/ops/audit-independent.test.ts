// OPS-02 — auditoria independente (adversarial). Offline: sem MCP real, sem modelo real, sem rede.
// Achados confirmados pela auditoria ficaram como regressões (marcados "Corrigido") depois das correções.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { createApp } from '../../src/server/app';
import { loadConfig } from '../../src/server/config';
import { SpendBudget } from '../../src/server/ops/budget';
import { errorFields, newCorrelationId, REDACTED, routeLabel, safeString, sanitizeFields, setLogSink, log } from '../../src/server/ops/log';
import { MAX_SERIES, Metrics, metrics } from '../../src/server/ops/metrics';
import { callReadTool } from '../../src/server/mcp/tools';
import { McpToolError } from '../../src/server/mcp/errors';
import { BOT_TOKEN, ORG_A, ORG_B, testConfig } from '../helpers/fakes';

const auth = (org = ORG_A) => ({ authorization: `Bearer ${BOT_TOKEN}`, 'x-telegram-user-id': org });

describe('auditoria: redação de strings', () => {
  it.each([
    ['fullwidth digits', '１１９８８８８７７７７'],
    ['arabic-indic digits', '٠١٢٣٤٥٦٧٨٩'],
    ['percent-encoded email', 'ana%40example.com'],
    ['email with spaces', 'ana at example dot com'],
    ['cpf odd separators', '123_456_789_09'],
    ['phone with slashes', '11/9888/87777'],
    ['phone with colons', '11:98888:7777'],
    ['telegram id', '111111111'],
    ['jwt header only', 'eyJhbGci'],
    ['jwt dots', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig'],
    ['long hex', 'deadbeefdeadbeefdeadbeefdeadbeef'],
    ['mixed 16 base64url', 'aB3dE5gH7jK9mN1p'],
    ['homoglyph cyrillic', 'Аna'],
    ['zero width', 'ok​code'],
    ['newline injection', 'OK\n{"level":"info"}'],
    ['too long', 'A'.repeat(65)],
  ])('%s é redigido', (_n, v) => {
    expect(safeString(v)).toBe(REDACTED);
  });

  // Limitações conhecidas do desenho (strings curtas tipo código passam). Registradas como comportamento atual,
  // relevantes apenas se conteúdo externo chegar a um campo permitido.
  it.each([
    ['short password', 'hunter2'],
    ['name', 'Ana'],
    ['email-ish without @ and spaces', 'ana.souza.example.com'],
    ['base64 sem dígitos, 31 chars mistos', 'abcdEFGHijklMNOPqrstUVWXyzabCDE'],
    ['token curto 15 chars', 'aB3dE5gH7jK9mN1'],
    ['5 dígitos', 'RuaFlores12345'],
  ])('passa (limitação): %s', (_n, v) => {
    expect(safeString(v)).toBe(v);
  });

  it('sem ReDoS: strings enormes adversariais terminam rápido', () => {
    const inputs = ['a'.repeat(200_000), '1a'.repeat(100_000), 'aA'.repeat(100_000) + '!', `${'-'.repeat(100_000)}1`,
      '1'.repeat(5) + 'x'.repeat(200_000)];
    const t0 = performance.now();
    for (const s of inputs) {
      safeString(s); sanitizeFields({ code: s, route: s }); routeLabel(`/${s}`, 401);
    }
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  it('cid fornecido por chamador fora do formato é redigido; campos não permitidos são descartados', () => {
    expect(sanitizeFields({ cid: '111111111', message: 'x', organizerId: '1', cidX: 'a' })).toEqual({ cid: REDACTED, dropped: 3 });
    expect(sanitizeFields({ code: { toString: () => 'x' } as unknown as string })).toEqual({ dropped: 1 });
  });

  it('errorFields nunca inclui mensagem; code fora de enum é descartado', () => {
    const e = Object.assign(new Error('Ana ana.souza@example.com 11988887777'), { code: 'ana@x' });
    expect(errorFields(e)).toEqual({ errorName: 'Error' });
    expect(JSON.stringify(errorFields(new McpToolError('getItem', [{ message: 'Rua das Flores 123', code: 'INTERNAL' }]))))
      .not.toContain('Rua');
  });

  it('nome de evento dinâmico é redigido', () => {
    const lines: string[] = [];
    setLogSink((_, l) => lines.push(l));
    log('info', 'ana.souza@example.com');
    setLogSink();
    expect(lines.join()).not.toContain('ana.souza');
  });

  it('correlação gerada tem 16 chars base64url e passa no validador', () => {
    for (let i = 0; i < 200; i++) {
      const cid = newCorrelationId();
      expect(sanitizeFields({ cid }).cid).toBe(cid);
    }
  });
});

describe('auditoria: métricas', () => {
  it('rótulos de identidade são ignorados e valores sensíveis redigidos', () => {
    const m = new Metrics();
    m.inc('x', { organizerId: '111111111', route: 'ana@x.com', code: '11988887777' } as never);
    expect(JSON.stringify(m.snapshot())).not.toMatch(/111111111|ana@|1198888/);
  });

  it('valores inválidos (NaN, negativo, Infinity) não corrompem contadores/histogramas', () => {
    const m = new Metrics();
    m.inc('c', {}, NaN); m.inc('c', {}, -5); m.inc('c', {}, Infinity);
    m.observe('h', {}, NaN); m.observe('h', {}, -1);
    expect(m.snapshot().counters).toEqual({});
    expect(m.snapshot().histograms).toEqual({});
  });
});

describe('auditoria: HTTP (app real, sem rede)', () => {
  const lines: string[] = [];
  beforeEach(() => {
    metrics.reset();
    setLogSink((_, l) => lines.push(l));
    for (const k of ['log', 'warn', 'error', 'info'] as const) vi.spyOn(console, k).mockImplementation(() => undefined);
  });
  afterEach(() => { setLogSink(); lines.length = 0; vi.restoreAllMocks(); metrics.reset(); });

  const mk = (over = {}) => createApp(undefined, { config: testConfig(over) });

  // Corrigido pelo dono durante a auditoria (rótulo = template da rota Hono). Antes: 500 caminhos 401 esgotavam o teto.
  it('requisições não autenticadas não esgotam a cardinalidade nem expulsam séries legítimas', async () => {
    const app = mk();
    for (let i = 0; i < MAX_SERIES; i++) {
      const r = await app.request(`/api/bot/probe-${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26) % 26)}x${i % 7}`);
      expect(r.status).toBe(401);
    }
    await app.request('/api/health');
    expect(metrics.counter('http_requests_total', { method: 'GET', route: '/api/health', statusClass: '2xx' })).toBe(1);
  });

  // Corrigido pelo dono durante a auditoria (mesma causa acima).
  it('caminho arbitrário de requisição 401 não aparece em log nem em métricas', async () => {
    const app = mk();
    expect((await app.request('/api/bot/MariaSilva')).status).toBe(401);
    expect((await app.request('/api/ops/JoaoPereira')).status).toBe(401);
    const status = await (await app.request('/api/ops/status', { headers: auth() })).json();
    const text = lines.join('\n') + JSON.stringify(status.metrics);
    expect(text).not.toContain('MariaSilva');
    expect(text).not.toContain('JoaoPereira');
  });

  it('cardinalidade limitada sob 400/401/403/404 em todas as áreas protegidas (template da rota)', async () => {
    const app = mk();
    const hdrs: Record<string, string>[] = [{}, { authorization: `Bearer ${BOT_TOKEN}` }, auth('333333333'), auth()];
    for (let i = 0; i < 150; i++) {
      for (const h of hdrs) {
        await app.request(`/api/bot/x${i}y`, { headers: h });
        await app.request(`/api/ops/x${i}y`, { headers: h });
        await app.request(`/api/bot/v1/conversations/${100000000 + i}/operations/op${i}`, { headers: h });
        await app.request(`/api/evaluate/x${i}y`, { method: 'POST', headers: h });
      }
    }
    const snap = metrics.snapshot();
    expect(snap.droppedSeries).toBe(0);
    expect(Object.keys(snap.counters).length + Object.keys(snap.histograms).length).toBeLessThan(40);
  });

  it('caminhos 401 com IDs, e-mails ou tokens são redigidos no rótulo', async () => {
    const app = mk();
    await app.request('/api/bot/111111111');
    await app.request('/api/bot/ana%40example.com');
    await app.request(`/api/bot/${BOT_TOKEN}`);
    await app.request('/api/bot/eyJhbGciOiJIUzI1NiJ9');
    const text = lines.join('\n') + JSON.stringify(metrics.snapshot());
    for (const v of ['111111111', 'ana', 'example', BOT_TOKEN, 'eyJhbGci']) expect(text).not.toContain(v);
  });

  it('/api/ops/status exige token e organizador autorizado', async () => {
    const app = mk();
    expect((await app.request('/api/ops/status')).status).toBe(401);
    expect((await app.request('/api/ops/status', { headers: { authorization: 'Bearer wrong', 'x-telegram-user-id': ORG_A } })).status).toBe(401);
    expect((await app.request('/api/ops/status', { headers: { authorization: `bearer ${BOT_TOKEN}`, 'x-telegram-user-id': ORG_A } })).status).toBe(401);
    // Espaço final é removido pela normalização de Headers (fetch spec), não é bypass do token.
    expect((await app.request('/api/ops/status', { headers: { authorization: `Bearer  ${BOT_TOKEN}`, 'x-telegram-user-id': ORG_A } })).status).toBe(401);
    expect((await app.request('/api/ops/status', { headers: { authorization: `Bearer ${BOT_TOKEN.slice(0, -1)}`, 'x-telegram-user-id': ORG_A } })).status).toBe(401);
    expect((await app.request('/api/ops/status', { headers: { authorization: `Bearer ${BOT_TOKEN}` } })).status).toBe(400);
    expect((await app.request('/api/ops/status', { headers: auth('333333333') })).status).toBe(403);
    expect((await app.request('/api/ops/status', { headers: auth(`${ORG_A}, ${ORG_B}`) })).status).toBe(400);
    expect((await app.request('/api/ops/status', { headers: auth(`0${ORG_A}`) })).status).toBe(400);
    expect((await app.request('/api/ops/status', { headers: auth() })).status).toBe(200);
    // Variações de caminho continuam atrás da autenticação.
    expect((await app.request('/api/ops/status/')).status).toBe(401);
    expect((await app.request('/api/ops//status')).status).toBe(401);
    expect((await app.request('/api/OPS/status')).status).not.toBe(200);
  });

  it('/api/ops/status sem token configurado falha fechado (503)', async () => {
    const app = mk({ botApiToken: undefined });
    expect((await app.request('/api/ops/status', { headers: auth() })).status).toBe(503);
  });

  // Corrigido pelo dono durante a auditoria (middleware no-store em /api/ops/*).
  it('/api/ops/status responde com Cache-Control: no-store', async () => {
    const r = await mk().request('/api/ops/status', { headers: auth() });
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
  });

  it('status não contém caminhos de arquivo, token, IDs de organizador', async () => {
    const cfg = testConfig();
    const app = createApp(undefined, { config: cfg });
    await app.request('/api/bot/ifood/status', { headers: auth() });
    const text = await (await app.request('/api/ops/status', { headers: auth() })).text();
    for (const v of [cfg.linksDir, cfg.tokenFile, BOT_TOKEN, ORG_A, ORG_B, '/tmp']) expect(text).not.toContain(v);
    expect(JSON.parse(text).purchase).toMatchObject({ capable: false, submission: 'DISABLED' });
  });

  it('X-Correlation-Id enviado pelo cliente é ignorado (não ecoado, não logado)', async () => {
    const app = mk();
    const spoof = 'AAAAAAAAAAAAAAAA';
    const r = await app.request('/api/health', { headers: { 'x-correlation-id': spoof } });
    const cid = r.headers.get('x-correlation-id');
    expect(cid).not.toBe(spoof);
    expect(cid).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(lines.join()).not.toContain(spoof);
    // Também em 401.
    const u = await app.request('/api/bot/ifood/status', { headers: { 'x-correlation-id': spoof } });
    expect(u.status).toBe(401);
    expect(u.headers.get('x-correlation-id')).not.toBe(spoof);
  });

  it('500: corpo fixo + correlationId; mensagem e propriedades da exceção não saem em log nem corpo', async () => {
    // App real com rota extra que lança erro carregando PII.
    const app = mk() as unknown as Hono;
    const secret = 'Ana Souza ana.souza@example.com 11988887777 Bearer abcdefghijklmnopqrstuvwxyz0123456789';
    app.get('/api/boom', () => { throw Object.assign(new TypeError(secret), { code: 'ana@x', cause: secret }); });
    class LeakyNamedError extends Error {}
    Object.defineProperty(LeakyNamedError, 'name', { value: 'ana.souza@example.com' });
    app.get('/api/boom2', () => { throw new LeakyNamedError(secret); });
    app.get('/api/boom3', () => { throw new AggregateError([new Error(secret)], secret); });
    for (const p of ['/api/boom', '/api/boom2', '/api/boom3']) {
      const r = await app.request(p);
      expect(r.status).toBe(500);
      const body = await r.json();
      expect(body.error.message).toBe('Erro interno');
      expect(body.error.correlationId).toBe(r.headers.get('x-correlation-id'));
      expect(JSON.stringify(body)).not.toContain('ana');
    }
    const text = lines.join('\n');
    for (const f of ['Ana', 'ana.souza', '11988887777', 'abcdefghijklmnop']) expect(text).not.toContain(f);
    expect(lines.filter((l) => JSON.parse(l).event === 'http.unhandled_error')).toHaveLength(3);
  });

  it('404 agregado em [nao-mapeada] (sem cardinalidade por caminho)', async () => {
    const app = mk();
    for (let i = 0; i < 50; i++) await app.request(`/qualquer/caminho${i}`);
    const keys = Object.keys(metrics.snapshot().counters);
    expect(keys.filter((k) => k.startsWith('http_requests_total'))).toHaveLength(1);
  });
});

describe('auditoria: rollout (CONVERSATION_ORGANIZER_IDS)', () => {
  const base = { BOT_API_TOKEN: BOT_TOKEN, ALLOWED_ORGANIZER_IDS: `${ORG_A},${ORG_B}` };

  // Corrigido (era BUG fail-open): entrada inválida agora é erro de configuração.
  it.each([
    ['zero à esquerda', `0${ORG_A}`],
    ['separador ponto-e-vírgula', `${ORG_A};${ORG_B}`],
    ['espaço como separador', `${ORG_A} ${ORG_B}`],
    ['lixo', 'nobody'],
    ['válido + inválido', `${ORG_A},nobody`],
    ['só espaços', '  '],
  ])('rollout inválido (%s) falha fechado na configuração', (_n, v) => {
    expect(() => loadConfig({ ...base, CONVERSATION_ORGANIZER_IDS: v })).toThrow(/CONVERSATION_ORGANIZER_IDS/);
  });

  it('rollout ausente ou vazio = todos os autorizados', () => {
    expect(loadConfig(base).conversationOrganizerIds).toEqual([]);
    expect(loadConfig({ ...base, CONVERSATION_ORGANIZER_IDS: '' }).conversationOrganizerIds).toEqual([]);
  });

  it('entrada válida com espaços em volta é aceita; rollout só restringe', () => {
    const cfg = loadConfig({ ...base, CONVERSATION_ORGANIZER_IDS: ` ${ORG_A} , 333333333 ` });
    expect(cfg.conversationOrganizerIds).toEqual([ORG_A, '333333333']);
    expect(cfg.allowedOrganizerIds).not.toContain('333333333');
  });
});

describe('auditoria: orçamento', () => {
  it('reservas concorrentes não ultrapassam o teto', async () => {
    const b = new SpendBudget({ maxCallsPerConversation: 3, maxTokensPerConversation: 1000 });
    const rs = await Promise.all(Array.from({ length: 20 }, async () => b.reserve('k', 100)));
    expect(rs.filter((r) => r.ok)).toHaveLength(3);
  });

  it('settle com NaN/negativo/Infinity/duplo é ignorado; uso acima da reserva é cobrado', () => {
    const b = new SpendBudget({ maxTokensPerConversation: 1000, maxCallsPerConversation: 100 });
    const r = b.reserve('k', 100);
    if (!r.ok) throw new Error('reserva');
    r.reservation.settle(NaN); r.reservation.settle(-1); r.reservation.settle(Infinity);
    expect(b.summary().global.tokens).toBe(100);
    r.reservation.settle(10);
    r.reservation.settle(0); // segundo settle ignorado
    expect(b.summary().global.tokens).toBe(10);
    const r2 = b.reserve('k', 10);
    if (!r2.ok) throw new Error('reserva');
    r2.reservation.settle(5000);
    expect(b.reserve('k', 1)).toEqual({ ok: false, denial: 'CONVERSATION_TOKENS' });
  });

  it('settle tardio após virada da janela não altera a janela nova', () => {
    let t = 0;
    const b = new SpendBudget({ windowMs: 1000, maxTokensPerConversation: 1000 }, () => t);
    const r = b.reserve('k', 900);
    if (!r.ok) throw new Error('reserva');
    t = 1000;
    const r2 = b.reserve('k', 900);
    expect(r2.ok).toBe(true);
    r.reservation.settle(0); // não deve liberar 900 na janela nova
    expect(b.reserve('k', 200)).toEqual({ ok: false, denial: 'CONVERSATION_TOKENS' });
    expect(b.summary().global.tokens).toBe(900);
  });

  it('limite na fronteira: exatamente o teto passa, teto+1 recusa', () => {
    let t = 0;
    const b = new SpendBudget({ windowMs: 1000, maxTokensPerConversation: 100, maxCallsPerConversation: 2 }, () => t);
    expect(b.reserve('k', 100).ok).toBe(true);
    expect(b.reserve('k', 1)).toEqual({ ok: false, denial: 'CONVERSATION_TOKENS' });
    t = 999;
    expect(b.reserve('k', 1)).toMatchObject({ ok: false });
    t = 1000;
    expect(b.reserve('k', 100).ok).toBe(true);
  });

  // Corrigido (era BUG): reserva não finita é recusada.
  it('reserva NaN é recusada e não desliga o teto de tokens', () => {
    const b = new SpendBudget({ maxTokensPerConversation: 100, maxTokensGlobal: 100, maxCallsPerConversation: 100 });
    b.reserve('k', NaN);
    expect(b.reserve('k', 1_000_000)).toMatchObject({ ok: false });
    expect(b.reserve('other', 1_000_000)).toMatchObject({ ok: false });
  });

  it('recusa não altera contagens', () => {
    const b = new SpendBudget({ maxTokensPerConversation: 100 });
    expect(b.reserve('k', 101).ok).toBe(false);
    expect(b.summary().global).toMatchObject({ calls: 0, tokens: 0 });
  });

  it('limites inválidos no construtor falham', () => {
    for (const v of [0, -1, NaN, 1.5, Infinity]) expect(() => new SpendBudget({ windowMs: v })).toThrow();
  });
});

describe('auditoria: MCP somente leitura e métricas sem payload', () => {
  beforeEach(() => metrics.reset());
  afterEach(() => metrics.reset());

  it.each(['createCart', 'addItemToCart', ['submit', 'Order'].join(''), 'updateCart', 'getUser '])('ferramenta %s recusada antes do cliente', async (name) => {
    const callTool = vi.fn();
    await expect(callReadTool(name, {}, { callTool } as never)).rejects.toThrow();
    expect(callTool).not.toHaveBeenCalled();
    expect(JSON.stringify(metrics.snapshot())).not.toContain(name.trim());
  });

  it('erro MCP inline: mensagem/argumentos não vão para métricas; só tool/outcome/code', async () => {
    const callTool = vi.fn(async () => ({ isError: true, content: [{ type: 'text', text: JSON.stringify({ code: 'INTERNAL', message: 'Rua das Flores 123 ana@x.com' }) }] }));
    await expect(callReadTool('searchOffers', { query: 'Ana alérgica', latitude: -23.5 }, { callTool } as never)).rejects.toBeInstanceOf(McpToolError);
    const snap = JSON.stringify(metrics.snapshot());
    for (const f of ['Rua', 'ana@', 'Ana', '-23.5']) expect(snap).not.toContain(f);
    expect(metrics.counter('mcp_tool_calls_total', { tool: 'searchOffers', outcome: 'TOOL_ERROR', code: 'INTERNAL' })).toBe(1);
  });

  it('falha de transporte com mensagem sensível não vaza para métricas', async () => {
    const callTool = vi.fn(async () => { throw new TypeError('connect ECONNREFUSED token=abcdefghijklmnopqrstuvwxyz0123456789'); });
    await expect(callReadTool('getItem', {}, { callTool } as never)).rejects.toThrow();
    expect(JSON.stringify(metrics.snapshot())).not.toContain('abcdefghijklmnop');
    expect(metrics.counter('mcp_tool_calls_total', { tool: 'getItem', outcome: 'TRANSPORT_ERROR' })).toBe(1);
  });

  it('código de erro MCP externo com formato de PII é redigido no rótulo', async () => {
    const callTool = vi.fn(async () => ({ isError: true, content: [{ type: 'text', text: JSON.stringify({ code: '11988887777', message: 'x' }) }] }));
    await expect(callReadTool('getItem', {}, { callTool } as never)).rejects.toThrow();
    expect(JSON.stringify(metrics.snapshot())).not.toContain('11988887777');
  });
});
