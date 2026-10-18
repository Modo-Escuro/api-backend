import type { Hono } from 'hono';
import { z } from 'zod';
import { organizerOf } from '../botAuth.js';
import { CartError, id, itemInput, ref } from '../cart/contracts.js';
import type { CartService, SelectionKind } from '../cart/service.js';

const link = z.object({ linkId: ref }).strict();
const intent = z.object({ linkId: ref, requestId: z.uuid() }).strict();

export function registerCartRoutes(app: Hono, carts: CartService) {
  // Erros do provedor ficam sanitizados; nenhuma resposta bruta de carrinho/pagamento sai daqui.
  app.use('/api/bot/cart/*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    try { await next(); } catch (error) {
      if (error instanceof CartError) return c.json({ error: { kind: error.code, message: error.message,
        providerCode: error.providerCode ?? null, retryable: false }, purchaseAuthorized: false }, error.status);
      throw error;
    }
  });
  const body = async <T>(c: { req: { json(): Promise<unknown> } }, schema: z.ZodType<T>): Promise<T> => {
    let value: unknown;
    try { value = await c.req.json(); } catch { throw new CartError('VALIDATION', 'Corpo deve ser JSON.', 400); }
    const result = schema.safeParse(value);
    if (!result.success) throw new CartError('VALIDATION', 'Campos inválidos ou não permitidos.', 400);
    return result.data;
  };
  app.post('/api/bot/cart/catalog', async (c) => {
    const input = await body(c, link.extend({ addressId: id, query: z.string().trim().min(1).max(80) }).strict());
    return c.json(await carts.catalog(organizerOf(c), input));
  });
  app.post('/api/bot/cart', async (c) => {
    c.header('Cache-Control', 'no-store');
    try {
      const input = await body(c, intent.extend({ items: z.array(itemInput).min(1).max(20) }).strict());
      return c.json(await carts.createCart(organizerOf(c), input), 201);
    } catch (error) {
      if (error instanceof CartError) return c.json({ error: { kind: error.code, message: error.message,
        providerCode: error.providerCode ?? null, retryable: false }, purchaseAuthorized: false }, error.status);
      throw error;
    }
  });
  app.get('/api/bot/cart/:cartRef', async (c) => {
    const input = link.safeParse(c.req.query());
    if (!input.success) throw new CartError('VALIDATION', 'Informe apenas linkId na query.', 400);
    return c.json(await carts.getCart(organizerOf(c), input.data.linkId, c.req.param('cartRef')));
  });
  app.post('/api/bot/cart/:cartRef/items', async (c) => {
    const input = await body(c, intent.extend({ item: itemInput }).strict());
    return c.json(await carts.changeItem(organizerOf(c), input.linkId, c.req.param('cartRef'), input.requestId, input.item));
  });
  app.put('/api/bot/cart/:cartRef/items/:cartItemId', async (c) => {
    const input = await body(c, intent.extend({ item: itemInput }).strict());
    if (!id.safeParse(c.req.param('cartItemId')).success) throw new CartError('VALIDATION', 'cartItemId inválido.', 400);
    return c.json(await carts.changeItem(organizerOf(c), input.linkId, c.req.param('cartRef'), input.requestId, input.item, c.req.param('cartItemId')));
  });
  app.delete('/api/bot/cart/:cartRef/items/:cartItemId', async (c) => {
    const input = await body(c, intent);
    if (!id.safeParse(c.req.param('cartItemId')).success) throw new CartError('VALIDATION', 'cartItemId inválido.', 400);
    return c.json(await carts.removeItemFromCart(organizerOf(c), input.linkId, c.req.param('cartRef'), input.requestId, c.req.param('cartItemId')));
  });
  for (const kind of ['delivery', 'payment', 'voucher'] as SelectionKind[]) {
    app.get(`/api/bot/cart/:cartRef/${kind}`, async (c) => {
      const input = link.safeParse(c.req.query());
      if (!input.success) throw new CartError('VALIDATION', 'Informe apenas linkId na query.', 400);
      return c.json(await carts.listChoices(organizerOf(c), input.data.linkId, c.req.param('cartRef'), kind));
    });
    app.put(`/api/bot/cart/:cartRef/${kind}`, async (c) => {
      const input = await body(c, intent.extend({ choiceRef: ref }).strict());
      return c.json(await carts.selectChoice(organizerOf(c), input.linkId, c.req.param('cartRef'), input.requestId, kind, input.choiceRef));
    });
  }
  app.delete('/api/bot/cart/:cartRef/voucher', async (c) => {
    const input = await body(c, intent);
    return c.json(await carts.removeVoucher(organizerOf(c), input.linkId, c.req.param('cartRef'), input.requestId));
  });
  app.post('/api/bot/cart/:cartRef/review', async (c) => {
    const input = await body(c, link);
    return c.json(await carts.review(organizerOf(c), input.linkId, c.req.param('cartRef')));
  });
  for (const action of ['approve', 'submit']) app.post(`/api/bot/cart/:cartRef/${action}`, async (c) => {
    await body(c, link.extend({ reviewId: ref }).strict());
    // Não há integração de submissão. Nem userConsent=true, login ou clique de revisão habilitam compra.
    throw new CartError('CHECKOUT_DISABLED', 'Aprovação e envio de pedidos não estão habilitados nesta etapa.');
  });
}
