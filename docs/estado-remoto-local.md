# Estado remoto, alterações locais e escopo — 18/10/2026

Retrato conferido em 18/10/2026, horário de São Paulo. Não é monitoramento contínuo. SHAs identificam código publicado; não comprovam configuração, deploy ou ensaio online.

| Superfície | Referência conferida | O que está comprovado |
| --- | --- | --- |
| API remota | [`main@f3b8b55`](https://github.com/Modo-Escuro/api-backend/tree/f3b8b5561acc0c0ae5e9efe12b52acc2f29bf218) | Montagem Gemini/AI-02/GRP-01 (#35/#36), acesso por senha (#39), persistência DATA-01/DOM-01, finalização de testes RUN-01 (#41) e observabilidade/limites OPS-02 (#38) integrados; limpeza de HTMLs #42 e revisão documental #44 incorporadas |
| Bot remoto | [`main@9314c72`](https://github.com/Modo-Escuro/telegram-bot/tree/9314c72e1324a36da09c014e74f98a470dde6306) | BOT-01/BOT-02, outbox/polling opt-in, retomada do grupo, acesso por senha (#13) e correção de entrada (#14) integrados |
| Issues remotas | [CART-01 #18](https://github.com/Modo-Escuro/api-backend/issues/18), [INT-02 #40](https://github.com/Modo-Escuro/api-backend/issues/40), [BUY-01 #19](https://github.com/Modo-Escuro/api-backend/issues/19), [BUY-02 #20](https://github.com/Modo-Escuro/api-backend/issues/20) | Escopo de carrinho confirmado registrado; outputs reais e integração continuam pendentes |
| CART-01 local | `codex/cart-01-confirmed-writes`, base `8191a0f`; patch auditado sem commit/push/merge na conferência | Implementação offline não está nas mains acima. Não transportar seus testes, rotas ou garantias para o estado remoto |
| Esta revisão documental | Cópias separadas `codex/revisao-escopo-cart01`, sobre os SHAs acima | Só Markdown; não inclui o código local CART-01, não ativa flags nem altera produção. A publicação em PR não significa merge na main |

## Decisão vigente e limites

O usuário determinou que o único escopo vigente é o carrinho real e confirmou a aprovação da equipe: **carrinho real permitido somente após confirmação humana específica do organizador**. Essa é uma decisão de escopo já tomada. A revisão D8/D10 sincroniza os documentos com ela; não é uma nova aprovação solicitada à equipe.

PREPARE_CART autoriza somente as alterações da composição revisada. A revisão precisa explicitar itens, opções, quantidades, destinatários, vínculo/conta, loja/endereço, versão/hash, expiração e custos conhecidos/desconhecidos. Sem evidência alimentar obrigatória, não escrever para o consumidor afetado. Estimativa ou custo desconhecido nunca comprova orçamento completo.

Enviar pedido (`submitOrder`), selecionar/processar pagamento (`setCartPayment`) e alterar produção continuam proibidos neste incremento. A aprovação futura de pedido é outra finalidade, depende de BUY-01/BUY-02 e exige custo completo confirmado. Nenhuma confirmação simulada, login, senha ou texto da IA pode ser convertida em autorização real.

## Marcos distintos

1. **Código integrado:** agente, grupo, ranking e infraestrutura presentes nos SHAs remotos.
2. **Carrinho real:** escopo aprovado; implementação local auditada, integração e respostas reais ainda pendentes. [INT-02](https://github.com/Modo-Escuro/api-backend/issues/40) bloqueia ativação, não o desenvolvimento offline.
3. **Fechamento externo do briefing:** continua pendente. Carrinho preparado não comprova pedido aceito nem pagamento; validar DA10 e obter resultado confiável quando esse escopo for autorizado.

A INT-01 #7 fechada cobre auditoria/metadados, não saídas reais de negócio. O usuário confirmou que não havia capturas de createCart/getCart/mutações ou ambiente autenticado disponibilizado nesta sessão. Não inferir execução de tools/list, escopos ou CI.

## Evidência e manutenção

O ensaio de login de 17/10 e os testes contra commits fixados continuam históricos. Não alterar fixtures, hashes, StRS ou proveniência para fazê-los parecer evidência atual. Código integrado não prova ativação do modelo ou conversa ponta a ponta no Telegram.

Ao atualizar este retrato, registrar novos SHAs e evidências; nunca somar o estado de uma branch local ao estado da main remota. As cópias históricas de documentos estão no histórico Git dos SHAs acima.
