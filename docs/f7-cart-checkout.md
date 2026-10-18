# F7 — Carrinho e preparação para checkout

Implementação do carrinho com gateway MCP por vínculo e testes offline. **Envio de pedido e aprovação de compra
permanecem desabilitados**, inclusive quando o carrinho é habilitado. Login não autoriza compra.

Auditoria INT-01: [matriz de evidências, correção de respostas desconhecidas e ensaio autenticado pendente](int-01-audit.md). A correção não valida saídas reais nem habilita a integração.

**Escopo vigente:** a [DEC-01 D8](decisoes-conversacionais.md) adota sacola simulada e MCP somente leitura. Manter `IFOOD_CART_ENABLED=false`; este documento descreve o adaptador legado e não autoriza preparação de carrinho real na demo. Validação futura de outputs não basta para alterar essa decisão de escopo. Aprovação fictícia não usa `/purchase-approvals` nem envia pedido.

## Evidência do contrato e limite da entrega

Os nomes, parâmetros, obrigatoriedade e formatos de entrada foram inspecionados em `fixtures/tools-list.json`,
captura real já existente, e comparados com `documenta_o_oficial_ifood_mcp.md`. Não foi usada sessão OAuth global,
não foram lidos tokens locais e nenhuma operação real de carrinho/pedido foi executada nesta implementação.

| Tool | Entrada utilizada |
|---|---|
| `createCart` | `merchantId`, `addressId`, `items[{itemId,quantity,options,customerNote?}]`; sem reorder, entrega ou pagamento implícitos |
| `getCart` | `cartId` |
| `addItemToCart` | `cartId`, `itemId`, `quantity`, `options` completo, `customerNote?` |
| `updateCartItem` | os anteriores + `cartItemId`; item do catálogo deve coincidir com a linha existente |
| `removeItemFromCart` | `cartId`, `cartItemId` |
| `getCartDeliveryMethods` / `setCartDelivery` | `cartId` / `cartId,deliveryMethodId,selectedTimeSlotId?` |
| `listPaymentMethods` / `setCartPayment` | `merchantId` / `cartId,paymentMethodId,cardTokenId?` |
| `listVouchers` / `setVoucher` / `removeVoucher` | `cartId` / `cartId,code,campaignId` / `cartId` |

A captura **não contém outputSchema nem respostas reais de carrinho**. Os HTMLs locais do portal não fornecem
payloads úteis dessas respostas. Portanto, o adaptador de saída é **provisório**, exercitado com MCP sintético;
não é evidência de integração validada com o iFood. Formatos desconhecidos produzem `CART_CONTRACT_UNVERIFIED`.
Confirmações de escrita de formato desconhecido não marcam a intenção como DONE; mantêm RESULT_UNKNOWN. Além do cartId na criação, as demais mutações reconhecem provisoriamente apenas `{success:true}` direto ou em `data`, sem campos adicionais nesse objeto de confirmação. É o formato dos fakes, ainda sem comprovação do provedor. Erro no envelope ou dentro de `data` bloqueia antes da projeção.

Os DTOs abaixo especificam o que o adaptador aceita; não afirmam que o provedor devolva esse formato:

```text
getCart: { cartId, merchantId, addressId, items: [{cartItemId,itemId,quantity,options,customerNote?}],
           totals?: {subtotal,deliveryFee,serviceFee,discount,total},
           deliveryMethod?: {deliveryMethodId,selectedTimeSlotId?},
           paymentMethod?: {paymentMethodId}, vouchers?: [{code,campaignId}] }
getCartDeliveryMethods: { deliveryMethods: [{deliveryMethodId,timeSlots?: [{timeSlotId}]}] }
listPaymentMethods: { paymentMethods: [{paymentMethodId,cardTokenId?,type?}] }
listVouchers: { vouchers: [{code,campaignId}] }
```

