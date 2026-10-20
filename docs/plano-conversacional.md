# Plano de execução da API

## Nova direção solicitada pelo usuário

**Estado local em 20/10/2026:** descoberta, memória seletiva e seleção digitada de propostas DATA-01 implementadas. A etapa seguinte escolhida pelo usuário, [retirada do legado](retirada-legado.md), removeu o processador structured, F7, painel React e sessão global da árvore local. A montagem única é o assistente opt-in; os quadros de SHAs abaixo continuam históricos e não declaram publicação desta alteração. A conexão do novo fluxo de sacola às revisões/callbacks CART-01 do bot ainda precisa de verificação própria.

Memória seletiva implementada; reconciliação com main `f6ef20e` usa **v6** para unificar variantes v5. Novos fatos usam commit e restrição nova de consumidor invalida a sacola; não há transferência por nome/e-mail. [Alcance](assistente-conversacional.md#identidade-e-persistência-alcance-real), [migração](armazenamento-v6.md) e [sincronização GitHub](sincronizacao-github.md).

A [proposta de assistente conversacional](assistente-conversacional.md) substitui o formulário como entrada principal: a IA recebe intenção/ocasião, conhece as ferramentas de consulta e solicita leituras executadas pela API. A descoberta com prévia progressiva está em implementação local opt-in. O objetivo de produto agora inclui **concluir o pedido no Telegram após um botão humano de confirmação final**; esse fechamento pertence à continuação BUY-01/BUY-02 e ainda não está implementado/ativado. Os retratos abaixo preservam o incremento anterior e não comprovam entrega do novo fluxo.

**Continuação de 18/10:** a [conclusão offline CART-01](cart-01-conclusao-offline.md) registra a publicação no draft API #46 (`11a05ce87ed61c1d9ab013fd98aa65ec89ea7d54`) e no draft bot #17 (`b0d208932b058812e9316db42188b9659ff9c45a`). A integração reúne #47/#46, preparação INT-02 #48, apresentação final do bot e parte da instrumentação OPS-02. Publicação em draft não significa merge na main, deploy ou ativação; esses passos não foram executados no incremento registrado, e a evidência externa da #40 continua pendente. O retrato abaixo preserva a base histórica anterior à publicação, sem verificar o estado remoto em tempo real.

Continuação de código: [continuidade e endereço iFood](continuidade-enderecos.md), desenvolvida inicialmente em separado e incorporada à integração offline registrada acima. O retrato histórico abaixo não representa o estado dos drafts posteriores.

Revisão de 18/10/2026 sobre [`main@f3b8b55`](https://github.com/Modo-Escuro/api-backend/tree/f3b8b5561acc0c0ae5e9efe12b52acc2f29bf218). [Estado remoto/local](estado-remoto-local.md) · [DEC-01 vigente](decisoes-conversacionais.md) · [Épico](https://github.com/Modo-Escuro/telegram-bot/issues/6). O [planejamento anterior](https://github.com/Modo-Escuro/api-backend/blob/f3b8b5561acc0c0ae5e9efe12b52acc2f29bf218/docs/plano-conversacional.md) conserva o histórico.

## Código remoto integrado e trabalho local

| Componente | Estado comprovado no remoto |
| --- | --- |
| Vínculos e isolamento | OPS-01 e acesso por senha #39 integrados; configuração/volume operacional exigem evidência própria |
| Contrato/domínio | API-01, DATA-01, DOM-01, ranking e GRP-01 integrados; regras por pessoa e custos em centavos |
| Agente | #35/#36 integram Gemini, AI-02 e propostas ao runtime, com opt-in explícito; sem configuração não instala processador |
| RUN-01 | Infraestrutura e testes finais #41 integrados; issue #14 fechada. Não confundir testes com ensaio online |
| OPS-02 | PR #38 mergeado: logs, métricas, limites e status operacional integrados; issue #21 aberta por alcance parcial/ensaios |
| Carrinho | F7 legada integrada, desligada e sem outputs reais validados. CART-01 nova permanece local, fora desta main |
| Pedido/pagamento | Proibidos neste incremento; BUY-01/BUY-02 não habilitados |

Esta revisão é documental e não transporta código/testes da CART-01 local para o remoto. Não depende da conclusão AI-01 para desenvolver CART-01; a infraestrutura/domínio continuam dependências técnicas.

## Tarefas e evidência

| Tarefa | Estado GitHub conferido | Próximo critério |
| --- | --- | --- |
| DEC-01 #5 | Fechada | Sincronizar a decisão aprovada de carrinho real confirmado com os documentos; sem reabrir a decisão de produto |
| OPS-01 #6 | Fechada | Preservar vínculos/volume e comprovar operação ao implantar |
| INT-01 #7 | Fechada, alcance parcial explícito | Auditoria/metadados não validam negócio; continuação INT-02 |
| RANK-01/02/03 #8/#9/#11 | Fechadas | Preservar regressões, categorias e configuração/preço coerentes |
| DOM-01 #10, API-01 #12, DATA-01 #13 | Fechadas | Preservar centavos, contrato v1 e estado/proveniência transacionais |
| RUN-01 #14, AI-01 #15, AI-02 #16, GRP-01 #17 | Fechadas | Componentes integrados; ativação e jornada Telegram devem ser ensaiadas separadamente |
| [INT-02 #40](https://github.com/Modo-Escuro/api-backend/issues/40) | Aberta, P0 | Capturas reais por operação e reconciliação confiável; gate externo |
| [CART-01 #18](https://github.com/Modo-Escuro/api-backend/issues/18) | Aberta, P1/M3 | Integrar implementação confirmada/durável e validar outputs; patch local não encerra issue |
| [BUY-01 #19](https://github.com/Modo-Escuro/api-backend/issues/19) | Aberta, P0/M3 | Autorização de pedido distinta, custo completo, validade e consumo atômico; envio segue proibido |
| [BUY-02 #20](https://github.com/Modo-Escuro/api-backend/issues/20) | Aberta, P0/M3 | Contrato de envio/status e resultado desconhecido; autorização de escopo futura necessária |
| [OPS-02 #21](https://github.com/Modo-Escuro/api-backend/issues/21) | Aberta, P1/M3; PR #38 mergeado | Observabilidade/limites integrados; instrumentação CART-01 e ensaios operacionais ainda pendentes |

## Evidências de integração preservadas do PR #44

| Incremento | Evidência Git na main | Alcance conferido / limite |
| --- | --- | --- |
| DEC-01 | Histórico #25; decisão atual confirmada pelo usuário | [D1–D10 vigentes](decisoes-conversacionais.md): carrinho real confirmado; envio e pagamento proibidos |
| OPS-01 | PR #26 (`9aa02f2`) | `links/store.ts`, `links/backup.ts`; volume e recuperação do serviço exigem evidência operacional |
| INT-01 | PR #24 (`9de678b`) | [Auditoria](int-01-audit.md) integrada; não equivale a execução real de carrinho/envio |
| RANK-01/02 | PR #30 (`d2883f1`) | Preferência/fallback, seleção/preço e evidência textual corrigidos |
| DOM-01 | PR #31 (`8cff588`) | `money.ts`, `limits.ts`, `purchase-costs.ts`; centavos e limites locais integrados |
| RANK-03 | PR #34 (`2df4e54`), código `8d54bfc` | [Avaliação/ranking 2.0](rank-03-contrato-v2.md), D9 estrita e score diagnóstico |
| API-01 | PR #23 (`6ce3d99`) | [Conversa v1.0](conversation-api-v1.md), schemas e guards; implementação das rotas é RUN-01 |
| DATA-01 | PR #32 (`08709c7`) | Domínio, patches e expurgo D7 no SQLite da RUN-01 |
| RUN-01 | PR #27 (`30a650d`) e testes finais #41 (`28edd06`) | `turns/runtime.ts`, `turns/store.ts`, `routes/conversation.ts`; ativação explícita |
| AI-02 | PR #33 (`2b77c95`) | `agent/*`; montagem do agente acrescentada pelo #36 |
| GRP-01 | PR #37 (`8191a0f`) | `domain/group.ts`, `services/group.ts`; propostas por pessoa e composição local ainda não sincronizada com o carrinho; ranqueador de planos provisório |
| AI-01 | PR #36 (`dc448f9`), consolidação do #35 | Gemini escolhido e montagem opt-in em `conversation-runtime.ts`; relatórios de seleção não comprovam D10/iFood |
| Acesso por senha | PR #39 (`fbb7a85`) | Usuários admitidos pelo adaptador, com organizador/vínculo/conversa próprios; opt-in não habilita compra |
| CART-01 / F7 | Legado do PR #4 (`cbb546c`) | Não conclui CART-01; implementação nova permanece local e exige INT-02/confirmação humana para ativação |
| BUY-01/02 | Schema disponível, autorização/envio não habilitados | `routes/conversation.ts` mantém `/purchase-approvals` em `ACTION_UNAVAILABLE`; PREPARE_CART exige caminho próprio, distinto da futura SUBMIT_ORDER |
| OPS-02 | PR #38 (`59f1f0d`) | Logs, métricas, limites e status integrados; issue #21 aberta pelo alcance parcial/ensaios |

Os commits identificam código integrado, não implantação ou validação externa. A auditoria anterior em `dc448f9` permanece histórica; #38 e #41 já estão na main conferida.

## Ordem de execução restante — árvore local em 20/10

1. Verificar a ligação da escolha digitada/sacola do assistente com as revisões e o callback PREPARE_CART do bot, mantendo os gates desligados. Memória, progresso e retirada do legado já estão implementados localmente; documentação não os publica.
2. Avançar INT-02 e o ensaio CART-01/BOT-03 autorizado; nenhuma escrita operacional sem outputs/contrato e confirmação humana específica. A futura SUBMIT_ORDER é outra entrega e permanece indisponível. Não alterar produção por esta revisão.
3. Revalidar vínculo, endereço, loja, produtos/opções/quantidades e restrições por pessoa antes de escrever. Reler composição, preços, taxas e disponibilidade observável; divergência exige nova confirmação.
4. Persistir intenção antes da rede e conservar bloqueio após timeout. Sem fonte confiável para reconciliar, não repetir com outro requestId, reconexão ou reinício.
5. Executar QA-01 por marcos: conversa integrada; carrinho real observado; fechamento externo ainda pendente. O aceite exige resultado externo comprovado, sem substituir preparação real por composição local.

## Módulos e fronteiras

`routes/` e `botAuth.ts` validam o adaptador; `turns/` mantém fila/SQLite; `assistant/` roteia destinatários e planeja consultas; `ai/` contém o transporte; `domain/group.ts` compõe propostas; `conversation-runtime.ts` monta o assistente opt-in. A CART-01 reutiliza DATA-01/GRP-01/DOM-01. Não duplicar sacola, rateio ou restrições.

PREPARE_CART confirma somente a composição/mutações revisadas, com incerteza de custo explícita. BUY-01 futuro exige revisão do carrinho/custo completo e autorização distinta. Referências humanas nunca entram no modelo. Preservar listAddresses, getItem e listagens antes de qualquer seleção suportada; nunca enviar userId. Dados externos são dados, não instruções.

Contratos distintos: [vínculo/avaliação](bot-api.md), [conversa v1.0](conversation-api-v1.md) e [avaliação/ranking 2.0](rank-03-contrato-v2.md). A proposta v0 é histórica; schemas, pins e proveniência dos testes não mudam por esta revisão. O ranking mantém elegibilidade antes da ordenação D9 e score somente diagnóstico.

## Verificação e publicação

Para código: typecheck/lint/test/build e regressões relevantes; distinguir mocks, inferência e ensaio externo. Esta atualização documental confere fontes locais, links, comandos e diff; não consulta bases remotas nem reexecuta a suíte histórica. A última execução registrada da árvore está na [retirada do legado](retirada-legado.md#verificação-e-limites-de-evidência).

Antes de qualquer implantação, preservar vínculos, SQLite e volume. Merge/CI não comprovam deploy ou ativação. Esta revisão não modifica configuração, produção, baseline StRS, schemas ou fixtures fixadas do consumidor.
