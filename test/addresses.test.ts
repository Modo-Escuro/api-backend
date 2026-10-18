// Pessoas, credenciais e MCP sintéticos. Apenas SQLite e fronteira HTTP são reais.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/server/app';
import { loadConfig } from '../src/server/config';
import { contentHash, type AdapterPrincipal } from '../src/server/contracts/guards';
import { DeliveryAddresses } from '../src/server/services/delivery-addresses';
import { linkedProposalProvider } from '../src/server/services/group';
import { applyPatch } from '../src/server/domain/purchase';
import { TurnRuntime } from '../src/server/turns/runtime';
import { TurnStore } from '../src/server/turns/store';
import type { IfoodLinkService, OperationalContext } from '../src/server/links/service';

const p: AdapterPrincipal = { botId: '900001', organizerId: '111111111', conversationId: '111111111' };
const token = 'synthetic-service-token-xxxxxxxxxxxxxxxxxxxxxxxx';
const address = (id = 'address-synthetic-a', alias = 'Casa') => ({ addressId: id, alias, formattedAddress: 'Endereço completo sintético privado, número 123',
  postalCode: '00000-000', location: { street: 'Rua Sintética', number: '123', neighborhood: 'Centro', city: 'Cidade Sintética' },
  coordinates: { latitude: -1, longitude: -2 } });
const stores: TurnStore[] = [];
afterEach(() => { for (const s of stores.splice(0)) s.close(); });
function setup() {
  let now = 1_800_000_000_000;
  const store = new TurnStore(':memory:', {}, () => now); stores.push(store);
  const addresses = [address()];
  let linkId = 'synthetic-link-a', state = 'CONNECTED';
  const list = vi.fn(async () => ({ results: addresses }));
  const search = vi.fn();
  const ctx = { linkId, deps: { listAddresses: list, searchOffers: search } } as unknown as OperationalContext;
  const links = { status: vi.fn(async () => ({ state, operational: state === 'CONNECTED', linkId, attempt: null,
      scopeEvidence: 'TOKEN_SCOPES', allowedOperations: ['ADDRESSES_READ','OFFERS_EVALUATE'] })),
    withOperational: vi.fn(async (_org: string, _operation: string, fn: (ctx: OperationalContext) => Promise<unknown>) => {
      ctx.linkId = linkId;
      return fn(ctx);
    }) } as unknown as Pick<IfoodLinkService, 'status' | 'withOperational'>;
  const service = new DeliveryAddresses(store, links);
  const runtime = new TurnRuntime(store);
  const cfg = loadConfig({ BOT_API_TOKEN: token, ALLOWED_ORGANIZER_IDS: p.organizerId,
    CONVERSATION_RUNTIME_ENABLED: 'true', CONVERSATION_DB_FILE: './data/synthetic-address-test.db', BOT_TELEGRAM_ID: p.botId });
  const app = createApp(undefined, { config: cfg, conversations: runtime, links: links as IfoodLinkService });
  const headers = { authorization: `Bearer ${token}`, 'x-telegram-user-id': p.organizerId, 'x-telegram-chat-id': p.conversationId, 'content-type': 'application/json' };
  const path = `/api/bot/v1/conversations/${p.conversationId}/addresses`;
  return { store, addresses, service, links, list, search, ctx, app, headers, path,
    advance: (ms: number) => { now += ms; }, setLink: (v: string) => { linkId = v; }, disconnect: () => { state = 'DISCONNECTED'; } };
}

