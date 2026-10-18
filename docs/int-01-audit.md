# INT-01 — Auditoria F7 e contrato externo

Conferência em **18/10/2026**. Base original auditada: `feat/f7-cart-checkout@b08957d`, PR [#4](https://github.com/Modo-Escuro/api-backend/pull/4). O PR [#24](https://github.com/Modo-Escuro/api-backend/pull/24) incorpora `main@30a650d`, incluindo F7, API-01, DEC-01, OPS-01 e a infraestrutura RUN-01, preservando os commits da auditoria e a atualização concorrente de metadados `484b428`. O PR de auditoria foi integrado à main; esse fato não comprova implantação nem validação de negócio. A correção preserva o bloqueio de respostas desconhecidas e não habilita carrinho, aprovação ou envio reais.

**Estado: auditoria offline e metadados autenticados entregues; contrato de saídas de carrinho/pedido e reconciliação externa continuam sem validação.** A consulta `tools/list` compartilhada pelo usuário foi bem-sucedida em `2026-10-18T05:41:22.487Z`. Isso não valida `tools/call`, escopos de negócio ou respostas dos parsers.

A [DEC-01 vigente](decisoes-conversacionais.md) permite carrinho real com confirmação humana específica; envio/pagamento continuam proibidos. A issue INT-01 #7 está fechada pela auditoria/metadados entregues. Outputs e reconciliação continuam pendentes na [INT-02 #40](https://github.com/Modo-Escuro/api-backend/issues/40), gate de ativação da CART-01. O relato de captura abaixo preserva sua origem histórica; não autoriza nova mutação.

Manter `IFOOD_CART_ENABLED=false`: validar outputs isoladamente não autoriza alterar o escopo. O campo `f7GatewayAllowed` do inventário descreve a capacidade do adaptador legado, não autorização de uso na demo. O probe só inicializa o protocolo e consulta `tools/list`; não chama ferramentas de negócio, mesmo quando lista nomes de escrita.

## Fontes e níveis de evidência

| Fonte | O que sustenta | Limite |
| --- | --- | --- |
| `fixtures/tools-list.json` | Captura preexistente de 23 ferramentas, incluindo schemas de entrada e descrições; 15 relevantes à F7/pedido | Não é nova execução desta auditoria; não tem outputSchema |
| [metadata-20261018.json](../fixtures/int01/metadata-20261018.json) | Projeção sanitizada da nova consulta autenticada, executada pelo usuário no Console Railway; 15 ferramentas selecionadas, uma página | Saída fornecida pelo usuário, sem verificação independente no servidor pelo agente. Não contém schemas completos, respostas de negócio ou prova de escopo |
| `documenta_o_oficial_ifood_mcp.md` | Documento local: BRL decimal, jornada e erros inline | Não é resposta capturada; autoridade/versão externa não foi revalidada |
| `src/server/cart/*`, `src/server/mcp/cart.ts` e testes | Garantias e regressões offline da F7 | Estado de carrinho em memória; testes sintéticos não comprovam o provedor |
| Healthcheck público da API Railway | HTTP 200, `ok:true`, armazenamento `OK/VOLUME`, `acceptingNewLinks:true` | Disponibilidade/persistência não comprovam contrato de negócio |

Inventário offline: [int-01-tools-audit.json](int-01-tools-audit.json), reproduzível com `node --import tsx scripts/audit-f7-contract.ts`. O SHA-256 identifica a captura preexistente normalizada para LF, não respostas privadas.

## Resultado da consulta autenticada

O usuário concluiu o vínculo pelo bot e executou o [comando do Console](int-01-console-command.sh) de `c817be8031b7ae5673a6c97d95015633faf2dfbe`. A fixture preserva o JSON final e registra sua proveniência; o prefixo de terminal `NODE` não faz parte da resposta.

A comparação offline normalizou a ordem das ferramentas e dos conjuntos de campos. **15/15 coincidem, zero diferenças na projeção comparada**: nomes, propriedades, campos obrigatórios, presença de outputSchema e `readOnlyHint/destructiveHint/idempotentHint`. As annotations adicionais da captura antiga e os tipos/formatos/descrições dos schemas não foram comparados.

- As 15 ferramentas seguem sem `outputSchema` e com hints `false/true/false`; esses hints não definem uma política de execução.
- `createCart.required=[]`; `options` permanece fora do required de add/update; `submitOrder` só requer cartId formalmente. Isso não autoriza compra nem dispensa validação humana.
- Nenhum nome de campo de idempotência aparece nessa projeção. `getCart` requer cartId; `getOrder` e `trackOrder` requerem orderId. Não foi estabelecida recuperação por intenção sem ID.
- `businessToolsCalled:false` e `outputResponsesCaptured:false`: nenhuma operação de carrinho, pedido ou pagamento foi executada pelo probe. Preços, unidades de saída, erros inline e confirmações de mutação continuam sem nova evidência de execução.

## Matriz por operação

Legenda: **D** = descrição/documento local; **C** = input capturado em `tools/list`; **S** = comportamento/parser simulado em testes; **O** = saída real observada nesta auditoria. **O é pendente em todas as linhas**. A nova consulta autenticada confirma somente a projeção de metadados de C: nomes, nomes de campos, obrigatoriedade, presença de outputSchema e três hints. Não recaptura tipos, formatos, descrições ou schemas completos. Nomes abaixo não autorizam sua chamada. Nenhum output de carrinho foi inventado como captura real.

| Operação | Input C e origem dos IDs | Output D / hipótese S da F7 | Evidência e bloqueio |
| --- | --- | --- | --- |
| `createCart` | `orderId` OU loja/endereço/itens nas descrições; F7 usa `merchantId` de Discovery/getItem, `addressId` de listAddresses e itens detalhados | D: cartId; S: `{cartId}` direto/em `data` | C/D/S; sem cartId reconhecido fica desconhecido e bloqueia outra criação no mesmo organizador/vínculo |
| `getCart` | `cartId` da criação/consulta | D: estado/totais/IDs; S: snapshot projetado com itens, opções, componentes BRL, entrega/pagamento/cupons | C/D/S; formato desconhecido, identidade divergente e totais inválidos bloqueiam revisão; falta de componentes não vira zero |
| `addItemToCart` | cartId + itemId de getItem + quantidade; opções completas provadas pelo catálogo | D: mutação; S: confirmação mínima `{success:true}` | C/D/S; sem confirmação reconhecida não marca DONE; resultado permanece desconhecido |
| `updateCartItem` | anteriores + `cartItemId` de getCart; itemId precisa corresponder à linha | D: substituição da configuração; S: mesma confirmação mínima | C/D/S; não usa itemId como cartItemId; resposta não reconhecida mantém bloqueio |
| `removeItemFromCart` | cartId + cartItemId de getCart | D: remoção; S: mesma confirmação mínima | C/D/S; replay de remoção confirmada só relê, não exige linha ainda presente |
| `getCartDeliveryMethods` | cartId existente | D: opções; S: `deliveryMethods[{deliveryMethodId,timeSlots?}]` | C/D/S; não inferir formato ou IDs; parser desconhecido não emite escolha |
| `setCartDelivery` | cartId + deliveryMethodId e slot opcional vindos da listagem/relistagem | D: seleção; S: confirmação mínima | C/D/S; escolha expirada/alterada bloqueia; não inventar enum/prefixo de entrega |
| `listPaymentMethods` | merchantId da loja atual | D: métodos/cartões; S: paymentMethods com IDs UUID, tipo e token somente transitório | C/D/S; contradição texto PIX versus formato UUID permanece bloqueada, não ampliar por adivinhação |
| `setCartPayment` | cartId + paymentMethodId listado; cardTokenId só quando necessário e retornado | D: seleção; S: confirmação mínima | C/D/S; nunca copiar token para UI, estado persistido ou contexto do modelo |
| `listVouchers` | cartId existente | D: cupons; S: vouchers com code/campaignId | C/D/S; lista não reconhecida não gera escolha; cupom é opcional |
| `setVoucher` | cartId + code/campaignId da lista/relistagem | D: aplicação; S: confirmação mínima | C/D/S; tratar como mutação com total/revisão invalidados |
| `removeVoucher` | cartId existente | D: remoção; S: confirmação mínima | C/D/S; falha/saída desconhecida impede nova escrita; não repetir automaticamente |
| `submitOrder` | cartId; userConsent/document aparecem no input; aprovação vem do canal humano, não do schema | D: orderId; S: somente função falsa em testes de política, sem parser real | C/D/S; bloqueado no gateway, nas rotas e no lint; nenhuma chamada nesta task |
| `getOrder` | **orderId obrigatório**; captura usa string, descrição menciona UUID | D: detalhes privados de pedido; S: sem adaptador operacional | C/D; não resolve pedido sem ID conhecido; não chamar para descobrir IDs ou coletar documento/código privado |
| `trackOrder` | **orderId obrigatório**, nextPageToken opcional vindo de agentHints | D: status/histórico/polling; S: sem adaptador operacional | C/D; sem parser/status observado e sem reconciliação por intenção; não inferir pedido/pagamento de descrição livre |

`{success:true}` e o snapshot de F7 são **hipóteses de saída sintética**. Reconhecê-los nos testes não valida que sejam retornados pelo serviço real, nem basta para habilitar a flag. O novo guard bloqueia os formatos desconhecidos, mas não transforma uma hipótese de contrato em evidência externa.

## Divergências e limites encontrados

1. **Required formal não cobre tudo descrito.** `createCart.required=[]`, embora as descrições exijam contexto para criação nova/reordenação. `options` aparece nas propriedades de add/update, mas não no `required` capturado, apesar do documento local chamá-lo obrigatório. `userConsent` não é required formal em submit; isso nunca significa autorização implícita. Manter as exigências conservadoras da aplicação e registrar a divergência para o provedor.
2. **Pagamento tem contradição no próprio input.** Descrições exemplificam `PIX`/`CREDIT_CARD`, enquanto `paymentMethodId` exige UUID. Preservar o ID retornado e o bloqueio do parser até captura esclarecedora; não trocar UUID por enum ou construir prefixo.
3. **Annotations não são uma política de segurança.** As 15 ferramentas selecionadas têm `idempotentHint:false`, `destructiveHint:true` e `readOnlyHint:false`, inclusive getCart/getOrder/trackOrder. Isso não comprova que uma consulta mutate estado, nem permite declarar uma escrita idempotente. Selecionar operações pelo contrato verificado e pelo ambiente autorizado, não só por hints.
4. **Unidade e erro de saída não foram observados em cart.** BRL decimal e `error.impact.canProceedToCheckout` são documentados localmente; os parsers atuais só foram testados com valores sintéticos. Flags de impacto/retry nunca substituem aprovação, elegibilidade ou reconciliação. Erros root, aninhados e payload não confirmado bloqueiam as projeções/escritas nesta correção.
5. **Persistência e concorrência externa continuam ausentes.** Maps e locks da F7 só protegem um processo. Reinício perde intents/unknownCreates e pode deixar efeito remoto. A flag deve continuar falsa até CART-01/DATA-01/RUN-01; não contornar 404 criando outra intenção após restart.
6. **Transporte sem replay de aplicação não garante execução única.** Sessão de carrinho usa `retryUnauthorized=false`; o teste 401 confirma uma requisição sem refresh/replay. Nenhuma chave de idempotência externa foi encontrada nos inputs capturados. Não prometer exatamente uma execução no provedor por isso.
7. **Elegibilidade e revisão ainda são informativas.** `ELIGIBILITY_UNVERIFIED`, `approvalEnabled:false`, `purchaseAuthorized:false` e `CHECKOUT_DISABLED` continuam. ItemRef prova origem, não segurança alimentar. Guards de aprovação de F7 são só política simulada; BUY-01 precisa adotar contrato humano versionado e consumo atômico.

## Correção reproduzida nesta auditoria

Em `b08957d`, o gateway aceitava payload ausente, texto, objeto vazio, `queued:true`, `success` de tipo incorreto e erro dentro de `data` como resultado de uma chamada. `CartService.mutate` marcava DONE sem conferir a confirmação de escrita. Isso podia liberar outra mutação mesmo sem evidência de conclusão da anterior. `payload()` também removia envelope e permitia projetar um snapshot apesar de `success:false` ou erro aninhado.

Os 11 testes iniciais de `int01-audit.test.ts` tiveram **9 falhas e 2 sucessos antes da correção**, em execução com temporários liberados. As falhas incluíram a mutação que já produziu efeito no fake e depois responde com formato desconhecido. Após a correção, **11/11 passaram**.

A correção valida a confirmação antes de DONE no serviço e no gateway, exige cartId reconhecido na criação e rejeita erro no envelope ou em `data` antes de projetar. Campo `success` presente precisa ser o booleano `true`; string, `null` e `false` não confirmam sucesso. Ausência de confirmação após envio preserva `RESULT_UNKNOWN`; leitura posterior não limpa o bloqueio nem permite outra chave. Reaproveita a arquitetura e os parsers da F7; não amplia o conjunto de ferramentas ou inventa formato real. `IFOOD_CART_ENABLED` não foi ativada.

## Reconciliação e gatilho de fechamento

| Situação | O que pode ser afirmado com esta evidência | Conduta |
| --- | --- | --- |
| Criação sem cartId, timeout ou resposta inválida | Pode existir carrinho remoto; a captura não mostra listagem/busca de carrinho por intenção | Bloquear nova criação no escopo, preservar intenção e solicitar mecanismo de consulta/correlação ao provedor; não adivinhar cartId |
| Mutação com confirmação reconhecida, getCart seguinte falha | F7 guarda DONE antes da leitura e replay só consulta | Preservar a intenção e recuperar leitura; não repetir escrita; aceitação do formato depende de validação real |
| Mutação sem confirmação | Nem snapshot posterior nem retryable provam que não haverá efeito tardio | Manter RESULT_UNKNOWN, bloquear novas escritas e reconciliar por mecanismo verificado |
| Submissão sem orderId/resposta | getOrder/trackOrder precisam de ID já conhecido; captura não expõe busca por requestId/intenção | BUY-02 permanece bloqueada sem correlação/idempotência/consulta confiáveis ou procedimento humano rastreável definido com provedor |
| Submissão com orderId e status verificáveis | Ainda faltam output/status reais; pedido real está fora da demo adotada | Só afirmar estágio comprovado por fonte confiável; não tratar pedido criado como pagamento |

O universo investigado foi a captura preexistente de 23 tools, a nova projeção autenticada de 15 ferramentas, o documento local e o código/testes F7. **Não encontrar mecanismo nesse universo não prova ausência na plataforma.** Perguntar ao provedor sobre chave de idempotência, retenção, conteúdo conflitante, status por chave de requisição, consulta de criação/submissão sem ID, garantias de consistência/efeito tardio e procedimento de reconciliação.

A busca pública complementar em 18/10/2026 por createCart/idempotência no domínio MCP e por MCP marketplace/reconciliação no domínio developer não encontrou documentação pública específica que resolvesse essas lacunas. O portal MCP não pôde ser aberto pela ferramenta web. Os resultados da [documentação para restaurantes](https://developer.ifood.com.br/pt-BR/docs/categories) referem-se à Merchant API e foram excluídos como evidência do contrato consumer MCP. Essa busca limitada não demonstra inexistência do recurso no provedor.

## Histórico — fechamento simulado anterior (substituído)

Este trecho preserva a decisão anterior, substituída pela [DEC-01 vigente](decisoes-conversacionais.md): carrinho real confirmado está autorizado no escopo, mas ainda não integrado/validado. Não usar os critérios históricos abaixo como aceite atual da CART-01 ou do briefing.

Na decisão anterior, a DEC-01 D8/DA10 escolheu sacola **100% simulada**. O gatilho a implementar e verificar em BUY-01/RUN-01/QA-01 é o clique humano do organizador autenticado, preso ao `purchaseId`, versão e `contentHash` atuais, com restrições e limites verificados. Alteração invalida a aprovação; replay do mesmo clique devolve a mesma aprovação; custos ou restrições obrigatórias desconhecidos bloqueiam.

A evidência de fechamento é o registro único da aprovação fictícia e a apresentação **“SACOLA SIMULADA APROVADA — PEDIDO NÃO ENVIADO”**. Nenhum cartId/orderId remoto é exigido para essa sacola. Isso é requisito adotado, não funcionalidade implementada por esta auditoria.

A aprovação fictícia não pode usar `/purchase-approvals`, cujo contrato exige total remoto confirmado; a simulação exige contrato explícito próprio conforme D8.

CART-01 e BUY-02 reais ficam fora dessa demo. Se retomados, exigem validação de saídas, persistência de intenções e estados desconhecidos, elegibilidade por pessoa, aprovação humana válida e mecanismo confiável de reconciliação. `submitOrder` permanece inacessível.

## Acesso e reprodução

O usuário opera o navegador. O login Railway e a consulta de metadados do deploy foram concluídos. A tentativa SSH foi cancelada antes de confiar na chave de host: a revisão automática bloqueou a aceitação sem referência confiável; a chave temporária autorizada foi revogada e seus arquivos locais removidos. Nenhum comando executou no contêiner via SSH.

O [Console autenticado](int-01-console-command.sh) usa o SDK instalado, lê apenas a credencial do vínculo confirmado permitido e não usa a sessão global. Não faz refresh, não grava storage nem chama ferramentas de negócio; remove dados privados da projeção. A configuração é lida do código instalado (`config.linksDir`), acompanhando o padrão do volume da OPS-01.

O primeiro erro genérico foi corrigido para distinguir etapas e falhas de arquivos sem expor mensagens privadas. Depois de `LINKS_FILE_MISSING` no caminho efetivo, o healthcheck confirmou o volume disponível; o usuário concluiu Conectar → autorização no navegador → Confirmar e forneceu a consulta autenticada bem-sucedida. Não foi criado links.json manualmente nem importada sessão global.

Fonte do probe: `scripts/int01-console-probe.ts`. Regenerar o comando com `node --import tsx scripts/generate-int01-console.ts`. Os testes injetam cliente/filesystem falsos e verificam paginação, expiração, ausência de fallback, etapas e sanitização. Uma nova execução exige token ainda válido; se expirado, verificar pelo fluxo existente da API, sem refresh concorrente do probe.

## Reuso e dependências atuais

- Na base remota `e8d6b6f`, API-01, OPS-01, RUN-01, DATA-01, GRP-01 e AI-01/AI-02 estão integradas ao código. Montagem em produção, volume e ensaio Telegram não se deduzem de merge ou teste offline.
- Reutilizar domínio e retenção DATA-01, elegibilidade por pessoa GRP-01, rateio DOM-01 e processador AI-02; CART-01 não depende da conclusão de trabalho novo na AI-01. A implementação CART-01 auditada permanece local, fora da main e desta revisão documental.
- BUY-01 deve distinguir confirmação PREPARE_CART de futura aprovação SUBMIT_ORDER. O modelo nunca recebe credencial de confirmação. Envio e pagamento estão proibidos neste incremento.
- Reutilizar catálogo/getItem, validação de configuração, referências opacas e regras de custo. ItemRef comprova origem, não segurança alimentar. O servidor MCP fictício do projeto Python não substitui o cliente externo.
- INT-01 #7 foi encerrada pelo recorte de auditoria/metadados. Saídas autenticadas sanitizadas, semântica por operação e mecanismo confiável de reconciliação estão pendentes na [INT-02 #40](https://github.com/Modo-Escuro/api-backend/issues/40). Nenhuma flag deve contornar essas lacunas.

## Histórico de validação INT-01 — 18/10/2026

Windows, Node **24.13.0**, dependências instaladas com `npm ci --ignore-scripts`, lockfile da main preservado.

| Verificação executada | Resultado |
| --- | --- |
| `npm test -- --reporter=json --outputFile=.int01-test-results.json` | **474 passaram, 2 ignorados** (testes POSIX), 476 no total; zero falhas |
| `npm run typecheck` | passou |
| `npm run lint` | passou |
| `npm run build` | passou |
| `git diff --check` | passou |

A primeira execução no sandbox teve erros `EPERM` nos temporários de persistência; a execução completa acima passou com acesso adequado aos temporários. A comparação do comando gerado foi corrigida para normalizar LF/CRLF, mantendo a verificação do código. Três novas regressões confirmam: F7 padrão/desligada não cria carrinho na rota; o pipeline somente leitura recusa todas as mutações F7 e envio antes de chamar o MCP; listar metadados de escrita não executa `tools/call` no probe. Erros desconhecidos, isolamento, API-01 e RUN-01 são exercitados na mesma suíte.

O resultado local não comprova CI ou integração real. Nenhuma leitura de credenciais pessoais, alteração de variável Railway, ensaio autenticado MCP ou operação de negócio externa foi executada nesta preparação. A evidência autenticada preservada é a fornecida na atualização concorrente acima.

## Verificações anteriores e pendências

Histórico offline: 9/11 regressões falharam antes da correção e 11/11 passaram depois; mais 12 testes de inventário/parsers. A suíte F7 anterior à atualização com main teve 296/296; após os ajustes de diagnóstico, os 8 testes do probe passaram com TypeScript/ESLint. Esses resultados eram sintéticos.

Verificação integrada após incorporar `main@9aa02f2`, Windows / Node 24.19.0:

| Verificação executada | Resultado |
| --- | --- |
| Comparação offline da projeção autenticada com o inventário | 15/15 iguais; zero diferenças; sem comparar schemas completos ou outputs de negócio |
| `vitest run` completo | 436 aprovados, 2 pulados, 24 arquivos; os dois casos de recusa por chmod exigem POSIX sem root e são pulados no Windows |
| `unittest discover -s test/contracts -p "test_*.py" -v`, venv Python | 6/6 aprovados |
| `tsc --noEmit -p tsconfig.json` | passou |
| `eslint .` | passou |
| `vite build` | passou |
| `git diff --check` | passou |

Esses checks executaram somente fakes/fixtures. O único ensaio MCP novo foi `tools/list`, pelo usuário no Console, conforme a proveniência da fixture. Não houve `tools/call`, mutação externa, alteração de ambiente ou deploy por esta atualização.

- [x] Matriz distingue documento, input capturado, simulação, metadado autenticado e saída não observada.
- [x] Saídas desconhecidas mantêm bloqueio; flags e checkout não são habilitados.
- [x] Falta de recuperação sem IDs e de garantia externa de idempotência está registrada.
- [x] Gatilho de fechamento e dependências foram alinhados à DEC-01 anterior na ocasião; o escopo vigente está nas seções atuais acima.
- [x] Nova consulta autenticada sanitizada e comparação de metadados registradas.
- [ ] Saídas de negócio reais, unidades e erros por operação capturados e parsers validados com elas.
- [ ] Mecanismo externo confiável de reconciliação sem cartId/orderId estabelecido.

As duas pendências finais impedem declarar integração real de carrinho/pedido validada e seguem na INT-02 #40. O fechamento de #7 cobre auditoria/metadados, não validação integral do contrato externo. A antiga demo somente leitura não é o escopo vigente; carrinho real depende dos gates atuais e envio/pagamento continuam proibidos. CI/Linux e avaliação de LLM não foram executadas nesta auditoria histórica; esta revisão documental não repetiu a suíte.
