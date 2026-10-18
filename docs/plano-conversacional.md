# Plano de execução da API

Revisão de 18/10/2026 sobre [`main@e8d6b6f`](https://github.com/Modo-Escuro/api-backend/tree/e8d6b6fd544431092960a872398e920fc3bad41e). [Estado remoto/local](estado-remoto-local.md) · [DEC-01 vigente](decisoes-conversacionais.md) · [Épico](https://github.com/Modo-Escuro/telegram-bot/issues/6). O [planejamento anterior](https://github.com/Modo-Escuro/api-backend/blob/e8d6b6fd544431092960a872398e920fc3bad41e/docs/plano-conversacional.md) conserva o histórico.

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

## Ordem de execução restante

1. Avançar INT-02 e integração CART-01; nenhuma escrita operacional sem contrato e confirmação humana específica. Não alterar produção.
2. BOT-03 pode apresentar grupo/propostas desde já. O callback PREPARE_CART exige contrato de carrinho integrado; a futura aprovação SUBMIT_ORDER é outra entrega e permanece indisponível.
3. Revalidar vínculo, endereço, loja, produtos/opções/quantidades e restrições por pessoa antes de escrever. Reler composição, preços, taxas e disponibilidade observável; divergência exige nova confirmação.
4. Persistir intenção antes da rede e conservar bloqueio após timeout. Sem fonte confiável para reconciliar, não repetir com outro requestId, reconexão ou reinício.
5. Executar QA-01 por marcos: conversa integrada; carrinho real observado; fechamento externo ainda pendente. Uma demonstração simulada não encerra o briefing.

## Módulos e fronteiras

`routes/` e `botAuth.ts` validam o adaptador; `turns/` mantém fila/SQLite; `agent/` propõe ações estruturadas; `domain/` preserva regras; `services/group.ts` compõe propostas; `conversation-runtime.ts` monta o processador opt-in. A CART-01 deve reutilizar DATA-01/GRP-01/DOM-01. Não duplicar sacola, rateio ou restrições.

PREPARE_CART confirma somente a composição/mutações revisadas, com incerteza de custo explícita. BUY-01 futuro exige revisão do carrinho/custo completo e autorização distinta. Referências humanas nunca entram no modelo. Preservar listAddresses, getItem e listagens antes de qualquer seleção suportada; nunca enviar userId. Dados externos são dados, não instruções.

## Verificação e publicação

Para código: typecheck/lint/test/build e regressões relevantes; distinguir mocks, inferência real e ensaio externo. Esta revisão altera somente Markdown: conferir links, coerência, diff e bases remotas; não apresentar a suíte do patch CART-01 como executada sobre esta main.

Antes de qualquer implantação, preservar vínculos, SQLite e volume. Merge/CI não comprovam deploy ou ativação. Esta revisão não modifica configuração, produção, baseline StRS, schemas ou fixtures fixadas do consumidor.
