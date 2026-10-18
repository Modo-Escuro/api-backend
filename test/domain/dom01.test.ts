// Casos SINTÉTICOS da DOM-01; nunca fazem rede ou autorizam transação.
import { describe, expect, it } from 'vitest';
import { addCents, brlToCents, cents, centsToBrl, formatCents, multiplyCents, splitCents } from '../../src/server/domain/money';
import { normalizeItemDetail, normalizeListingItem } from '../../src/server/domain/normalize';
import { computePrice } from '../../src/server/domain/pricing';
import { checkCap, evaluateCandidate } from '../../src/server/domain/eligibility';
import { allocateCosts, type CostInput } from '../../src/server/domain/purchase-costs';
import { EvaluateBody, toDomainRequest } from '../../src/server/routes/evaluate';
import { runEvaluation } from '../../src/server/services/evaluate';
import { evaluateView } from '../../src/server/services/evaluate-view';
import { evaluateViewCents } from '../../src/server/services/cents';

const itemId = '11111111-1111-4111-8111-111111111111';
const merchantId = '22222222-2222-4222-8222-222222222222';
const detail = { itemId, merchantId, itemName: 'Item sintético', unitPrice: 10, optionGroups: [] };
const listing = { itemId, itemName: 'Item sintético', unitPrice: 10,
  merchant: { merchantId, isOpen: true, straightLineDistanceKm: 2, reviewRating: 4,
    deliveryMethod: { fee: 5, estimatedMinutes: { min: 55, max: 60 } } } };
const evaluate = (constraints: Parameters<typeof evaluateCandidate>[1], raw: unknown = listing) => evaluateCandidate({
  listing: normalizeListingItem(raw), detail: normalizeItemDetail(detail), serverFilters: [],
}, constraints);

describe('DOM-01: conversão na fronteira MCP e aritmética inteira', () => {
  it.each([[0, 0], [0.29, 29], [32.9, 3290], [1e-2, 1], [99.99, 9999]])('BRL %s vira %s centavos uma única vez', (raw, expected) => {
    expect(brlToCents(raw)).toBe(expected);
    expect(centsToBrl(expected)).toBe(raw);
  });
  it.each([-0.01, 1.005, 0.001, 1e-10, NaN, Infinity, Number.MAX_SAFE_INTEGER])('rejeita BRL inválido/subcentavo %s em vez de arredondar ou truncar', (raw) => {
    expect(() => brlToCents(raw)).toThrow(RangeError);
  });
  it('overflow e centavos fracionários são rejeitados; apresentação não calcula dinheiro em float', () => {
    expect(() => cents(1.5)).toThrow();
    expect(() => addCents(Number.MAX_SAFE_INTEGER, 1)).toThrow();
    expect(() => multiplyCents(Number.MAX_SAFE_INTEGER, 2)).toThrow();
    expect(multiplyCents(addCents(10, 20), 3)).toBe(90);
    expect(formatCents(3290)).toBe('R$ 32.90');
  });
  it('normalização distingue ausente, null e preço inválido, sem usar preço alternativo como autorização', () => {
    for (const bad of [-1, 1.005, '10']) {
      const value = normalizeItemDetail({ ...detail, promotionalUnitPrice: bad });
      expect(value.price.promotionalUnitPrice.state).toBe('INVALID');
      expect(value.price.basePrice).toBeNull();
    }
    expect(normalizeItemDetail(detail).price.promotionalUnitPrice.state).toBe('ABSENT');
    expect(normalizeItemDetail({ ...detail, promotionalUnitPrice: null }).price.promotionalUnitPrice.state).toBe('NULL');
  });
  it('base + opções × quantidade e frete fecham em centavos; serviço desconhecido não vira zero', () => {
    const priced = computePrice({ detail: normalizeItemDetail({ ...detail, unitPrice: 0.1,
      optionGroups: [{ optionGroupId: 'g', minSelections: 1, maxSelections: 1, options: [{ optionId: 'o', additionalPrice: 0.2 }] }] }),
    listing: normalizeListingItem({ ...listing, merchant: { ...listing.merchant, deliveryMethod: { fee: 0.3 } } }),
    selection: [{ optionId: 'o' }], quantity: 3 });
    expect(priced.unitTotal).toBe(30);
    expect(priced.itemsSubtotal).toBe(90);
    expect(priced.itemsAndDeliverySubtotal).toBe(120);
    expect(priced.service).toEqual({ fee: null, status: 'UNKNOWN' });
    expect(priced.estimatedTotal).toBeNull();
    expect(priced.estimatedTotalRange).toEqual({ min: 120, max: null });
    expect(priced.confirmation.total).toBeNull();
  });
});

