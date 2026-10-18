// OPS-02: unidades de log, métricas, orçamento e permissões (offline, sem MCP e sem modelo real).
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { conversationKey, SpendBudget } from '../../src/server/ops/budget';
import { errorFields, log, REDACTED, routeLabel, sanitizeFields, setLogSink } from '../../src/server/ops/log';
import { MAX_SERIES, Metrics } from '../../src/server/ops/metrics';
import { checkPrivatePath } from '../../src/server/ops/storage-check';
import { SENSITIVE } from './sensitive';


describe('OPS-02 log estruturado', () => {
  afterEach(() => setLogSink());

  it('descarta campos fora da allowlist e redige strings que não são código curto', () => {
    const out = sanitizeFields({
      route: '/api/evaluate', code: 'RATE_LIMITED', status: 503, retryable: true,
      message: 'Ana é alérgica', address: 'Rua X', token: 'abc', organizerId: '111111111', payload: { a: 1 },
      reason: 'Rua das Flores, 123', kind: 'ana.souza@example.com', state: '11988887777', tool: 'a'.repeat(40),
    });
    expect(out).toEqual({
      route: '/api/evaluate', code: 'RATE_LIMITED', status: 503, retryable: true,
      reason: REDACTED, kind: REDACTED, state: REDACTED, tool: REDACTED, dropped: 5,
    });
  });

  it.each(SENSITIVE)('valor sensível %j nunca sai em nenhum campo permitido', (value) => {
    const lines: string[] = [];
    setLogSink((_, line) => lines.push(line));
    for (const key of ['code', 'reason', 'kind', 'route', 'tool', 'outcome', 'errorName']) log('error', 'test.event', { [key]: value });
    log('error', value, {});
    const text = lines.join('\n');
    expect(text).not.toContain(value);
    for (const fragment of value.split(/[\s,.@=-]+/).filter((f) => f.length >= 6)) expect(text).not.toContain(fragment);
  });

  it('linha é JSON com ts, nível e evento; números não finitos viram null', () => {
    const lines: string[] = [];
    setLogSink((_, line) => lines.push(line), () => 0);
    log('warn', 'http.request', { status: 200, durationMs: Number.NaN });
    expect(JSON.parse(lines[0]!)).toEqual({ ts: '1970-01-01T00:00:00.000Z', level: 'warn', event: 'http.request', status: 200, durationMs: null });
  });

  it('errorFields nunca inclui a mensagem da exceção', () => {
    const e = Object.assign(new Error('Rua das Flores, 123 ana@example.com'), { code: 'ECONNRESET' });
    expect(errorFields(e)).toEqual({ errorName: 'Error', code: 'ECONNRESET' });
    expect(errorFields(Object.assign(new Error('x'), { code: 'ana@example.com' }))).toEqual({ errorName: 'Error' });
  });

  it('rota: v1 redigida, 404 agregada, segmentos com dígitos longos/tokens redigidos', () => {
    expect(routeLabel('/api/bot/v1/conversations/111111111/events', 202)).toBe('/api/bot/v1/[redigido]');
    expect(routeLabel('/qualquer/coisa', 404)).toBe('[nao-mapeada]');
    expect(routeLabel('/api/bot/ifood/status', 200)).toBe('/api/bot/ifood/status');
    expect(routeLabel('/api/x/11988887777', 200)).toBe('/api/x/:redigido');
    expect(routeLabel('/api/x/ana@example.com', 200)).toBe('/api/x/:redigido');
  });
});

describe('OPS-02 métricas agregadas', () => {
  it('rótulos fora da allowlist (identidade) são ignorados e valores são saneados', () => {
    const m = new Metrics(() => 0);
    m.inc('http_requests_total', { route: '/api/health', organizerId: '111111111', conversationId: 'abc' });
    m.inc('http_requests_total', { route: '/api/health' });
    expect(m.counter('http_requests_total', { route: '/api/health' })).toBe(2);
    m.inc('mcp_tool_calls_total', { tool: 'getItem', code: 'ana@example.com' });
    expect(JSON.stringify(m.snapshot())).not.toContain('example.com');
    expect(JSON.stringify(m.snapshot())).not.toContain('111111111');
  });

  it('histograma acumula buckets e o teto de séries protege a memória', () => {
    const m = new Metrics(() => 0);
    m.observe('d', {}, 40); m.observe('d', {}, 300); m.observe('d', {}, 200_000);
    const h = m.snapshot().histograms['d']!;
    expect(h).toMatchObject({ count: 3, maxMs: 200_000 });
    expect(h.buckets.le50).toBe(1); expect(h.buckets.le500).toBe(2); expect(h.buckets.le120000).toBe(2);
    for (let i = 0; i < MAX_SERIES + 10; i++) m.inc('c', { code: `C${i}` });
    expect(m.snapshot().droppedSeries).toBeGreaterThan(0);
  });
});

