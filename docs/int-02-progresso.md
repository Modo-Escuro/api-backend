# INT-02 #40 — progresso (pausado em 18/10/2026)

Trabalho pausado a pedido do usuário. **Nenhuma chamada autenticada ao MCP foi feita e nenhuma escrita real ocorreu.** Tudo abaixo vem de metadados já versionados, não de saídas reais.

## Base

- Branch `feat/int-02`, criada a partir de `origin/main@8a6dadc`.
- Fonte dos schemas: `fixtures/tools-list.json`, sha256 `828aebe14ce81e824634dff0936bbd08ae4d021cfd784bf4d9e1d6454de824d8` (captura de metadados da INT-01, não é evidência de saída).

## Observado nos metadados (documentado, não validado em execução)

- Ferramentas de carrinho anunciadas: `createCart`, `getCart`, `addItemToCart`, `updateCartItem`, `removeItemFromCart`, `getCartDeliveryMethods`, `setCartDelivery`, `listVouchers`, `setVoucher`, `removeVoucher`. Fora do escopo e proibidas: `setCartPayment`, `listPaymentMethods`, `submitOrder`; `getOrder` e `trackOrder` ficam para a BUY-02.
- **Nenhuma** ferramenta de carrinho anuncia `outputSchema`. O formato das respostas (cartId, cartItemId, preços, taxas, erros) continua desconhecido até haver captura real.
- Todas trazem as anotações genéricas `readOnlyHint=false`, `destructiveHint=true` e `idempotentHint=false`, inclusive leituras como `getCart`. Essas anotações não separam leitura de escrita; a classificação precisa vir da descrição e do comportamento observado.
- Nenhum input aceita chave de idempotência, requestId ou versão/ETag. `createCart` sem `cartId` de retorno (timeout ou resposta perdida) não tem recuperação documentada: até prova em contrário, é **NO-GO para retry**, e o resultado é tratado como RESULT_UNKNOWN.
- `updateCartItem` exige o estado completo do item (quantidade, opções e nota), não um delta.
- `createCart` aceita `deliveryMethod` e `paymentMethod` já na criação. A CART-01 nunca deve enviar `paymentMethod`.

## Sessão autenticada (pendente de decisão)

- Existem `.env` e `.tokens.json` locais e fora do Git na cópia principal. O `.tokens.json` é a sessão global de dev de 17/10; o access token venceu em 17/10 às 20:46 e o refresh não foi testado.
- O escopo dessa sessão inclui `mcp.cart.checkout` e `mcp.cart.payment`. Nunca usar esses escopos.
- Opção recomendada: login dedicado com tokens no scratchpad, separado da sessão global.
- O usuário confirmou que a conta é de teste/autorizada para carrinhos, sempre com confirmação por escrita. Ainda falta escolher a sessão.

## Próximos passos

1. Definir a sessão; fazer `tools/list` ao vivo e comparar o hash com a fixture.
2. Leituras: `listAddresses`, `searchOffers`/`getItem` de um item simples sem opções obrigatórias.
3. Escritas, uma de cada vez e com confirmação explícita dos argumentos: `createCart` → `getCart` → `addItemToCart` → `getCart` → `updateCartItem` → `getCart` → `removeItemFromCart` → `getCart`.
4. Sanitizar e salvar as capturas com hashes; escrever testes de contrato contra os parsers de `src/server/cart/contracts.ts` e definir GO/NO-GO por operação.