Aceitam-se esses objetos diretamente ou em `data`. Não há busca recursiva por campos parecidos, inferência de
unidades ou fallback para preços do catálogo. UUIDs seguem os inputs capturados; a descrição de pagamento dá
exemplos como PIX, mas o schema exige UUID: uma resposta incompatível precisa ser verificada antes de ampliar
o adaptador. Totais BRL completos, finitos, não negativos e com precisão de centavos são convertidos na borda;
`subtotal + deliveryFee + serviceFee - discount` deve coincidir com `total`. Ausência ⇒ `UNAVAILABLE` e valores
`null`; divergência ⇒ `DIVERGENT` e revisão bloqueada. Não se completam componentes ausentes com zero.

Por essas limitações e pela DEC-01, manter `IFOOD_CART_ENABLED=false`. Validar saídas não autoriza mudar o escopo simulado. As correções relacionadas a #2/#3 já foram incorporadas de origin/main (20e46fd e 686300d). Essa flag não habilita checkout.

## Associação, proveniência e validação

- Todas as rotas usam `botAuth` existente: Bearer do adaptador + `X-Telegram-User-Id` validado contra allowlist.
  Nunca aceitar identidade do organizador no corpo ou usar IDs do texto da LLM como prova de propriedade.
- Exigem vínculo confirmado, operacional, `linkId` atual e escopos. `CART_READ`: `mcp.cart.read`;
  `CART_WRITE`: read + `mcp.cart.write`; operações de pagamento também exigem `mcp.cart.payment`.
  O catálogo usa a permissão existente `OFFERS_EVALUATE`.
- `catalog` confere `addressId` em `listAddresses`, busca candidatos e chama `getItem`.
  Só esses resultados geram `itemRef` opaco, limitado ao organizador, vínculo e endereço, válido por 5 minutos.
  A referência **não comprova elegibilidade alimentar** e não altera o domínio de elegibilidade.
- `createCart` deriva loja/endereço dos itens; todos devem pertencer à mesma loja/endereço. Não recebe `cartId`,
  `merchantId`, `orderId`, preços ou consentimento do chamador. `cartRef` opaco associa o cartId real ao vínculo.
- Quantidades de itens: inteiros 1–20, até 20 linhas. `getItem` é consultado novamente antes de adicionar/atualizar.
  Opções devem existir, ser distintas, respeitar min/max e ter configuração `VALID`. Quantidade de opção é 1:
  repetição não foi verificada pelo provedor. Variantes são selecionadas pelos optionGroups observados; campos
  avulsos `variantId` e customizações não verificadas são rejeitados, sem inventar IDs ou regras.
- Atualização exige conjunto completo de opções, não um patch de complementos; `options: []` só é aceito quando
  todos os grupos realmente permitem isso. Informação ausente, nula ou inválida bloqueia a configuração.
- Sessão de carrinho própria por vínculo, sem fallback global. O transporte não repete chamadas após 401.
  Estado do vínculo é rechecado antes/depois de cada tool; desconexão/troca de conta bloqueia acesso às referências
  anteriores. Token expirado no mesmo linkId provoca verificação/refresh antes de bloquear: erro temporário mantém UNAVAILABLE; refresh recusado exige reconexão. Isso não desfaz uma mutação já enviada ao provedor.

## Endpoints do Telegram

Prefixo `B = /api/bot/cart`. JSON é estrito. Dinheiro externo é BRL em centavos inteiros, sempre campos `*Cents`.
`requestId` é UUID gerado **pelo adaptador**, antes do primeiro envio; preservar esse valor em retries da mesma
intenção. Novo clique intencional é outra intenção; nunca trocar o ID apenas para contornar `RESULT_UNKNOWN`.