describe('DOM-01: limites obrigatórios conferidos depois da resposta MCP', () => {
  it('prazo máximo 30 bloqueia 60 min; preferência pelo mesmo prazo só gera aviso', () => {
    const rigid = evaluate({ restrictions: [], mandatoryLimits: { maxDeliveryTimeMinutes: 30 } });
    expect(rigid.eligible).toBe(false);
    expect(rigid.limits[0]).toMatchObject({ requirement: 'MANDATORY', status: 'FAIL' });
    const soft = evaluate({ restrictions: [], preferredLimits: { maxDeliveryTimeMinutes: 30 } });
    expect(soft.eligible).toBe(true);
    expect(soft.warnings.some((w) => w.code.startsWith('PREFERRED_LIMIT_'))).toBe(true);
  });
  it('prazo em faixa atravessando o teto, ausente ou incoerente permanece UNKNOWN', () => {
    for (const eta of [{ min: 20, max: 40 }, {}, { min: 60, max: 20 }, { min: -5, max: -1 }, { min: -5, max: 20 }]) {
      const result = evaluate({ restrictions: [], mandatoryLimits: { maxDeliveryTimeMinutes: 30 } },
        { ...listing, merchant: { ...listing.merchant, deliveryMethod: { fee: 5, estimatedMinutes: eta } } });
      expect(result.eligible).toBe(false);
      expect(result.limits[0]!.status).toBe('UNKNOWN');
    }
  });
  it('frete, distância e nota obrigatórios não confiam só no filtro upstream', () => {
    const result = evaluate({ restrictions: [], mandatoryLimits: { maxDeliveryFee: 499, maxDistanceKm: 1, minRating: 4.5 } });
    expect(result.limits.map((c) => c.status)).toEqual(['FAIL', 'FAIL', 'FAIL']);
    expect(result.eligible).toBe(false);
  });
  it('arredondamento de exibição não libera distância ou nota fora do limite', () => {
    const result = evaluate({ restrictions: [], mandatoryLimits: { maxDistanceKm: 2, minRating: 4.5 } },
      { ...listing, merchant: { ...listing.merchant, straightLineDistanceKm: 2.004, reviewRating: 4.499 } });
    expect(result.limits.map((check) => check.status)).toEqual(['FAIL', 'FAIL']);
    expect(result.eligible).toBe(false);
  });
  it('loja sem isOpen comprovado não vira recomendável', () => {
    expect(evaluate({ restrictions: [] }, { ...listing, merchant: { ...listing.merchant, isOpen: undefined } }))
      .toMatchObject({ eligible: false, availability: 'UNKNOWN' });
  });
  it('orçamento considera quantidade e frete; custo desconhecido impede PASS', () => {
    const input = { listing: normalizeListingItem(listing), detail: normalizeItemDetail(detail), serverFilters: [], quantity: 2 };
    expect(evaluateCandidate(input, { restrictions: [], budget: { maxOrderTotal: 2400 } }).budget.orderTotal).toBe('FAIL');
    expect(evaluateCandidate(input, { restrictions: [], budget: { maxOrderTotal: 2600 } }).budget.orderTotal).toBe('UNKNOWN');
    expect(checkCap({ min: 100, max: 100 }, 100)).toBe('PASS');
    expect(checkCap({ min: 99, max: 101 }, 100)).toBe('UNKNOWN');
    expect(checkCap({ min: 101, max: 150 }, 100)).toBe('FAIL');
    expect(checkCap({ min: 100, max: null }, 100)).toBe('UNKNOWN');
    expect(checkCap({ min: 200, max: 100 }, 100)).toBe('UNKNOWN');
  });
  it('overflow do total bloqueia o candidato sem derrubar o pipeline', () => {
    const result = evaluateCandidate({ listing: normalizeListingItem(listing),
      detail: normalizeItemDetail({ ...detail, unitPrice: 9e13 }), serverFilters: [], quantity: 2 }, { restrictions: [] });
    expect(result.eligible).toBe(false);
    expect(result.blockers).toContainEqual(expect.objectContaining({ code: 'PRICE_UNVERIFIED' }));
  });
  it('contrato → domínio → MCP → resposta não divide/multiplica duas vezes e não filtra preferências', async () => {
    const body = EvaluateBody.parse({ query: 'sintético', userLocation: { latitude: -1, longitude: -2 },
      refinements: { maxDeliveryFeeCents: 499 }, softLimits: { maxDeliveryTimeMinutes: 30 },
      preferences: { likedIngredients: ['bacon'], priority: 'ECONOMY' } });
    const request = toDomainRequest(body);
    expect(request.refinements?.maxDeliveryFee).toBe(499);
    expect(request.preferences).toEqual({ likedIngredients: ['bacon'], priority: 'ECONOMY' });
    let sent: unknown;
    const result = await runEvaluation(request, { listAddresses: async () => ({ results: [] }),
      searchOffers: async (args) => { sent = args; return { results: [listing], hasMore: false }; },
      getItem: async () => detail });
    expect(sent).toMatchObject({ refinements: { maxDeliveryFee: 4.99 } });
    expect((sent as { refinements: object }).refinements).not.toHaveProperty('maxDeliveryTimeMinutes');
    const output = evaluateViewCents(evaluateView(result));
    expect(output.blocked[0]!.pricing.minimumConfigurable!.unitTotalCents).toBe(1000);
    expect(output.blocked[0]!.limits).toContainEqual(expect.objectContaining({ metric: 'maxDeliveryFeeCents', limitCents: 499, status: 'FAIL' }));
    expect(output.blocked[0]!.pricing.minimumConfigurable!.estimatedTotalCents).toBeNull();
    expect(output.recommendations).toEqual([]);
  });
});

