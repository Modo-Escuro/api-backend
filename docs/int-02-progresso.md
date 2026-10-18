# INT-02 #40 — preparação offline e gate de evidências

**Consumidor em continuação local:** [CART-01 integrada offline](cart-01-conclusao-offline.md) reutiliza estes regressores sobre a main com #48 e preserva o gate de evidência. O merge #48 não trouxe capturas de negócio; os NO-GO abaixo continuam válidos.

Atualização offline em **18/10/2026**. A issue [#40](https://github.com/Modo-Escuro/api-backend/issues/40) permanece **aberta**: testes sintéticos não concluem a validação real. Nesta etapa não houve chamada ao MCP, login, leitura de credenciais, operação real de carrinho, envio ou pagamento. Flags, produção e deploy não foram alterados.

## Base

- Histórico: a preparação anterior foi iniciada em `feat/int-02`, a partir de `origin/main@8a6dadc`.
- Revisão atual: `branchBruna`, consumidor `edb80b9e98c81f3cf5cb4ed9692c85de2dfd0faf` + diff offline desta entrega. `.agents/pipeline/` preexistente preservado. Registrar o SHA definitivo do consumidor antes do ensaio autenticado.
- Fonte dos schemas: `fixtures/tools-list.json`, sha256 `828aebe14ce81e824634dff0936bbd08ae4d021cfd784bf4d9e1d6454de824d8` (captura de metadados da INT-01, não é evidência de saída).
- Metadados adicionais fornecidos pelo usuário na INT-01: `fixtures/int01/metadata-20261018.json`, sha256 `e35902950bd03b27969981c37cb0607342a8b650359468232123e9f000fb6db5`. A projeção não contém schemas completos nem outputs de negócio.
- Parser reutilizado: `src/server/cart/contracts.ts`, sha256 `7c083ade3b39efad96eae02609a614c89191446e090443477cb475d127ec5b42`. Transporte F7 existente preservado; o serviço recebeu apenas o guard descrito abaixo. A CART-01 nova não está presente nesta cópia; seu estado local/remoto está descrito em [estado-remoto-local.md](estado-remoto-local.md). Esta preparação não substitui sua integração, persistência ou confirmação humana.

## Classificação de evidência

- **OBSERVADO — somente metadados:** nomes e inputs em `tools-list.json`; projeção autenticada fornecida pelo usuário na INT-01. A nova revisão não executou `tools/list`. **Nenhum output de carrinho observado.**
- **DOCUMENTADO:** descrições dos schemas e `documenta_o_oficial_ifood_mcp.md` indicam cartId, estado, BRL decimal e erros inline. Autoridade/versão externa não revalidada; não comprovam o formato real de saída.
- **SINTÉTICO:** `{cartId}`, envelope `{data: ...}`, snapshot F7, totais e `{success:true}` dos testes. Reconhecer esses formatos no parser não os promove a contratos reais nem dá GO operacional. Preço unitário de linha/opção ainda não tem parser de saída validado: não adicionar campos por suposição nem derivá-los dos totais.

### Achados dos metadados versionados

- Ferramentas de carrinho anunciadas: `createCart`, `getCart`, `addItemToCart`, `updateCartItem`, `removeItemFromCart`, `getCartDeliveryMethods`, `setCartDelivery`, `listVouchers`, `setVoucher`, `removeVoucher`. Fora do escopo e proibidas: `setCartPayment`, `listPaymentMethods`, `submitOrder`; `getOrder` e `trackOrder` ficam para a BUY-02.
- **Nenhuma** ferramenta de carrinho anuncia `outputSchema`. O formato das respostas (cartId, cartItemId, preços, taxas, erros) continua desconhecido até haver captura real.
- Todas trazem as anotações genéricas `readOnlyHint=false`, `destructiveHint=true` e `idempotentHint=false`, inclusive leituras como `getCart`. Essas anotações não separam leitura de escrita; a classificação precisa vir da descrição e do comportamento observado.
- Nenhum input aceita chave de idempotência, requestId ou versão/ETag. `createCart` sem `cartId` de retorno (timeout ou resposta perdida) não tem recuperação documentada: até prova em contrário, é **NO-GO para retry**, e o resultado é tratado como RESULT_UNKNOWN.
- `updateCartItem` exige o estado completo do item (quantidade, opções e nota), não um delta.
- `createCart` aceita `deliveryMethod` e `paymentMethod` já na criação. A CART-01 nunca deve enviar `paymentMethod`.

## GO/NO-GO por operação (uso real)

| Operação | Status | Evidência real faltante |
| --- | --- | --- |
| `createCart` | **NO-GO** | Output/cartId, erros e recuperação sem ID após resposta perdida |
| `getCart` | **NO-GO** | Snapshot real, identidade, cartItemId, itens/opções/quantidades, unidade de cada preço/taxa, ausência/null e versão/ETag |
| `addItemToCart` | **NO-GO** | Confirmação real, identificação da linha e reconciliação de efeito tardio |
| `updateCartItem` | **NO-GO** | Substituição completa, estabilidade de cartItemId, confirmação e reconciliação |
| `removeItemFromCart` | **NO-GO** | Confirmação, semântica de linha ausente e reconciliação |
| `getCartDeliveryMethods` | **NO-GO** | Output, IDs/slots e validade das opções |
| `setCartDelivery` | **NO-GO** | Confirmação e efeito sobre custos/slots |
| `listVouchers` | **NO-GO** | Output e validade dos IDs/códigos |
| `setVoucher` | **NO-GO** | Confirmação, desconto e reconciliação |
| `removeVoucher` | **NO-GO** | Confirmação, totais e reconciliação |
| `listPaymentMethods` | **NO-GO — fora do ensaio** | Contrato/privacidade e divergência UUID versus enum; escopo futuro separado |
| `setCartPayment` | **NO-GO — proibida** | Seleção/tokenização, confirmação e tratamento de dados; escopo futuro separado |
| `submitOrder` | **NO-GO — proibida** | Autorização própria, output/orderId e recuperação sem resposta |
| `getOrder` | **NO-GO — fora do ensaio** | Output/status e correlação; input atual exige orderId conhecido |
| `trackOrder` | **NO-GO — fora do ensaio** | Status, paginação/polling e correlação; input atual exige orderId conhecido |

GO apenas para executar a suíte **offline**. Não há operação real com GO. Ausência de mecanismo confiável de reconciliação mantém NO-GO mesmo depois de capturar um caso feliz.

## Cobertura reutilizada e complementada

- `test/cart/int02-contracts.test.ts`: IDs obrigatórios/distintos, itens/opções/quantidades, ausência versus null/lista vazia, linhas duplicadas, centavos fracionários exatos, cada componente ausente/inválido, subcentavos/overflow e erros inline root/data apesar de success/IDs válidos.
- `test/cart/int01-audit.test.ts`: respostas desconhecidas e criação sem cartId; regressão após efeito ampliada para add/update/remove. Mesmo requestId ou outra chave não reenvia; getCart não limpa RESULT_UNKNOWN.
- `test/cart/int01-inventory.test.ts`: inventário real de inputs, inexistência de outputSchema/idempotência, outputs desconhecidos, totais ausentes e hipótese de acknowledgment.
- `test/cart/cart.test.ts` e `review-regressions.test.ts`: origem/contexto dos IDs, mutações, totais divergentes/ausentes e falha de releitura após confirmação (repetição só lê).
- `test/cart/transport.test.ts`: 401 não dispara refresh/replay de mutação. Sem garantia de execução única no provedor.

A regressão de remoção reproduziu um caso no qual, após efeito com resposta desconhecida, uma nova chave recebia `CART_ITEM_NOT_FOUND` em vez de `RESULT_UNKNOWN`. Não havia segundo envio, mas o erro ocultava a reconciliação pendente. `removeItemFromCart` agora verifica o bloqueio desconhecido antes de validar a presença da linha; ausência em getCart não comprova conclusão.

## Checklist para a etapa autenticada futura

Não executar este checklist nesta entrega. Uma nova etapa depende de ambiente autorizado e da integração da confirmação/intenção durável CART-01; ensaio manual não pode contorná-las.

- [ ] Registrar ambiente de teste autorizado, data UTC, operador, conta/vínculo pseudonimizados e origem de cada evidência; nunca publicar token, callback OAuth, endereço, documento ou dados de pagamento.
- [ ] Capturar schemas anunciados completos na sessão direta; comparar nomes exatos e hashes, sem remover prefixos do host automaticamente. Nunca enviar userId. Validar os argumentos efetivos contra o inputSchema anunciado antes de qualquer escrita.
- [ ] Registrar commit do consumidor e SHA-256 dos parsers/gateway; salvar manifesto por operação com `classification`, ambiente, horário, nome exato, caminho/hash do inputSchema, outputSchema (ou ausência explícita), argumentos e resposta sanitizados, hashes, versão do parser, teste associado, decisão GO/NO-GO e justificativa. Campos sem evidência ficam pendentes, sem inventar valores.
- [ ] Sanitizar antes de versionar: substituir IDs privados consistentemente preservando UUID, relações cartId/cartItemId/itemId/optionId, tipos, ausente/null/lista vazia, quantidades, erros e unidades. Manter mapa de substituições e bruto fora do Git; revisão humana de todo artefato. Hash sanitizado não é hash da resposta bruta; registrar algoritmo/encoding e transformação aplicada.
- [ ] Capturar create/get/add/update/remove somente com confirmação humana específica por escrita (organizador, conta, composição, versão/hash, prazo) e intenção durável registrada **antes** da rede. Sequência mínima: create → get → add → get → update completo → get → remove → get. Preservar identidade de cada linha e efeitos efetivamente observados.
- [ ] Incluir item com opções e quantidades verificáveis, preços unitários de itens/opções, subtotal, entrega, serviço, descontos e demais custos. Confirmar unidade por campo; BRL → centavos ocorre uma única vez na fronteira. Não interpretar componente ausente como zero nem dividir subtotal para inventar unitário.
- [ ] Obter erros inline e exemplos de campos ausentes/null com origem autorizada; não provocar falhas/reenvios reais para fabricar evidência. Registrar código, retryable e impacto; retryable não autoriza repetir escrita.
- [ ] Confirmar com fonte confiável idempotência (chave, escopo, retenção, mesmo conteúdo/conflito), consulta por intenção e recuperação de create sem cartId. Não há tais garantias nos schemas atuais. Sem fonte, RESULT_UNKNOWN bloqueia novas escritas; nunca repetir automaticamente.
- [ ] Confirmar versão/ETag/precondições remotas, rejeição de conflito, consistência e efeitos tardios. Ausência nos inputs não prova inexistência no serviço. Hash/revisão local e releitura não eliminam corrida com outro cliente nem resolvem sozinhos uma mutação desconhecida.
- [ ] Converter capturas sanitizadas em testes dos parsers existentes; ajustar apenas ao observado e reavaliar GO/NO-GO por operação/caso, incluindo reconciliação. Metadados e testes mockados não fecham #40 nem habilitam F7.

### Hashes de referência dos inputs (não de outputs)

SHA-256 de `JSON.stringify(tool.inputSchema)` em UTF-8, sem newline, mantendo ordem das propriedades da fixture. Não é canonicalização JSON; para comparar outra serialização, usar a mesma regra. Fixture inteira usa bytes UTF-8/LF.

| Tool | SHA-256 inputSchema |
| --- | --- |
| `createCart` | `bd9066d30fc8c15caf25fce2372f71078240a7b1ea003eb06ab1e34035bb5895` |
| `getCart` | `c8719b5729b877df3841080263ffe27b0cb6eb272de6a0ce54087c7ea6ce9834` |
| `addItemToCart` | `0e0cf52c734bcc00a2aa3bc876b444b1ef05daaca81809ee93044327c7b210d4` |
| `updateCartItem` | `fdfac5860f7f6e38a9659b379b84af1693a6ed5aaad8d8dfeccfe3edac710af9` |
| `removeItemFromCart` | `de57048d51cb28ccd0ab817b7f400b53473ccf0a2bfeeb7855d10efff2198132` |

## Lacunas separadas: envio e pagamento (BUY-01/BUY-02)

- **Envio:** sem output/status real de submitOrder/getOrder/trackOrder, autorização SUBMIT_ORDER própria, correlação por intenção, idempotência ou recuperação de submissão sem orderId. getOrder/trackOrder exigem ID já conhecido; criação de pedido não comprova pagamento. PREPARE_CART/login não aprovam envio.
- **Pagamento:** formato de métodos/IDs e tokenização não validados; descrições com enums conflitam com UUID do input. Faltam confirmação, estados de pagamento, erros, conciliação e política de dados sensíveis. Não enviar paymentMethod em createCart nem chamar ferramentas de pagamento neste ensaio.
- Nenhuma operação BUY-01/BUY-02 foi implementada ou executada. Estas lacunas exigem escopo/autorização próprios e não serão resolvidas ativando flags de carrinho.

## Validação offline desta entrega

Em 18/10/2026, nesta cópia Linux:

| Comando | Resultado |
| --- | --- |
| `npm test -- test/cart/int02-contracts.test.ts test/cart/int01-audit.test.ts test/cart/int01-inventory.test.ts test/cart/cart.test.ts test/cart/review-regressions.test.ts test/cart/transport.test.ts` | **95/95 passaram**, 6 arquivos |
| `npm run typecheck` | Passou |
| `npm run lint` | Passou |
| `npm test` | **970/970 passaram**, 57 arquivos |
| `git diff --check` | Passou |

A primeira tentativa não iniciou os testes por dependência `ai` ausente; `npm ci --ignore-scripts --no-audit --no-fund` restaurou as dependências do lockfile sem alterá-lo. A regressão de remoção falhou antes do guard e passou após a correção. Todos os testes acima usam fixtures/fakes, sem validar o contrato remoto.

## Capturas autenticadas — 18/10/2026 (atualiza o GO/NO-GO acima)

Sessão OAuth isolada com o client da produção e conta de teste. Tokens ficaram fora do Git e a sessão do bot não foi tocada. Cada escrita teve confirmação humana específica e intenção registrada antes da rede; não houve envio de pedido nem pagamento. Amostras em `fixtures/int02/`; manifesto v1 em `fixtures/int02/cart-evidence.json` (fixa o hash de `contracts.ts`: regenerar após qualquer edição). Flags continuam OFF.

| Operação | Status | Observado |
| --- | --- | --- |
| `getCart` | **GO** | Carrinho completo em `content[].text` (sem `structuredContent`/`success`). `merchant.merchantId`; **sem addressId**, só `deliveryAddress` textual; item sem opções omite `options`; totais em `summary.*Amount` (BRL) + `fees[]` |
| `createCart` | **GO** | Devolve o carrinho completo com `cartId`. Responde **antes** de aplicar promoções; o getCart seguinte pode ter outro total |
| `addItemToCart` | **GO** | Devolve o carrinho completo. Mesmo item vira **nova linha**. `options` omitido ⇒ `isError:true` ("non-null is null") apesar do schema opcional: enviar sempre `options: []` |
| `updateCartItem` | **GO** | Devolve o carrinho completo; `cartItemId` preservado |
| `removeItemFromCart` | **GO** | Devolve o carrinho completo, idêntico ao getCart seguinte |
| Itens com opções/customizações | **NO-GO** | Formato não observado; chave desconhecida é rejeitada |
| Idempotência / recuperação sem cartId | **NO-GO** | Sem chave, ETag ou consulta por intenção. RESULT_UNKNOWN continua bloqueando, sem retry |
| Entrega, cupom, pagamento, pedido | **NO-GO / proibido** | Não executados |

Adaptações na CART-01:
- O parser normaliza o formato observado e rejeita taxas divergentes, pagamento ou cupom presentes e chaves desconhecidas em itens.
- A identidade do endereço é conferida comparando rua, número e bairro com o `listAddresses` relido.
- Com benefícios que não se decompõem (promoção misturada com entrega grátis), o total fica `PROVIDER_REPORTED`, informado pelo iFood e nunca confirmado; orçamento e rateio continuam `UNVERIFIED`.

Outros achados:
- `createAddress` retornou `ADR-2001` em um endereço; erro de negócio vem com `isError:false` e `errors` como objeto.
- O CEP muda de formato entre `createAddress` e `listAddresses`.
- O carrinho de teste `b82b35b3-…` ficou com 1 item na conta de teste.
