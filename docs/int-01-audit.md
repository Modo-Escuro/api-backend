# INT-01 — Auditoria F7 e contrato externo

Conferência em **18/10/2026**. Base original auditada: `feat/f7-cart-checkout@b08957d`, PR [#4](https://github.com/Modo-Escuro/api-backend/pull/4), incluindo `33f591e`/`main@686300d`. A F7 já foi incorporada à main. O PR [#24](https://github.com/Modo-Escuro/api-backend/pull/24) incorpora agora `main@30a650d` (incluindo API-01, OPS-01, DEC-01 e a infraestrutura RUN-01), preservando os commits da auditoria. Corrige a confirmação de respostas desconhecidas sem habilitar carrinho, aprovação ou envio reais.

**Estado da tarefa: auditoria offline entregue; integração externa não validada. Não encerrar INT-01 por este merge.** A [DEC-01](decisoes-conversacionais.md), adotada em 18/10/2026, define sacola simulada, aprovação fictícia e MCP somente leitura. `IFOOD_CART_ENABLED=false` deve ser preservado: não executar `createCart`, mutações de carrinho, pagamento ou envio para obter evidência. A demo termina em **SACOLA SIMULADA APROVADA — PEDIDO NÃO ENVIADO**, com aprovação presa à versão e ao hash; esse fluxo ainda depende da implementação de domínio e aprovação simulada.

As saídas reais de F7 e sua reconciliação continuam lacunas registradas para uma evolução futura. Não são uma exigência de executar escritas na demo. O campo `f7GatewayAllowed` do inventário descreve a capacidade do adaptador legado, **não autorização de uso na demo**. O probe manual só inicializa o protocolo e consulta `tools/list`; não chama ferramentas de negócio, mesmo quando lista nomes de escrita.

## Fontes e níveis de evidência

| Fonte | O que sustenta | Limite |
| --- | --- | --- |
| `fixtures/tools-list.json` | 23 ferramentas capturadas; nomes, descrições, inputs e annotations; 15 relevantes para carrinho/pedido | Captura preexistente declarada real no projeto; não é nova execução desta auditoria. Não contém `outputSchema` |
| `documenta_o_oficial_ifood_mcp.md` | Documento local fornecido: BRL decimal, jornada, `error` singular em cart e raiz em tracking | Não é captura de resposta; autoridade/versão externa não foram revalidadas nesta sessão |
| `src/server/cart/*`, `src/server/mcp/cart.ts`, sessão por vínculo e rotas F7 | Garantias e lacunas verificadas no código | Estado atual em memória; código não comprova comportamento do provedor |
| `test/cart/*`, incluindo os 23 testes INT-01 | Casos sintéticos, regressões, parser, transporte sem replay 401 e bloqueios de escrita | Não são fixtures de saída real; nenhum teste compra no iFood |
| `GET https://api-backend-production-9c4c.up.railway.app/api/health` | HTTP 200, `{ok:true}` observado nesta sessão | Só disponibilidade HTTP; não comprova commit implantado, autenticação, escopos, ferramentas ou carrinho |

Inventário reproduzível: [int-01-tools-audit.json](int-01-tools-audit.json), gerado por `node --import tsx scripts/audit-f7-contract.ts`. O SHA-256 identifica a captura de entrada com quebras normalizadas para LF (portável entre Windows/Linux), não respostas privadas. Esse comando não lê ambiente/credenciais nem faz rede. O teste detecta drift entre captura e relatório.

## Matriz por operação

Legenda: **D** = descrição/documento local; **C** = input capturado em `tools/list`; **S** = comportamento/parser simulado em testes; **O** = saída real observada nesta auditoria. **O é pendente em todas as linhas**. Nomes abaixo não autorizam sua chamada. Nenhum output de carrinho foi inventado como captura real.

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
| Submissão com orderId e status verificáveis | Faltam output/status reais; envio está fora da DEC-01 vigente | Só afirmar estágio comprovado por fonte confiável numa evolução autorizada; não tratar pedido criado como pagamento |

O universo investigado foi a captura de 23 tools, o documento local e o código/testes F7. **Não encontrar mecanismo nesse universo não prova ausência na plataforma.** Perguntar ao provedor sobre chave de idempotência, retenção, conteúdo conflitante, status por chave de requisição, consulta de criação/submissão sem ID, garantias de consistência/efeito tardio e procedimento de reconciliação.

A DEC-01 D8 resolve DA10 para o evento: o fechamento é uma sacola **simulada**, aprovada pelo organizador na versão e no hash atuais, sem `cartId` remoto ou pagamento real. Mudança invalida a aprovação. QA-01 deve comprovar esse resultado e zero chamadas MCP de escrita (D10). A aprovação fictícia não pode usar `/purchase-approvals`, cujo contrato exige total remoto confirmado. Cartão, carrinho e envio reais exigiriam nova decisão de escopo, contratos observados, persistência de intenções, aprovação humana específica e reconciliação; não estão autorizados por este relatório.

## Próximo ensaio autenticado de metadados/leitura (pendente)

1. Aplicar os limites já adotados na DEC-01 e preservar vínculo antes de qualquer redeploy (OPS-01). Este checkout de auditoria não possui sessão iFood/BOT_API_TOKEN; não copiar segredos para o chat/Git. Não habilitar F7.
2. Usar a sessão do vínculo correto, sem fallback OAuth global. Revalidar tools/list com paginação e comparar nomes/inputs/outputs com o inventário. Metadados não são execução.
3. Numa validação separada do probe, limitar chamadas de negócio às leituras do catálogo necessárias à demo e permitidas pelo pipeline existente. Preservar `listAddresses` antes da entrega e `getItem` antes de recomendar; o probe não faz essas chamadas. Não consultar carrinho/pagamento/pedido como forma de descobrir IDs.
4. Não criar nem alterar carrinho para gerar amostras. As saídas F7 da matriz continuam `NOT_CAPTURED`, e as lacunas de reconciliação continuam abertas. Uma futura integração real requer nova decisão e ensaio próprio; não ampliar este ensaio por causa de metadados ou escopos disponíveis.
5. Inspecionar outputs no canal privado e produzir fixture sanitizada com transformação registrada: remover credenciais/PAN/CVV/documentos, endereço, conta, notas e dados pessoais; substituir IDs por UUIDs sintéticos consistentes quando necessário. Registrar tipos, unidades, enums não privados, sucesso/erro e origem da transformação, preservando distinção entre captura sanitizada e fixture inventada. Não publicar saída privada bruta.
6. Ajustar parsers somente com evidência correspondente à operação observada e rodar fixtures sanitizadas e regressões. Não promover saída sintética nem metadados a resposta de negócio. Registrar o mecanismo de reconciliação quando houver resposta verificável do provedor; até lá, manter o bloqueio e a lacuna explícita.

O usuário prefere operar o navegador: login e inspeção do painel ficam com ele. O healthcheck público foi a única chamada à API de aplicação nesta auditoria; não houve leitura de endereço, pagamento, pedido ou token iFood, nem chamada real de carrinho/MCP. A atualização de acesso Railway está registrada abaixo.

### Acesso Railway e alternativa pelo Console — 18/10/2026

O login humano no Railway CLI foi concluído e o acesso ao projeto/serviço `api-backend` confirmado. Uma consulta autenticada de metadados encontrou deploy `SUCCESS` e instância `RUNNING`; isso não identifica ou valida uma sessão iFood. Não foram lidas variáveis secretas nem reiniciado o serviço.

O usuário autorizou criar/registrar uma chave SSH temporária e removê-la após o ensaio. A chave foi criada com ACL restrita ao usuário e registrada; a primeira conexão apresentou uma chave de host ainda não conhecida. A revisão automática bloqueou aceitá-la sem uma referência confiável de autenticidade. O [suporte Railway](https://station.railway.com/questions/confirm-ssh-host-fingerprint-for-ssh-rai-8cd06fc6), incluindo resposta de funcionário, informa que não publica fingerprints/CA de host para esse endpoint e indica o Console do painel como alternativa autenticada. A consulta SSH foi cancelada antes da aceitação. A chave temporária foi **revogada na Railway e os dois arquivos locais removidos**, conferindo o fingerprint da chave criada antes da exclusão. Nenhum comando executou no contêiner via SSH.

Para avançar sem confiar nessa chave de host, o usuário pode executar o [comando autocontido do Console](int-01-console-command.sh) pela sessão autenticada do painel:

1. Abrir o projeto Railway, serviço `api-backend`, ambiente `production`, aba **Console**. Estar na pasta da API (onde estão `package.json` e `node_modules`). Não precisa publicar este script no serviço.
2. Colar o conteúdo completo de `int-01-console-command.sh`. O comando usa o SDK já instalado e lê somente o arquivo do vínculo confirmado correspondente à allowlist. Não usa `.tokens.json` global, não faz login/refresh, não modifica storage e não chama ferramentas de negócio.
3. Compartilhar apenas o JSON final: ele contém nomes, propriedades/requeridos, presença de outputSchema e hints booleanos. Não inclui valores de schema, nomes da conta, IDs de conta/carrinho, tokens, erros privados ou cursores. `OBSERVED_METADATA` comprova apenas a nova leitura de tools/list, **não saídas reais de carrinho**.
4. Se retornar `BLOCKED`, conservar a razão sanitizada. `VERIFY_LINK_THROUGH_EXISTING_API` exige verificar o vínculo pelo fluxo existente; o comando não rotaciona refresh tokens concorrendo com a API. Vínculo ausente/ambíguo, cliente/endereço MCP divergente ou formato desconhecido também bloqueiam.

Fonte: `scripts/int01-console-probe.ts`; gerar o comando com `node --import tsx scripts/generate-int01-console.ts`. Os testes usam filesystem/cliente falsos e conferem paginação, ausência de fallback global, bloqueios e sanitização. O comando não foi executado no contêiner nesta sessão; aguarda ação do usuário no navegador. As saídas reais de cart e o mecanismo de recuperação sem IDs continuam pendentes.

O usuário executou posteriormente o comando no Console e compartilhou `BLOCKED / PROBE_FAILED_NO_PRIVATE_DETAILS`, com `businessToolsCalled:false`. Esse resultado não distingue falha de leitura local, conexão ou tools/list; não comprova ausência do vínculo nem rejeição da sessão. O probe foi corrigido para retornar a etapa (`READ_CONFIRMED_LINK`, `CONNECT_MCP` ou `LIST_TOOLS`) e razões estáticas para arquivo ausente, leitura recusada, JSON inválido ou formato desconhecido. Caminhos, conteúdo dos arquivos e mensagens de exceção continuam privados. A nova execução no Console permanece pendente; não recriar vínculo nem alterar storage com base apenas no erro genérico.

Na execução seguinte, o usuário informou `READ_CONFIRMED_LINK / LINKS_FILE_MISSING`. Ao atualizar as referências, foi identificada a OPS-01 já integrada em `main@9aa02f2`: seu caminho padrão usa o volume Railway, enquanto o comando antigo resolvia `.ifood-links` pelo diretório atual. O comando passa a carregar `config.linksDir` do código efetivamente instalado no serviço, sem procurar sessões alternativas ou alterar storage. A diferença pode explicar o arquivo não encontrado; a presença do vínculo no caminho efetivo ainda depende da próxima execução. Se continuar ausente, verificar o fluxo humano Conectar → Confirmar no bot e a persistência OPS-01 antes de prosseguir.

**Atualização de escopo:** DEC-01 foi integrada via PR #25 e adota sacola simulada, com MCP somente leitura e zero chamadas de escrita. Ela substitui o plano condicional de preparação de carrinho acima: não executar createCart, alterações de carrinho, pagamento ou submitOrder. O inventário de F7 permanece histórico; não exigir mutações reais para validar a demo agora aprovada. As amostras autenticadas autorizadas devem se limitar às leituras necessárias à demo.

Com o comando que carrega a configuração do serviço, o usuário voltou a informar `READ_CONFIRMED_LINK / LINKS_FILE_MISSING`, com `businessToolsCalled:false`. Em seguida, uma consulta pública a `/api/health` retornou HTTP 200, `ok:true` e `linksStorage:{state:"OK",durability:"VOLUME",acceptingNewLinks:true}`. O volume está disponível para novos vínculos, mas o arquivo de vínculos não foi encontrado pelo probe no caminho efetivo. O próximo passo é concluir o fluxo humano **Conectar iFood → autorização no navegador → Confirmar conexão** no bot com a conta de teste permitida; depois repetir o probe. Não criar `links.json` manualmente nem importar a sessão global. A criação do usuário de teste no portal iFood e o login Railway não estabelecem esse vínculo. A confirmação e a captura autenticada continuam pendentes; nenhum teste de negócio externo foi realizado.

## Reuso e dependências de integração

- Reaproveitar catálogo/getItem, validação de configuração e origem de referências na demo, preservando elegibilidade por pessoa. Manter regressões do gateway e serviço F7 offline, sem conectá-los à sacola simulada.
- OPS-01 tem código de persistência de vínculos; RUN-01 tem infraestrutura de turnos duráveis, ainda sem processador DATA/IA instalado. Não comprovam persistência de carrinhos, modelo de grupo, retenção D7 ou recuperação externa. DATA-01 e GRP-01 continuam responsáveis pelo estado/elegibilidade por pessoa da demo. Referência de catálogo não comprova segurança alimentar.
- A branch incorpora agora o [contrato API-01 v1](conversation-api-v1.md). Revisão informativa F7 não é aprovação humana de uso único. A simulação exige contrato explícito de revisão/aprovação simulada conforme D8; não reutilizar a rota real `/purchase-approvals`.
- BUY-01 deve vincular a aprovação simulada à versão/hash e invalidá-la em mudança. CART-01 e BUY-02 reais ficam fora da demo adotada; contratos externos e reconciliação permanecem requisitos de uma evolução. QA-01 deve validar a simulação e zero escritas.

## Validação da integração sobre main — 18/10/2026

Windows, Node **24.13.0**, dependências instaladas com `npm ci --ignore-scripts`, lockfile da main preservado.

| Verificação | Resultado |
| --- | --- |
| `npm test -- --reporter=json --outputFile=.int01-test-results.json` | **474 passaram, 2 ignorados** (testes POSIX), 476 no total; zero falhas |
| `npm run typecheck` | passou |
| `npm run lint` | passou |
| `npm run build` | passou |
| `git diff --check` | passou |

A primeira execução no sandbox teve erros `EPERM` ao gravar os temporários de persistência; a execução completa acima passou com acesso adequado aos temporários. A comparação do comando gerado foi corrigida para normalizar LF/CRLF, mantendo a verificação do código. Três novas regressões confirmam: F7 padrão/desligada não cria carrinho na rota; o pipeline somente leitura recusa todas as mutações F7 e envio antes de chamar o MCP; listar metadados de escrita não executa `tools/call` no probe. Os erros desconhecidos, isolamento, contratos API-01 e turnos RUN-01 são exercitados na mesma suíte.

Nenhum login, leitura de credenciais pessoais, alteração de variável Railway, ensaio autenticado MCP ou operação de negócio externa foi executado nesta preparação. A CI da branch deverá confirmar a matriz Windows/Linux e Node 22.13/24 após a publicação; não confundir o resultado local com CI ou integração real.

## Verificações históricas da auditoria original

Windows, Node 24.19.0, dependências do mesmo `package-lock.json` de F7 reutilizadas do clone isolado:

| Verificação | Resultado |
| --- | --- |
| Regressões INT-01 contra F7 antes da correção | 9 falharam / 2 passaram, confirmando o problema |
| Regressões após correção | 11/11 passaram |
| Inventário + parsers adicionais | 12/12 passaram |
| Suíte completa `vitest run`, incluindo consulta do Console | **296/296 passaram**, 21 arquivos (290 da auditoria inicial + 6 da consulta manual) |
| `tsc --noEmit -p tsconfig.json` | passou |
| `eslint .` | passou |
| `vite build` | passou |
| `git diff --check` | passou |
| Healthcheck público | 200, `ok:true`; não é teste de integração MCP |

Após o resultado genérico do Console, a correção de diagnóstico foi validada com **8/8 testes do probe**, TypeScript e ESLint dos arquivos alterados. A contagem 296/296 acima registra a suíte anterior; a suíte completa não foi repetida para essa correção isolada.

Não foi executada CI/Linux, login iFood, captura autenticada de saída, mutação real, aprovação ou envio. O login e os metadados Railway são evidência separada acima. A F7 já contém ajuste de portabilidade dos testes POSIX; por isso esta suíte não reproduz as duas falhas Windows da main antiga. Esses resultados não incluem os testes da branch API-01.

- [x] Matriz separa documentado, input capturado, simulado e observado nesta auditoria.
- [x] Saídas desconhecidas bloqueiam confirmação da escrita; flag e checkout permanecem desabilitados.
- [x] Lacunas de recuperação sem ID registradas; resultado desconhecido não é limpo por leitura.
- [x] DEC-01 adotada; gatilho de fechamento simulado e fronteira somente leitura explicitados.
- [ ] Evidência autenticada das leituras necessárias à demo, com fixtures sanitizadas correspondentes.
- [ ] Saídas F7 e mecanismo de reconciliação validados para uma futura integração real, fora da demo atual.

Os itens de evidência continuam pendentes; este PR é uma entrega parcial revisável, sem encerrar INT-01 nem autorizar escrita para resolvê-los. Saídas de carrinho real não são gate de execução da sacola simulada.