| Método / rota | Corpo ou query |
|---|---|
| `POST B/catalog` | `{linkId,addressId,query}` → itens com `itemRef` e optionGroups (preço adicional em centavos) |
| `POST B` | `{linkId,requestId,items:[{itemRef,quantity,options:[{optionId,quantity:1}],customerNote?}]}` |
| `GET B/:cartRef` | query `linkId` |
| `POST B/:cartRef/items` | `{linkId,requestId,item:{itemRef,quantity,options,customerNote?}}` |
| `PUT B/:cartRef/items/:cartItemId` | mesmo corpo; `cartItemId` precisa constar no getCart deste carrinho |
| `DELETE B/:cartRef/items/:cartItemId` | `{linkId,requestId}` |
| `GET B/:cartRef/delivery` | query `linkId` → escolhas opacas `choiceRef` |
| `PUT B/:cartRef/delivery` | `{linkId,requestId,choiceRef}` |
| `GET B/:cartRef/payment` | query `linkId` → escolhas opacas, sem token de cartão |
| `PUT B/:cartRef/payment` | `{linkId,requestId,choiceRef}` |
| `GET B/:cartRef/voucher` | query `linkId` → escolhas opacas |
| `PUT B/:cartRef/voucher` | `{linkId,requestId,choiceRef}` |
| `DELETE B/:cartRef/voucher` | `{linkId,requestId}` |
| `POST B/:cartRef/review` | `{linkId}` → revisão informativa com expiração de 5 minutos |
| `POST B/:cartRef/approve` e `/submit` | `{linkId,reviewId}` → sempre `409 CHECKOUT_DISABLED`, nenhuma tool chamada |

Entrega/pagamento/cupom são listados antes da escolha e novamente antes da aplicação. Referências de escolha
expiram em 5 minutos ou ao mudar a revisão; não são IDs inventados pela LLM. Cartões são mostrados apenas como
escolhas numeradas nesta etapa. O cardTokenId é usado transitoriamente na seleção, nunca persistido nem enviado
ao bot. Não se armazenam PAN, CVV, CPF/CNPJ ou respostas brutas de pagamento. A identidade completa do cartão
na interface depende de contrato sanitizado verificado numa etapa posterior.

Resposta de carrinho: `cartRef`, `linkId`, `revision`, `state: DRAFT|RESULT_UNKNOWN`, `items`, `money`,
`totals: {status,values}`, `delivery`, `payment`, `vouchers`, `review`, `blockers`, `checkoutEnabled:false`,
`purchaseAuthorized:false`. Valores monetários são lidos **exclusivamente** de getCart; consistência aritmética
não comprova elegibilidade alimentar nem autorização de compra. Erros não devolvem o payload bruto do provedor.

## Concorrência, retries e resultado desconhecido

Operações de F7 são serializadas por organizador. A chave `(organizador,linkId,requestId)` identifica a intenção;
reutilizá-la com outro conteúdo gera `IDEMPOTENCY_CONFLICT`. Após sucesso conhecido, um retry só lê getCart. Há um único registro por requestId, marcado DONE imediatamente após a confirmação da tool, antes da leitura posterior. Entrega, pagamento e cupom usam a assinatura da escolha externa, sem registrar tokens de cartão. Retries de adicionar/atualizar itens consultam a intenção antes de validar novamente itemRef/getItem; a expiração do catálogo não impede reler uma escrita já confirmada.
Falha da leitura posterior não repete a escrita. Não há retry automático, mesmo quando erro inline diz retryable.

Após timeout/erro de transporte/erro inline de uma escrita, o resultado fica desconhecido de forma conservadora.
Novas escritas nesse carrinho são bloqueadas, inclusive com outro requestId. Em criação sem cartId confirmado,
novas criações desse organizador/vínculo são bloqueadas. GET posterior não prova que uma escrita atrasada não
será aplicada e não limpa esse estado automaticamente. Não há endpoint de recuperação que simplesmente
"force sucesso": é necessária reconciliação pelo contrato do provedor antes de retomar.

Estado de carrinhos, catálogo e intenções é **em memória, um único processo**, como recorte de demo. Reinício
perde as referências (devolverão 404), mas pode deixar carrinho remoto existente; **não reexecutar intenções
automaticamente ao reiniciar**. Persistência durável de intenções, recuperação/reconciliação de criação sem ID,
limpeza de carrinhos remotos, quotas, expurgo de referências antigas e execução multiprocesso são pendências
para habilitação real. As travas de F7 não serializam todo o ciclo de vida de autenticação.

## F7.3 — Revisão e aprovação futura

