# Requisitos — Compra com Contexto (SEMCOMP × iFood)

Fonte da verdade do MVP. Escopo fechado: **recomendação explicada**, sem checkout.

## 1. Contexto e objetivo

Usuário fornece contexto (restrições alimentares, orçamento, preferências, urgência). O app
busca ofertas reais no marketplace iFood via MCP, detalha os itens candidatos, valida as
restrições contra o que o MCP realmente expõe, compõe o preço real, ranqueia e apresenta
recomendações **explicadas** (motivo + avisos + limitações dos dados).

## 2. Integração MCP (contrato observado — não inventar)

- Endpoint: `https://consumer-mcp.ifood.com.br/marketplace` (Streamable HTTP/JSON-RPC)
- OAuth 2.1: AS `https://id.ifood.com.br`; PKCE S256; PAR; `authorization_code` + `refresh_token`
- Ferramentas usadas no MVP e uso:

| Tool | Quando | Campos usados (observados) |
|---|---|---|
| `listAddresses` | Sempre primeiro | `addressId`, `formattedAddress`, `coordinates`, `alias` (se houver) |
| `searchOffers` | Contexto → candidatos | `query` (descritivo puro), `refinements` (`maxItemPrice`, `maxDistanceKm`, `maxDeliveryTimeMinutes`, `minRating`, `sort`, `itemTaxonomy`, `itemRestrictions`), `resultKind`, `nextPageToken`, itens: `itemId`, `itemName`, `unitPrice`, `promotionalUnitPrice`, `merchant.{merchantId,merchantName,minimumOrderAmount,deliveryMethod.{fee,promotionalFee,estimatedMinutes},reviewRating,straightLineDistanceKm,isOpen}` |
| `getItem` | Antes de recomendar/preço final | `itemName`, `itemDescription`, `unitPrice`, `promotionalUnitPrice`, `merchantMinimumOrderAmount`, `optionGroups[].{optionGroupId,name,minSelections,maxSelections,options[].{optionId,name,additionalPrice,description?}}` |
| `getMerchant` | Opcional (detalhe da loja) | campos operacionais retornados |
| `browseOffers` | Fallback sem termo descritivo | idem discovery, exige `merchantType` |
| `getRecommendations` | Opcional | `contentMode` |

Regras de contrato:
- `query` separado de `refinements` (nunca "pizza barata" no query).
- Preços promocionais são escalares (`promotionalUnitPrice`, `promotionalFee`).
- Nenhum campo além dos observados pode ser assumido; se ausente ⇒ tratar como "não disponível".

## 3. Requisitos funcionais

### FR-1 — Entrada de contexto
- Formulário: restrições alimentares (ex.: vegano, vegetariano, sem lactose, sem glúten, sem carne suína), orçamento máximo (item e/ou pedido), preferências/cravings (texto), ordenação desejada (mais barato / mais rápido / melhor avaliado).
- Restrições são **declarações do usuário**, não diagnóstico.

### FR-2 — Endereço
- Chamar `listAddresses` antes de qualquer fluxo.
- 0 endereços ⇒ pedir endereço ao usuário (criação de endereço é opcional e manual).
- 1 endereço ⇒ usar direto, exibir na UI.
- Múltiplos ⇒ deixar o usuário escolher (usar `alias`).

### FR-3 — Descoberta
- `searchOffers` com `query` descritivo derivado das preferências + `refinements` do contexto (preço, distância, tempo, rating).
- Onde aplicável, usar `itemRestrictions` (`VEGAN`, `VEGETARIAN`, `LAC_FREE`, `GLUTEN_FREE`, `ORGANIC`, `SUGAR_FREE`) como filtro do lado do servidor.
- Paginar via `nextPageToken` até limite configurado (default: 2 páginas / no máx. 40 candidatos).

### FR-4 — Detalhamento
- Todo candidato passa por `getItem` antes de entrar no ranking final (top-N, default 10).
- Sem `getItem` ⇒ item **não** é recomendável (só listado como "não detalhado", se necessário).