describe('OPS-02 orçamento de execução/gasto', () => {
  it('limita chamadas por conversa sem afetar outra conversa; janela nova libera', () => {
    let t = 0;
    const b = new SpendBudget({ maxCallsPerConversation: 2, windowMs: 1000 }, () => t);
    const a = conversationKey('A'), c = conversationKey('C');
    expect(b.reserve(a, 10).ok).toBe(true);
    expect(b.reserve(a, 10).ok).toBe(true);
    expect(b.reserve(a, 10)).toEqual({ ok: false, denial: 'CONVERSATION_CALLS' });
    expect(b.reserve(c, 10).ok).toBe(true);
    t = 1000;
    expect(b.reserve(a, 10).ok).toBe(true);
  });

  it('tokens: reserva conservadora, ajuste pelo uso real e teto global', () => {
    const b = new SpendBudget({ maxTokensPerConversation: 100, maxTokensGlobal: 150 }, () => 0);
    const r = b.reserve('k1', 90);
    expect(r.ok).toBe(true);
    expect(b.reserve('k1', 20)).toEqual({ ok: false, denial: 'CONVERSATION_TOKENS' });
    if (r.ok) r.reservation.settle(30); // uso real menor devolve a diferença
    expect(b.reserve('k1', 60).ok).toBe(true);
    expect(b.reserve('k2', 70)).toEqual({ ok: false, denial: 'GLOBAL_TOKENS' });
    expect(b.summary().global.tokens).toBe(90);
  });

  it('recusa não altera contagens; rastreamento cheio falha fechado e limpeza libera referências vencidas', () => {
    let t = 0;
    const b = new SpendBudget({ maxConversations: 2, windowMs: 100 }, () => t);
    b.reserve('a', 1); b.reserve('b', 1);
    expect(b.reserve('c', 1)).toEqual({ ok: false, denial: 'TRACKING_FULL' });
    expect(b.summary().global.calls).toBe(2);
    t = 100;
    expect(b.reserve('c', 1).ok).toBe(true);
    expect(b.tracked).toBe(1);
  });

  it('chave da conversa é hash (sem identidade em claro)', () => {
    const key = conversationKey(JSON.stringify(['TELEGRAM', '900001', '111111111', '111111111']));
    expect(key).not.toContain('111111111');
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('configuração inválida é recusada', () => {
    expect(() => new SpendBudget({ maxCallsPerConversation: 0 })).toThrow();
  });
});

describe('OPS-02 permissões do storage na plataforma real', () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

  it('POSIX confere bits; Windows nunca é declarado PRIVATE (a ACL não é inferida)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ops02-perm-')); dirs.push(dir);
    chmodSync(dir, 0o700);
    const actual = checkPrivatePath(dir);
    if (process.platform === 'win32') {
      // Asserção explícita da limitação, em vez de omitir o teste.
      expect(actual).toEqual({ state: 'UNVERIFIED_PLATFORM', platform: 'WINDOWS', extraBits: null });
    } else {
      expect(actual).toEqual({ state: 'PRIVATE', platform: 'POSIX', extraBits: null });
      chmodSync(dir, 0o755);
      expect(checkPrivatePath(dir)).toEqual({ state: 'EXPOSED', platform: 'POSIX', extraBits: '055' });
      expect(statSync(dir).mode & 0o777).toBe(0o755);
    }
  });

  it('ramo Windows é exercitado em qualquer plataforma; ausência é distinta de exposição', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ops02-perm-')); dirs.push(dir);
    chmodSync(dir, 0o777);
    expect(checkPrivatePath(dir, 'win32').state).toBe('UNVERIFIED_PLATFORM');
    expect(checkPrivatePath(join(dir, 'nao-existe')).state).toBe('MISSING');
    expect(JSON.stringify(checkPrivatePath(dir))).not.toContain(dir);
  });
});

describe('OPS-02 regressão estática de logs', () => {
  it('nenhum console.* em src/server registra exceção bruta, mensagem ou JSON de payload', () => {
    const root = join(__dirname, '../../src/server');
    const files: string[] = [];
    const walk = (d: string) => readdirSync(d, { withFileTypes: true }).forEach((e) =>
      e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith('.ts') && files.push(join(d, e.name)));
    walk(root);
    const offenders: string[] = [];
    for (const f of files) {
      readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        const at = line.search(/console\.(log|warn|error|info|debug)\(/);
        if (at >= 0 && /\.message\b|JSON\.stringify\(|[(,]\s*(e|err|error)\s*\)/.test(line.slice(at))) {
          offenders.push(`${f.slice(root.length)}:${i + 1}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
