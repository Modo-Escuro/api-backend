# Requisitos — Compra com Contexto (SEMCOMP × iFood)

## Estado deste documento

Este é o recorte histórico de recomendação da API, não a StRS nem uma lista de capacidades implantadas. O [plano vigente](plano-conversacional.md) registra as implementações e integrações confirmadas pelo Git e a preparação real confirmada definida na DEC-01. Preservam-se os IDs FR e os trechos históricos para rastreabilidade.

**Precedência vigente nesta revisão sobre `origin/main@f3b8b55`, 18/10/2026:** alergias e restrições `MANDATORY` nunca podem ser ignoradas; `UNKNOWN` obrigatório não é elegível e nunca vira `PASS` por pontuação. Preferências opcionais não bloqueiam configurações válidas. Dinheiro no domínio e na API já está em centavos inteiros ([DOM-01](dom-01-centavos-limites.md), PR #31); desconhecido não vira zero. Somente candidatos elegíveis podem ser recomendados, com ordenação da [RANK-03 / contrato de avaliação 2.0](rank-03-contrato-v2.md), integrada pelo PR #34. As [decisões D1–D10 vigentes](decisoes-conversacionais.md) exigem carrinho real preparado somente após confirmação humana específica PREPARE_CART. Composição local não é carrinho remoto nem entrega alternativa. Envio e pagamento continuam proibidos. Integração real com iFood e validação ponta a ponta ficam para depois das tasks; não foram verificadas nesta auditoria documental.

Formulação histórica do MVP: **recomendação explicada**, sem checkout. A [StRS v0.2 preservada](https://github.com/Modo-Escuro/telegram-bot/blob/main/docs/baseline/stakeholder-requirements-specification.md), as decisões adotadas e os contratos vigentes não são alterados por esta atualização.

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
> **Regra vigente junto ao registro histórico:** alergias são obrigatórias; restrição `MANDATORY` com `FAIL` ou `UNKNOWN` impede recomendação. Não existe ação de ignorá-las. Filtro de dieta e heurística não comprovam segurança de alergia. `PREFERENCE` não proíbe uma configuração obrigatoriamente válida; gera aviso quando não atendida (RANK-01/02).

- Modelo tri-estado por restrição × item: `PASS` | `FAIL` | `UNKNOWN`.
- Derivação:
  - Filtro server-side bem-sucedido (ex.: `itemRestrictions: VEGAN` no request/refinements) ⇒ evidência.
  - Nomes de opções/itens (ex.: "Bacon", "Mussarela Vegana", "Catupiry", "Atum") ⇒ heurística com confiança e **sempre rotulada como heurística na UI**.
  - Informação inexistente no payload (ex.: alérgenos, glúten) ⇒ `UNKNOWN` ⇒ UI exibe "informação indisponível — verifique com a loja", **nunca** "livre de X".
- **Histórico superado — não implementar:** item com qualquer restrição `FAIL` ⇒ excluído do ranking padrão (visível em "ignorar restrição"). A referência antiga a ignorar restrição não se aplica a alergias nem a `MANDATORY`; prevalece a regra acima.
- Herança de restrição do pedido pelo ingrediente só é afirmada se houver dado real; senão `UNKNOWN`.

### FR-6 — Cálculo de preço (honesto)
> **DOM-01 vigente:** os cálculos são em centavos inteiros; BRL cru do MCP é convertido na normalização. Itens × quantidade + entrega conhecidos são subtotal parcial quando falta serviço, não total completo nem cotação confirmada. `UNKNOWN` não vira zero. A descrição original abaixo não autoriza completar taxas ausentes.

- Preço-base = `promotionalUnitPrice ?? unitPrice`.
- Preço final = base + Σ `additionalPrice` das opções selecionadas.
- Respeitar `minSelections`/`maxSelections` por grupo (obrigatórias ≠ opcionais).
- Exibir: preço do item, desconto da promo (base promo vs `unitPrice`), taxa de entrega (`promotionalFee ?? fee`), total estimado (itens + entrega), e aviso se < `merchantMinimumOrderAmount` (`merchantMinimumOrderAmount` do `getItem`).
- Não usar preço do `searchOffers` como definitivo sem `getItem`.

### FR-7 — Ranking explicável
> **RANK-03 vigente, PR #34 (`2df4e54`):** somente `ELIGIBLE` entra em recomendações. ECONOMY compara total completo estimado → prazo → preferências atendidas; SPEED compara prazo → total → preferências atendidas, com desconhecidos depois dos conhecidos em cada chave. Score é diagnóstico relativo à consulta, não decide ordem nem probabilidade de satisfação/segurança. Sem prioridade ECONOMY/SPEED, pedir esclarecimento. Os bullets seguintes preservam a proposta antiga, não o algoritmo vigente; `UNKNOWN` obrigatório nunca concorre com `PASS`.

- Filtro duro: `isOpen`, restrição `FAIL`, itens não detalhados.
- **Proposta histórica substituída pela RANK-03:** score composto (pesos ajustáveis, documentados na resposta): aptidão às restrições (PASS > UNKNOWN), desconto promo, preço final vs orçamento, `reviewRating`, `straightLineDistanceKm`, `estimatedMinutes` de entrega. A comparação antiga PASS > UNKNOWN não torna dado obrigatório desconhecido elegível.
- **Proposta histórica:** ordenação alternativa quando o usuário prioriza custo/tempo/avaliação. A ordem e os pesos diagnósticos atuais são os documentados na RANK-03.

### FR-8 — Recomendação explicada
> **Leitura vigente:** motivos, cobertura e limitações não são prova de segurança alimentar. Apenas elegíveis são recomendados; falta de evidência obrigatória permanece em `needsVerification`, fora das recomendações. O score da RANK-03 é diagnóstico, não confirmação de adequação.

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
> Critérios históricos, não resultados de testes ou ensaio online desta auditoria. No comportamento atual, `UNKNOWN` obrigatório bloqueia, o preço é estimativa/faixa e o ranking segue D9/RANK-03, não ordem por score. A validação real com iFood será feita depois das tasks.

1. Usuário preenche contexto → app resolve endereço real via `listAddresses`.
2. `searchOffers` real retorna candidatos com preços/IDs do marketplace.
3. Top candidatos passam por `getItem` e exibem `optionGroups` com limites e preços adicionais.
4. Restrições avaliadas em tri-estado; `UNKNOWN` visível na UI como indisponível.
5. Preço exibido = composição real; mínimo do lojista sinalizado.
6. Ranking ordenado com score e cada item com `motivos[]`/`avisos[]`.
7. Nenhuma escrita no iFood; nenhuma credencial em log/repositório/JSON de resposta.

## 7. Carrinho real confirmado e limite da F7 legada

O único escopo de carrinho é real, com confirmação humana específica PREPARE_CART. A composição local da GRP-01 deve alimentar a CART-01; não é resultado remoto nem alternativa de aceite. Reutilizar DATA-01, GRP-01 e DOM-01 sem duplicar carrinho, restrições ou rateio.

A F7 legada do PR #4 (`cbb546c`) continua desligada: não possui as garantias completas da CART-01. Sua flag não habilita o novo fluxo. A implementação CART-01 auditada permanece local; não foi publicada por esta revisão documental. INT-02 #40 exige outputs reais, unidades, erros e reconciliação por operação antes da ativação. Preservar intenção PENDING/SUCCEEDED/FAILED/RESULT_UNKNOWN e bloquear repetição após resultado desconhecido.

Confirmar conta/vínculo, endereço, loja, produtos/opções/quantidades, evidência alimentar por consumidor, versão/hash e validade antes de cada escrita. Mudança relevante exige nova revisão/confirmação. Não enviar pedido (`submitOrder`), selecionar/processar pagamento (`setCartPayment`) nem alterar produção neste incremento. Login, senha e texto da IA não confirmam preparação.