### FR-5 — Validação de restrições
- Modelo tri-estado por restrição × item: `PASS` | `FAIL` | `UNKNOWN`.
- Derivação:
  - Filtro server-side bem-sucedido (ex.: `itemRestrictions: VEGAN` no request/refinements) ⇒ evidência.
  - Nomes de opções/itens (ex.: "Bacon", "Mussarela Vegana", "Catupiry", "Atum") ⇒ heurística com confiança e **sempre rotulada como heurística na UI**.
  - Informação inexistente no payload (ex.: alérgenos, glúten) ⇒ `UNKNOWN` ⇒ UI exibe "informação indisponível — verifique com a loja", **nunca** "livre de X".
- Item com qualquer restrição `FAIL` ⇒ excluído do ranking padrão (visível em "ignorar restrição").
- Herança de restrição do pedido pelo ingrediente só é afirmada se houver dado real; senão `UNKNOWN`.

### FR-6 — Cálculo de preço (honesto)
- Preço-base = `promotionalUnitPrice ?? `unitPrice`.
- Preço final = base + Σ `additionalPrice` das opções selecionadas.
- Respeitar `minSelections`/`maxSelections` por grupo (obrigatórias ≠ opcionais).
- Exibir: preço do item, desconto da promo (base promo vs `unitPrice`), taxa de entrega (`promotionalFee ?? fee`), total estimado (itens + entrega), e aviso se < `merchantMinimumOrderAmount` (`merchantMinimumOrderAmount` do `getItem`).
- Não usar preço do `searchOffers` como definitivo sem `getItem`.

### FR-7 — Ranking explicável
- Filtro duro: `isOpen`, restrição `FAIL`, itens não detalhados.
- Score composto (pesos ajustáveis, documentados na resposta): aptidão às restrições (PASS > UNKNOWN), desconto promo, preço final vs orçamento, `reviewRating`, `straightLineDistanceKm`, `estimatedMinutes` de entrega.
- Ordenação alternativa quando o usuário prioriza custo/tempo/avaliação.

### FR-8 — Recomendação explicada
- Cada resultado carrega: `motivos[]` (por que entrou: "vegano confirmado", "42% off", "1,9 km"), `avisos[]` ("alérgenos não informados", "falta R$ 3 para o mínimo"), `score` e contribuição por fator.
- Exibir `itemDescription` original e limitações de dados explicitamente.

### FR-9 — Interface
- 3 telas: Contexto → Resultados (ranking com preços compostos e avisos) → Detalhe (opções, limites, composição de preço, explicação).
- Estados: carregando, erro MCP (mensagem do `errors[].message`), sem resultados, dado ausente.

## 4. Requisitos não funcionais

- **Segurança**: segredos só via env/`.gitignore`; tokens fora de respostas HTTP/UI; sem PII em log; `userId` nunca manipulado.
- **Sem escrita no iFood**: nenhum `createCart`/`addItemToCart`/`updateCartItem`/`setCart*`/`setVoucher`/`submitOrder`/`createAddress` automático no fluxo do MVP.
- **Testabilidade**: `domain/*` puro, testável com fixtures de respostas reais (fixtures nunca contêm segredos).
- **Resiliência**: retry apenas para `retryable`; timeout de 15s por chamada; cache em memória (TTL ~60s) para `getItem`.
- **Desempenho**: E2E < 10s com N=10 detalhamentos (execução paralela limitada, ex.: 4).

## 5. Fora de escopo (MVP)
Checkout, carrinho automático, pagamentos, vouchers, rastreio de pedidos, cadastro/login próprio (usa OAuth do iFood), multi-endereço avançado, persistência de histórico.

## 6. Critérios de aceite do fluxo E2E
1. Usuário preenche contexto → app resolve endereço real via `listAddresses`.
2. `searchOffers` real retorna candidatos com preços/IDs do marketplace.
3. Top candidatos passam por `getItem` e exibem `optionGroups` com limites e preços adicionais.
4. Restrições avaliadas em tri-estado; `UNKNOWN` visível na UI como indisponível.
5. Preço exibido = composição real; mínimo do lojista sinalizado.
6. Ranking ordenado com score e cada item com `motivos[]`/`avisos[]`.
7. Nenhuma escrita no iFood; nenhuma credencial em log/repositório/JSON de resposta.
