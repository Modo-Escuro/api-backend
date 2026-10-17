# Auditoria de preço — semântica de `additionalPrice` (2026-10-17)

## Pergunta
A "Promoção pizza grande" saía por **R$ 143** pela regra documentada
(`promotionalUnitPrice` 65 + 2 sabores obrigatórios × `additionalPrice` 39). O valor está correto?

## O que o MCP diz (e não diz)
- `getItem` (schema e descrição): não documenta como `unitPrice` e `additionalPrice` se combinam.
- `addItemToCart` (schema, **não chamado**): `options[].quantity` ("almost always 1") e `customizations[]` existem;
  nada sobre composição de preço nem limite por opção.
- `getCart` traria os totais, mas exige carrinho (`createCart`/`addItemToCart`), **proibido no MVP**.
- As páginas HTML locais do portal são cascas de SPA idênticas, sem conteúdo.

**Não há evidência documental da semântica.**

## Evidência nos dados (38 itens reais, `fixtures/getItem-samples.json` + `fixtures/getItem-pricing-audit.json`)
Em **11 de 38** itens, `unitPrice` é **exatamente** a soma das opções obrigatórias mais baratas:

| Item | unitPrice | promo | opções obrigatórias |
|---|---|---|---|
| Promoção pizza grande | 78 | 65 | 2 sabores × 39 (todos 39) |
| GRANDE 2 SABORES (8 PEDAÇOS) | 44.98 | 44.98 | 22.49 + 22.49 |
| GRANDE 2 SABORES | 78 | 78 | 39 + 39 (até 42) |
| Pizzas Doces Grandes | 75.99 | 75.99 | 1 sabor × 75.99 |
| Açai Artesanal | 24 | 21 | tamanho: 300g=24, 500g=36, 1kg=68, 3,6kg=215 |
| Meio a Meio de Pizzas Salgadas | 49.58 | 49.58 | 2 metades, 24.79–50.95 |
| … (mais 5) | | | |

Nos demais itens as opções são claramente **acréscimos** (ex.: "Pizza Grande | 8 Pedaços": sabores +0/+3.9,
borda +0/+14.9/+19.9; "Maria salada Veg": batata +8.9). **O catálogo usa os dois modelos.**

Pela regra documentada, os itens do padrão ficariam implausíveis (açaí 300g = R$ 45 com promo, pizza doce =
R$ 151.98), o que sugere que neles `unitPrice` é um "a partir de" derivado das opções.
**Isso é inferência, não confirmação.**

## Decisão (sem corrigir por suposição)
- `detectFromPricePattern`: marca o padrão quando Σ(opções obrigatórias mínimas) = `unitPrice` (ou promo).
- O preço passa a ter duas interpretações, e o resultado vira **faixa** com `status: UNCERTAIN`:
  - `BASE_PLUS_OPTIONS` (regra documentada): base + Σ opções;
  - `OPTIONS_ARE_PRICE`: Σ opções, com a promo do item aplicada ou não (o MCP não diz).
- Pizza: **R$ 65–143** por unidade (R$ 65 = 78 − 13 de promo; R$ 78 sem promo; R$ 143 pela regra).
- Orçamento só passa se a **faixa inteira** couber no teto; faixa que cruza o teto ⇒ `UNKNOWN` ⇒ bloqueia.
- Pedido mínimo: `met: null` quando a faixa cruza o mínimo.
- `confirmation.total` é sempre `null`.

## Como resolver de vez
Só um `getCart` com o item configurado confirmaria. Isso exige criar carrinho e está fora do escopo do MVP.
Se o time liberar um teste manual controlado no app/carrinho do iFood (sem `submitOrder`), comparar o total
de 2–3 itens do padrão com as duas interpretações e atualizar este documento.
