// Respostas de carrinho SINTÉTICAS: não são capturas reais nem evidência de compatibilidade do provedor.
import { randomUUID } from 'node:crypto';
import { vi } from 'vitest';
import { IfoodAuth } from '../../src/server/auth';
import { createApp } from '../../src/server/app';
import { CartService } from '../../src/server/cart/service';
import type { CallOptions } from '../../src/server/mcp/tools';
import type { LatLng, SearchOffersArgs } from '../../src/server/mcp/types';
import type { CartTool, Snapshot } from '../../src/server/cart/contracts';
import { IfoodLinkService } from '../../src/server/links/service';
import { BOT_TOKEN, ORG_A, setup } from '../helpers/fakes';

export const ADDRESS_ID = '11111111-1111-4111-8111-111111111111';
export const MERCHANT_ID = '22222222-2222-4222-8222-222222222222';
export const ITEM_ID = '33333333-3333-4333-8333-333333333333';
export const OPTION_ID = '44444444-4444-4444-8444-444444444444';
export const PAYMENT_ID = '55555555-5555-4555-8555-555555555555';
export const CARD_TOKEN = '66666666-6666-4666-8666-666666666666';
export const CAMPAIGN_ID = '77777777-7777-4777-8777-777777777777';
export const DETAIL = { itemId: ITEM_ID, merchantId: MERCHANT_ID, itemName: 'Item sintético', merchantName: 'Loja sintética',
  optionGroups: [{ optionGroupId: '88888888-8888-4888-8888-888888888888', minSelections: 1, maxSelections: 1,
    options: [{ optionId: OPTION_ID, name: 'Tamanho sintético', additionalPrice: 0 }] }] };

export class FakeCart {
  snapshots = new Map<string, { token: string; snapshot: Snapshot }>();
  fail: CartTool | null = null;
  hook: ((tool: CartTool) => Promise<void>) | null = null;
  paymentAvailable = true;
  call = vi.fn(async (token: string, tool: CartTool, args: Record<string, unknown>): Promise<unknown> => {
    if (this.hook) await this.hook(tool);
    if (this.fail === tool) throw new DOMException('timeout sintético', 'TimeoutError');
    if (tool === 'createCart') {
      const cartId = randomUUID();
      const items = (args.items as Snapshot['items']).map((i) => ({ ...i, cartItemId: randomUUID() }));
      const snapshot: Snapshot = { cartId, merchantId: args.merchantId as string, addressId: args.addressId as string,
        items, totals: { subtotal: 20, deliveryFee: 5, serviceFee: 1, discount: 0, total: 26 },
        deliveryMethod: null, paymentMethod: null, vouchers: [] };
      this.snapshots.set(cartId, { token, snapshot });
      return { cartId };
    }
    if (tool === 'listPaymentMethods') return { paymentMethods: this.paymentAvailable ? [{ paymentMethodId: PAYMENT_ID, cardTokenId: CARD_TOKEN, type: 'CREDIT_CARD' }] : [] };
    const entry = this.snapshots.get(args.cartId as string);
    if (!entry || entry.token !== token) throw new Error('Carrinho de outra sessão');
    const s = entry.snapshot;
    switch (tool) {
      case 'getCart': return structuredClone(s);
      case 'addItemToCart': s.items.push({ ...(args as unknown as Snapshot['items'][number]), cartItemId: randomUUID() }); break;
      case 'updateCartItem': {
        const index = s.items.findIndex((i) => i.cartItemId === args.cartItemId);
        s.items[index] = { ...s.items[index]!, ...(args as unknown as Snapshot['items'][number]) }; break;
      }
      case 'removeItemFromCart': s.items = s.items.filter((i) => i.cartItemId !== args.cartItemId); break;
      case 'getCartDeliveryMethods': return { deliveryMethods: [{ deliveryMethodId: 'DELIVERY' }] };
      case 'setCartDelivery': s.deliveryMethod = { deliveryMethodId: args.deliveryMethodId as string }; break;
      case 'setCartPayment': s.paymentMethod = { paymentMethodId: args.paymentMethodId as string }; break;
      case 'listVouchers': return { vouchers: [{ code: 'SYNTHETIC', campaignId: CAMPAIGN_ID }] };
      case 'setVoucher': s.vouchers = [{ code: args.code as string, campaignId: args.campaignId as string }]; break;
      case 'removeVoucher': s.vouchers = []; break;
      default: throw new Error('Tool não simulada');
    }
    return { success: true };
  });
}
export function cartSetup(enabled = true) {
  const env = setup({ cartEnabled: enabled });
  env.as.scope += ' mcp.cart.read mcp.cart.write mcp.cart.payment';
  env.mcp.addresses = [{ addressId: ADDRESS_ID, coordinates: { latitude: -1, longitude: -2 } }];
  const fake = new FakeCart();
  const reads = {
    searchOffers: vi.fn(async (_args: SearchOffersArgs, _opts: CallOptions) => ({ results: [{ itemId: ITEM_ID, merchant: { merchantId: MERCHANT_ID } }] })),
    getItem: vi.fn(async (args: { itemId: string; merchantId: string; userLocation: LatLng }, _opts: CallOptions) => ({ ...structuredClone(DETAIL), itemId: args.itemId, merchantId: args.merchantId })),
  };
  const links = new IfoodLinkService({ cfg: env.cfg, fetchImpl: env.as.fetch, now: env.clock.now,
    sessionFactory: (auth) => {
      const base = env.mcp.factory(auth);
      base.deps.searchOffers = reads.searchOffers;
      base.deps.getItem = reads.getItem;
      const sessionId = randomUUID(); // identidade da sessão permanece estável após refresh do token
      return { ...base, cart: { call: async (tool, args) => { await auth.getAccessToken(); return fake.call(sessionId, tool, args); } } };
    } });
  env.links = links;
  const carts = new CartService(links, enabled, env.clock.now);
  const app = createApp(new IfoodAuth(env.cfg, env.as.fetch, { tokenFile: null }), { config: env.cfg, links, carts });
  const call = (method: string, path: string, body?: unknown, org = ORG_A, token = BOT_TOKEN) => app.request(path, {
    method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-telegram-user-id': org },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { env, carts, fake, reads, app, call };
}
export const chosenItem = (itemRef: string) => ({ itemRef, quantity: 1, options: [{ optionId: OPTION_ID, quantity: 1 as const }] });
