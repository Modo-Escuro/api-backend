# CART-01 — Integração e conclusão offline em 18/10/2026

Esta continuação acompanha o [draft API #46](https://github.com/Modo-Escuro/api-backend/pull/46) e o [draft bot #17](https://github.com/Modo-Escuro/telegram-bot/pull/17). Endereço API #47 e bot #18 já estão nas respectivas mains (`a027ed4` e `6adb78d`). O registro abaixo conserva a preparação/auditoria local anterior à publicação. Publicar estes drafts não significa merge, deploy ou ativação.

Implementação local em `codex/cart-01-integration`, a pedido do usuário. Fontes: CLAUDE.md, DEC-01 D2–D10, plano conversacional, contratos DATA-01/DOM-01/GRP-01/RUN-01, documentação CART-01 e INT-02, além de AGENTS.md e regras preservadas do bot. Baseline, fixtures observadas, hashes históricos e pins de testes anteriores foram preservados.

## Bases e alcance

| Origem | Referência incorporada localmente |
| --- | --- |
| API main com INT-02 #48 | `39edd95`, incluindo `7922a04` |
| Endereço API #47 | `a72f7958bafda3036a5c6f77045d13925b25233b` |
| Carrinho API #46 | `f5eab0dc703cd1a282300f4387279b82ce36bd59` |
| Endereço bot #18 | `52b9381b98b500a00d483d20c38e6255ea68e0fd` |
| Carrinho bot #17 | `0d6caeceb2dc428edc2503c8c1fc0ac6777eac85` |

As branches originais e o checkout antigo do bot foram preservados. A cópia de integração do bot fica em `.work/telegram-bot`, com Git próprio; `.work/` é ignorado pela API. Estes SHAs identificam bases, não um novo commit publicado. Integração local não significa merge dos PRs ou deploy.

1. Endereço: mantém escolha humana inclusive com uma opção, vínculo/releitura, expiração e persistência da referência autorizada. A montagem da API reúne endereços e CART-01 no mesmo runtime; o roteador do bot preserva ambos os callbacks, fora do modelo.
2. Backend: incorpora a regressão INT-02 de remoção após resultado desconhecido e a orquestração durável CART-01. Não reutiliza o caminho legado F7.
3. Revisão: acrescenta conta mascarada, nome da loja, resumo seguro do endereço e nomes observados de itens/opções, inclusive itens remotos a remover. Dado ausente, ID divergente ou descrição longa impede a confirmação. Não infere um nome de um ID.
4. Confirmação: hashes das descrições são vinculados ao plano; alteração dos nomes/identidade revisados invalida o clique, mesmo com preço/total iguais. As guardas do endereço e da versão continuam imediatamente antes do despacho.
5. Consulta final: o bot recupera a intenção por GET e consulta `current` para mostrar itens, opções, quantidades, preços, taxas, descontos e total observados. Uma falha nessa consulta não muda SUCCEEDED para RESULT_UNKNOWN nem repete POST. A consulta não revalida elegibilidade e informa esse limite.

## Contrato adicional de apresentação

Prefixo `B = /api/bot/v1/conversations/:conversationId/cart-writes`.

- `POST B/reviews` acrescenta `display: {accountLabel, merchantName, addressLabel, items:[{itemId,name,options:[{optionId,name,quantity}]}]}`. `lines`, `remoteItems`, `remoteCosts`, `changes`, versão/hash, prazo e referência mantêm suas finalidades anteriores. O total posterior continua desconhecido.
- `GET B/current` acrescenta o mesmo `display`, além dos custos em centavos já projetados, `budget`, `eligibility:NOT_REVALIDATED` e `purchaseAuthorized/checkoutEnabled/paymentEnabled:false`.
- `GET B/requests/:requestId` continua metadado técnico da intenção. Não implica que o carrinho atual ainda corresponde à revisão antiga. A apresentação distingue conclusão da preparação de consulta atual e avisa orçamento não verificado ou excedido.
- `descriptionHashes` no plano contém somente hashes técnicos. Identidade mascarada e resumo do endereço não são copiados para o plano ou para SQLite do bot. A DATA-01 mantém seu domínio/retenção existentes.
- Os rótulos vêm de campos já usados de getUser/listAddresses/getItem/searchOffers. Nenhum novo formato de resposta MCP foi inventado ou declarado observado. `contracts.ts` e o gate de evidências não foram relaxados.

O callback continua PREPARE_CART de uso único. Textos, senha, login e seleção de endereço não autorizam escrita. O modelo não recebe referência humana nem ganha ferramenta de preparação. Revisão acima do limite de apresentação bloqueia o botão; não se corta uma parte para conseguir confirmação.

## Avanço da OPS-02 #21

Métricas `cart_write_attempts_total` e `cart_write_duration_ms`, apenas por ferramenta/outcome fechado (ACKNOWLEDGED ou RESULT_UNKNOWN). Replay por GET não incrementa tentativas. O status autenticado acrescenta `purchase.cartIntents`, contagens persistidas de PENDING/SUCCEEDED/FAILED/RESULT_UNKNOWN, inclusive com escrita desligada. Sem ID, conta, payload, referência, endereço ou conteúdo nos rótulos. As métricas são voláteis; as contagens vêm do SQLite.

Isso adianta a instrumentação de carrinho da OPS-02, sem encerrar ensaios de volume, backup/restauração, plataforma ou liberação gradual.

## Validação e limites

O ensaio `test_cart_integration.py` do bot usa HTTP/Hono/SQLite reais e gateway MCP falso: endereço obrigatório, revisão completa, clique humano, composição/custos finais, replay e isolamento; perda de resposta com recuperação por GET; falha da consulta após sucesso; RESULT_UNKNOWN preservado após reinício de API e bot sem segunda escrita. O provedor falso persiste seu efeito separadamente do banco da API. Não roda polling Telegram nem operações externas.

Checks finais após a correção da auditoria: API **1.050 aprovados, 2 ignorados por plataforma, 1.052 no total**, em 59 arquivos; typecheck, lint e build aprovados. Bot **237 aprovados, nenhum ignorado**, incluindo os três ensaios CART-01, os três de continuidade/endereço e os sete históricos RUN-01 com seus pins preservados; Ruff check/format, compileall, pip check e CLI --help aprovados. `git diff --check` aprovado em ambos. Os testes de criação de arquivos/SQLite foram executados fora da restrição que causava EPERM nos temporários; nenhum critério foi relaxado.

### Auditoria independente desta continuação

Um subagente somente leitura, autorizado pelo usuário, inspecionou o novo delta e reproduziu 87 testes API, 22 testes bot e três ensaios HTTP. Encontrou um P2: a chave da configuração incluía `name` da opção no rótulo, mas o snapshot remoto só tinha ID/quantidade; a mesma configuração aparecia duas vezes e o bot recusava a revisão de atualização.

Correção: `labelKey` projeta somente itemId/optionId/quantity; os nomes continuam vinculados por hashes das descrições. Nova regressão API exercita criar → mudar quantidade → revisar com rótulo único → atualizar, com opção; o bot valida a mesma configuração atual/desejada e rejeita duplicatas. Reauditoria reproduziu o probe (um rótulo, sem consulta redundante), quatro regressões API selecionadas e 23/23 testes bot aprovados. Nenhum achado acionável permanece no delta revisado: **GO técnico para revisão/integração com flags desligadas**, sem GO operacional.

A auditoria também registrou a limitação não bloqueante de API lenta: após timeout e GET com PENDING, o bot orienta Conferir carrinho para recuperação manual por GET, sem repetir escrita. O acompanhamento contínuo desse estado pode evoluir na BOT-03.

## Gates externos ainda abertos

- O merge #48 concluiu preparação **offline** da INT-02. Seu relatório e a issue #40 ainda não apresentam outputs autenticados de create/get/add/update/remove. Todas as operações reais continuam NO-GO; não há manifesto operacional nesta entrega.
- Falta disponibilizar um ambiente autorizado e uma sessão autenticada para obter evidência sanitizada por operação. Não acessar configurações pessoais para procurar credenciais. Cada captura de escrita exige revisão humana específica e intenção persistida antes da rede; o ensaio não pode contornar essas regras.
- Ajustar parsers somente ao efetivamente observado, validar unidades/custos/cartItemId/erros e registrar GO/NO-GO por operação. Sem recuperação confiável, criação sem cartId e escrita desconhecida permanecem bloqueadas sem retry; releitura não elimina corrida externa.
- Depois da revisão independente e dos gates de contrato, ensaiar em ambiente autorizado. API antes do bot, preservando bancos/WAL/SHM/vínculos e uma instância. Não restaurar banco antigo sobre intenção pendente. Schema v3 não é revertido para v2: rollback funcional desliga o opt-in e mantém bloqueios.

`IFOOD_CONFIRMED_CART_WRITES_ENABLED=false` e `TELEGRAM_CART_ENABLED=false` continuam os padrões. Nenhuma produção, Railway, polling real, pagamento ou envio foi alterado. Não fechar #18/#40 por este teste offline.

## Próximas issues que podem avançar

- BOT-03: esta entrega cobre revisão/resultado CART-01; ainda faltam escolha/correção completa de propostas por botões e avaliação da experiência integral.
- BUY-01 #19: desenvolver offline a autorização SUBMIT_ORDER com finalidade distinta, responsável/conta/versão/hash/custo completo/prazo e consumo atômico. Usar como regressões: PREPARE_CART recusado como autorização de pedido, clique antigo, outro vínculo, custos alterados e dois cliques simultâneos. Não implementar emissão de pedido como efeito dessa preparação.
- BUY-02 #20: testes com provedor falso e desenho da reconciliação podem avançar. Operação real depende de contrato próprio de submit/status/recuperação e autorização de escopo futura. As capturas de carrinho não encerram esse contrato.
- OPS-02 #21: complementar os ensaios operacionais e o procedimento para intenção desconhecida, sem apagar bloqueios para liberar nova tentativa.