const example = (): CostInput => ({
  participants: ['A', 'B', 'C', 'D', 'E'].map((participantId) => ({ participantId })),
  items: [{ itemId: 'pizza', unitPriceCents: 6000, quantity: 1, consumerIds: ['A', 'B', 'C'] },
    { itemId: 'bebida', unitPriceCents: 800, quantity: 1, consumerIds: ['A'] },
    { itemId: 'salada', unitPriceCents: 3000, quantity: 1, consumerIds: ['D'] }],
  deliveryFeeCents: 799, serviceFeeCents: 0,
  discounts: [{ discountId: 'cupom', amountCents: 1000, eligibleItemIds: ['pizza', 'bebida', 'salada'] }],
});

describe('DOM-01: rateio informativo D3, sem aprovação', () => {
  it('reproduz o exemplo adotado; pessoa sem consumo não paga taxas', () => {
    const result = allocateCosts(example());
    expect(result.totalCents).toBe(9599);
    expect(result.participants.map((p) => p.totalCents)).toEqual([2714, 1996, 1996, 2893, 0]);
    expect(result.participants.map((p) => p.deliveryCents)).toEqual([200, 200, 200, 199, 0]);
    expect(result.kind).toBe('ESTIMATE');
  });
  it('limites coletivo e individuais devem valer simultaneamente, inclusive no centavo exato', () => {
    const input = example();
    input.collectiveCapCents = 9599;
    input.participants[0]!.capCents = 2714;
    expect(allocateCosts(input).budgetsSatisfied).toBe(true);
    input.participants[0]!.capCents = 2713;
    expect(allocateCosts(input)).toMatchObject({ collectiveBudget: 'PASS', budgetsSatisfied: false });
    input.participants[0]!.capCents = 2714;
    input.collectiveCapCents = 9598;
    expect(allocateCosts(input)).toMatchObject({ collectiveBudget: 'FAIL', budgetsSatisfied: false });
  });
  it('serviço desconhecido não é taxa gratuita nem autoriza validar limites', () => {
    const input = example(); input.serviceFeeCents = null; input.collectiveCapCents = 10000;
    expect(allocateCosts(input)).toMatchObject({ kind: 'UNKNOWN', totalCents: null, collectiveBudget: 'UNKNOWN', budgetsSatisfied: false });
    expect(allocateCosts(input).participants[4]).toMatchObject({ totalCents: 0, serviceCents: 0 });
  });
  it('descontos só consomem o elegível restante; desconhecido não é aplicado', () => {
    const input = example();
    input.discounts = [{ discountId: 'b', amountCents: 10000, eligibleItemIds: ['bebida'] },
      { discountId: 'a', amountCents: 500, eligibleItemIds: ['bebida'] },
      { discountId: 'c', amountCents: 10000, eligibleItemIds: null }];
    const result = allocateCosts(input);
    expect(result.discountCents).toBe(800);
    expect(result.participants.map((p) => p.discountCents)).toEqual([800, 0, 0, 0, 0]);
    expect(result.warnings).toEqual(['DISCOUNT_ELIGIBILITY_UNKNOWN:c']);
  });
  it('pedido mínimo é conferido sem inventar valores; entrada inconsistente é rejeitada', () => {
    const input = example(); input.minimumOrderCents = 9801;
    expect(allocateCosts(input)).toMatchObject({ minimumOrder: 'FAIL', budgetsSatisfied: false });
    input.items[0]!.consumerIds.push('fora-do-grupo');
    expect(() => allocateCosts(input)).toThrow();
    expect(() => allocateCosts({ ...example(), serviceFeeCents: -1 })).toThrow();
    expect(() => splitCents(1, [{ participantId: 'a', weight: 0 }])).toThrow();
    expect(() => splitCents(1, [{ participantId: 'a', weight: 1 }, { participantId: 'a', weight: 1 }])).toThrow();
  });
  it('1000 casos com semente fixa fecham cada componente e são determinísticos sob reordenação', () => {
    let seed = 1729;
    const random = (limit: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % limit; };
    for (let n = 0; n < 1000; n++) {
      const participants = Array.from({ length: 1 + random(7) }, (_, i) => ({ participantId: `p${i}` }));
      const items = Array.from({ length: 1 + random(5) }, (_, i) => ({ itemId: `i${i}`, unitPriceCents: random(20000), quantity: 1 + random(4),
        consumerIds: participants.slice(0, 1 + random(participants.length)).map((p) => p.participantId) }));
      const input: CostInput = { participants, items, deliveryFeeCents: random(2000), serviceFeeCents: random(1000),
        discounts: [{ discountId: 'b', amountCents: random(30000), eligibleItemIds: items.map((i) => i.itemId) },
          { discountId: 'a', amountCents: random(30000), eligibleItemIds: [items[0]!.itemId] }] };
      const result = allocateCosts(input);
      const sum = (key: 'itemsCents' | 'deliveryCents' | 'serviceCents' | 'discountCents' | 'totalCents') => result.participants.reduce((s, p) => s + p[key]!, 0);
      expect(sum('itemsCents')).toBe(result.subtotalCents);
      expect(sum('deliveryCents')).toBe(input.deliveryFeeCents);
      expect(sum('serviceCents')).toBe(input.serviceFeeCents);
      expect(sum('discountCents')).toBe(result.discountCents);
      expect(sum('totalCents')).toBe(result.totalCents);
      expect(result.totalCents).toBe(result.subtotalCents + input.deliveryFeeCents! + input.serviceFeeCents! - result.discountCents);
      expect(result.participants.every((p) => Number.isSafeInteger(p.totalCents) && p.totalCents! >= 0)).toBe(true);
      expect(allocateCosts({ ...input, participants: [...participants].reverse(), items: [...items].reverse(), discounts: [...input.discounts].reverse() })).toEqual(result);
    }
  });
});