describe('endereços: leitura autenticada, confirmação e revalidação', () => {
  it.each(['TOKEN_EXPIRED', 'SCOPES_UNKNOWN', 'MISSING_SCOPE'])('%s impede leitura sem transformar em EMPTY', async mode => {
    const f = setup();
    vi.mocked(f.links.status).mockResolvedValueOnce({ state: mode === 'TOKEN_EXPIRED' ? 'RECONNECT_REQUIRED' : 'CONNECTED',
      operational: mode !== 'TOKEN_EXPIRED', linkId: 'synthetic-link-a', attempt: null,
      scopeEvidence: mode === 'SCOPES_UNKNOWN' ? 'NOT_PROVIDED' : 'TOKEN_SCOPES', allowedOperations: [] } as never);
    await expect(f.service.review(p)).rejects.toThrow();
    expect(f.list).not.toHaveBeenCalled();
  });
  it('zero é EMPTY; não inventa endereço nem impede coleta do grupo', async () => {
    const f = setup(); f.addresses.length = 0;
    expect(await f.service.review(p)).toMatchObject({ state: 'EMPTY', options: [] });
    expect(f.search).not.toHaveBeenCalled();
    expect(applyPatch(null, [{ op: 'ADD_PARTICIPANT', displayName: 'Pessoa sintética' }], { seed: 'test', eventId: 'e1' }).state.participants).toHaveLength(1);
  });
  it('um endereço ainda exige clique e só retorna resumo seguro e referência opaca', async () => {
    const f = setup(), view = await f.service.review(p);
    expect(view.options).toHaveLength(1);
    expect(view.options[0]!.choiceRef).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(view.options[0]!.label).toBe('Casa · Centro · Cidade Sintética');
    expect(JSON.stringify(view)).not.toMatch(/123|00000|address-synthetic|formattedAddress|latitude/);
    expect(() => f.service.selected(p, 'synthetic-link-a')).toThrow();
    const selected = await f.service.select(p, view.options[0]!.choiceRef);
    expect(selected).toMatchObject({ state: 'SELECTED', purchaseAuthorized: false });
    expect(await f.service.forSuggestions(p, f.ctx)).toBe('address-synthetic-a');
    const rows = JSON.stringify(f.store.db.prepare('SELECT * FROM delivery_address_selected').all());
    expect(rows).not.toMatch(/Casa|Centro|Cidade|formattedAddress|latitude|number|postalCode/);
  });
  it('múltiplos preservam opções distintas e só a escolha explícita é gravada', async () => {
    const f = setup(); f.addresses.push(address('address-synthetic-b', 'Trabalho'));
    const view = await f.service.review(p);
    expect(view.options).toHaveLength(2);
    await f.service.select(p, view.options[1]!.choiceRef);
    expect(f.service.selected(p, 'synthetic-link-a').addressId).toBe('address-synthetic-b');
    await expect(f.service.select(p, view.options[0]!.choiceRef)).rejects.toMatchObject({ code: 'REFERENCE_EXPIRED' });
    expect((await f.service.select(p, view.options[1]!.choiceRef)).state).toBe('SELECTED');
  });
  it.each(['removed', 'changed', 'link', 'disconnected', 'expired'])('%s bloqueia escolha antiga', async mode => {
    const f = setup(), view = await f.service.review(p);
    if (mode === 'removed') f.addresses.length = 0;
    if (mode === 'changed') f.addresses[0]!.location.number = '456';
    if (mode === 'link') f.setLink('synthetic-link-b');
    if (mode === 'disconnected') f.disconnect();
    if (mode === 'expired') f.advance(300_001);
    await expect(f.service.select(p, view.options[0]!.choiceRef)).rejects.toThrow();
    expect(f.store.db.prepare('SELECT count(*) n FROM delivery_address_selected').get()!['n']).toBe(0);
  });
  it('endereço removido depois da seleção bloqueia sugestões antes da busca', async () => {
    const f = setup(), view = await f.service.review(p);
    await f.service.select(p, view.options[0]!.choiceRef);
    f.addresses.length = 0;
    await expect(f.service.forSuggestions(p, f.ctx)).rejects.toMatchObject({ code: 'ADDRESS_REQUIRED' });
    expect(f.search).not.toHaveBeenCalled();
  });
  it('troca de vínculo durante leitura impede oferecer opções da conta antiga', async () => {
    const f = setup();
    f.list.mockImplementationOnce(async () => { f.setLink('synthetic-link-b'); return { results: f.addresses }; });
    await expect(f.service.review(p)).rejects.toMatchObject({ code: 'LINK_CHANGED' });
    expect(f.service.choices.size).toBe(0);
  });
  it('erro MCP, schema inválido ou labels indistinguíveis nunca viram EMPTY', async () => {
    const f = setup();
    f.list.mockRejectedValueOnce(new Error('erro sintético privado'));
    await expect(f.service.review(p)).rejects.toThrow();
    f.list.mockResolvedValueOnce({} as never);
    await expect(f.service.review(p)).rejects.toThrow();
    f.addresses.push(address('address-synthetic-b'));
    await expect(f.service.review(p)).rejects.toThrow();
  });
  it('timeout é indisponibilidade e não grava opções', async () => {
    const f = setup(); vi.useFakeTimers();
    try {
      f.list.mockImplementationOnce(() => new Promise(() => undefined));
      const result = expect(f.service.review(p)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
      await vi.advanceTimersByTimeAsync(4001); await result;
      expect(f.service.choices.size).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it('mesmo SQLite recupera seleção; referência não atravessa organizadores ou expiração', async () => {
    const f = setup(), view = await f.service.review(p);
    await expect(f.service.select({ ...p, organizerId: '222222222', conversationId: '222222222' }, view.options[0]!.choiceRef)).rejects.toThrow();
    await f.service.select(p, view.options[0]!.choiceRef);
    const reopened = new DeliveryAddresses(f.store, f.links);
    expect(reopened.selected(p, 'synthetic-link-a').addressHash).toHaveLength(64);
    expect((await reopened.select(p, view.options[0]!.choiceRef)).state).toBe('SELECTED');
    f.advance(86_400_001);
    expect(() => reopened.selected(p, 'synthetic-link-a')).toThrow();
  });
  it('HTTP exige origem humana estrita, autenticação, conversa privada e não expõe erro MCP', async () => {
    const f = setup();
    expect((await f.app.request(f.path)).status).toBe(401);
    expect((await f.app.request(f.path, { headers: { ...f.headers, 'x-telegram-chat-id': '222222222' } })).status).toBe(400);
    const view = await (await f.app.request(f.path, { headers: f.headers })).json();
    const select = (body: unknown) => f.app.request(f.path + '/select', { method: 'POST', headers: f.headers, body: JSON.stringify(body) });
    expect((await select({ source: 'MODEL', choiceRef: view.options[0].choiceRef })).status).toBe(400);
    expect((await select({ source: 'TELEGRAM_CALLBACK', choiceRef: view.options[0].choiceRef, userId: 'inventado' })).status).toBe(400);
    expect((await select({ source: 'TELEGRAM_CALLBACK', choiceRef: view.options[0].choiceRef })).status).toBe(200);
    f.list.mockRejectedValueOnce(new Error('segredo-sintético-endereço'));
    const failed = await f.app.request(f.path, { headers: f.headers });
    expect(failed.status).toBe(503); expect(await failed.text()).not.toContain('segredo-sintético');
  });
  it('provedor de sugestões não usa fallback automático antes de endereço confirmado', async () => {
    const f = setup();
    const provider = linkedProposalProvider(f.links as never, { addressFor: (_org, ctx) => f.service.forSuggestions(p, ctx) });
    const state = applyPatch(null, [{ op: 'ADD_PARTICIPANT', displayName: 'Pessoa sintética' }], { seed: 'test', eventId: 'e1' }).state;
    await expect(provider(p.organizerId, state, 'comida')).rejects.toMatchObject({ code: 'ADDRESS_REQUIRED' });
    expect(f.list).not.toHaveBeenCalled(); expect(f.search).not.toHaveBeenCalled();
    expect(contentHash('synthetic-link-a')).toHaveLength(64);
  });
});
