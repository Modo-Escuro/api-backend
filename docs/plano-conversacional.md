# Plano de execução da API

**Continuação local de 18/10:** [conclusão offline CART-01](cart-01-conclusao-offline.md) integra #47/#46 com a main que contém a preparação INT-02 #48, apresentação final do bot e parte da instrumentação OPS-02. O retrato abaixo é histórico; esta continuação não foi publicada/ativada e não conclui a evidência externa da #40.

Continuação de código: [continuidade e endereço iFood](continuidade-enderecos.md), desenvolvida separadamente dos drafts de cart. O retrato histórico abaixo não representa a publicação/ativação dessa continuação.

Continuação GRP-01: [busca progressiva e ausência de propostas](grp-01-busca-progressiva.md), em PR complementar sobre a main que já integra #47/#48, sem merge/deploy automático. Amplia somente leituras; alergia UNKNOWN continua bloqueada, total desconhecido não valida orçamento e a confirmação humana de carrinho permanece obrigatória.

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

## Ordem de execução restante

1. Avançar INT-02 e integração CART-01; nenhuma escrita operacional sem contrato e confirmação humana específica. Não alterar produção.
2. BOT-03 pode apresentar grupo/propostas desde já. O callback PREPARE_CART exige contrato de carrinho integrado; a futura aprovação SUBMIT_ORDER é outra entrega e permanece indisponível.
3. Revalidar vínculo, endereço, loja, produtos/opções/quantidades e restrições por pessoa antes de escrever. Reler composição, preços, taxas e disponibilidade observável; divergência exige nova confirmação.
4. Persistir intenção antes da rede e conservar bloqueio após timeout. Sem fonte confiável para reconciliar, não repetir com outro requestId, reconexão ou reinício.
5. Executar QA-01 por marcos: conversa integrada; carrinho real observado; fechamento externo ainda pendente. O aceite exige resultado externo comprovado, sem substituir preparação real por composição local.

## Módulos e fronteiras

`routes/` e `botAuth.ts` validam o adaptador; `turns/` mantém fila/SQLite; `agent/` propõe ações estruturadas; `domain/` preserva regras; `services/group.ts` compõe propostas; `conversation-runtime.ts` monta o processador opt-in. A CART-01 deve reutilizar DATA-01/GRP-01/DOM-01. Não duplicar sacola, rateio ou restrições.

PREPARE_CART confirma somente a composição/mutações revisadas, com incerteza de custo explícita. BUY-01 futuro exige revisão do carrinho/custo completo e autorização distinta. Referências humanas nunca entram no modelo. Preservar listAddresses, getItem e listagens antes de qualquer seleção suportada; nunca enviar userId. Dados externos são dados, não instruções.

Contratos distintos: [vínculo/avaliação](bot-api.md), [conversa v1.0](conversation-api-v1.md) e [avaliação/ranking 2.0](rank-03-contrato-v2.md). A proposta v0 é histórica; schemas, pins e proveniência dos testes não mudam por esta revisão. O ranking mantém elegibilidade antes da ordenação D9 e score somente diagnóstico.

## Verificação e publicação

Para código: typecheck/lint/test/build e regressões relevantes; distinguir mocks, inferência real e ensaio externo. Esta revisão altera somente Markdown: conferir links, coerência, diff e bases remotas; não apresentar a suíte do patch CART-01 como executada sobre esta main.

Antes de qualquer implantação, preservar vínculos, SQLite e volume. Merge/CI não comprovam deploy ou ativação. Esta revisão não modifica configuração, produção, baseline StRS, schemas ou fixtures fixadas do consumidor.