Qualquer escrita invalida revisão e escolhas antes de enviar a tool. Uma leitura que detecta mudança na resposta
de getCart também invalida: o fingerprint SHA-256 inclui todo o payload, sem armazená-lo. Assim detecta itens,
quantidades, notas, opções, totais, entrega, cartão e cupons sem guardar dados sensíveis. Troca de linkId bloqueia
o carrinho antigo. Revisão exige itens, entrega, pagamento e totais completos/coerentes; caso contrário bloqueia.

No Telegram, apresentar o resumo e os bloqueios; nesta fase **não mostrar botão habilitado de compra**.
A resposta traz `approvalEnabled:false`. Login, revisão, mensagem "sim", booleano de consentimento e saída de LLM
não constituem autorização de compra. O backend não emite autorização nesta etapa.

O contrato futuro deverá vincular callback humano validado do Telegram ao organizador, linkId, reviewId,
revision, fingerprint, total em centavos e expiração. O adaptador autentica e valida `callback_query.from.id`,
conversa privada e callback de uso único; esses dados não vêm do modelo. Antes do envio será necessário reler
getCart, confrontar a revisão e consumir a aprovação atomicamente com uma intenção durável de checkout.

`cart/approval.ts` fornece somente uma política pura usada por testes de simulação. Ela não emite evidência nem
é ligada a rotas. Os testes de submitOrder usam vi.fn e respostas sintéticas, sem transporte real. A allowlist
de F7 e o gateway de leitura rejeitam submitOrder em runtime; a regra de lint continua proibindo envio real.

## Dependências de segurança e critérios antes de PR/checkout real

- **Correções #2/#3 integradas:** origin/main foi incorporada à branch F7, incluindo 20e46fd e 686300d. O bloqueio fixo SECURITY_ISSUES_2_3_PENDING foi removido. A referência de catálogo e a revisão de F7 continuam com `ELIGIBILITY_UNVERIFIED`; não autorizam consumo nem compra.
- Capturar/validar saídas reais por sessão de vínculo, sem realizar compra; ajustar parsers e sanitização.
- Garantir elegibilidade rastreável por pessoa/opções e manter os testes das correções de segurança.
- Implementar armazenamento durável, reconciliação, expiração/limpeza, aprovação humana de uso único e proteção
  contra execução concorrente. Definir explicitamente semântica de idempotência e resultado desconhecido do submit.
- Só então discutir habilitação de checkout, com revisão de segurança separada. **Nenhum PR/merge/push automático.**

## Validação

`test/cart/` usa AS e MCP falsos. Cobre isolamento, conta desconectada/trocada, provas de IDs, limites/opções,
fluxo HTTP, entrega/pagamento/cupons, totais ausentes/divergentes, revisão invalidada, idempotência, timeout,
falha de getCart depois de escrita, transporte sem replay 401 e submitOrder exclusivamente simulado.
Comparação com a revisão-base e resultados completos estão em `docs/f7-validation.md`.


## Catálogo parcial e limites de detalhamento (revisão do PR #4)

Depois de listAddresses e searchOffers, o lote de getItem tem prazo total de 25 segundos, no máximo 3 chamadas
simultâneas e 10 candidatos. Cada chamada recebe timeout de até 15 segundos, limitado ao prazo restante, e
AbortSignal. O servidor também limita a espera local mesmo se o provedor ignorar o timeout; respostas tardias
não publicam referências nem alteram o catálogo. Cancelamento remoto é melhor esforço. O orçamento de 25 segundos
é da fase de detalhamento, não das verificações do vínculo, listAddresses ou searchOffers anteriores.

A falha de um detalhe não elimina os outros. Itens válidos são publicados na ordem da listagem e acompanhados de
`partial`, `errors: [{itemId,kind,code}]` e `details: {requested,detailed,failed,skippedDeadline,deadlineReached}`.
Erros não carregam mensagens brutas do provedor. Falhas de credencial rejeitada encerram a operação de conta,
em vez de oferecer um catálogo parcial usando uma sessão inválida. Se todos os detalhes falharem, a resposta
é um catálogo vazio com partial=true e os erros correspondentes; nenhum itemRef é inventado para itens falhos.
