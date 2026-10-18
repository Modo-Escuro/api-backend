# Estado remoto, alterações locais e escopo — 18/10/2026

**Continuação no draft #46:** [integração e auditoria offline](cart-01-conclusao-offline.md) incluem main `a027ed4` (INT-02 #48 e endereço #47), revisão completa e instrumentação parcial OPS-02. O quadro abaixo conserva referências históricas; código em draft não significa merge/deploy/ativação.

Retrato conferido em 18/10/2026, horário de São Paulo. Não é monitoramento contínuo. SHAs identificam código publicado; não comprovam configuração, deploy ou ensaio online.

| Superfície | Referência conferida | O que está comprovado |
| --- | --- | --- |
| API main | [`8a6dadc`](https://github.com/Modo-Escuro/api-backend/tree/8a6dadc82ff8c7e952b665dedad6876677fade6b) | Gemini/AI-02/GRP-01, RUN-01/DATA-01/DOM-01, OPS-02 #38, documentação #43/#44 e conclusão do vínculo no navegador #45 integrados |
| Bot main | [`d239edd`](https://github.com/Modo-Escuro/telegram-bot/tree/d239edd43d072198367fd2fda3846fa29774ba65) | BOT-01/BOT-02, senha, retomada, navegação/voz opt-in #15 e documentação #16 integrados |
| API CART-01 | [PR #46](https://github.com/Modo-Escuro/api-backend/pull/46), `codex/cart-01-confirmed-writes` | Código publicado em draft, conciliado com #43/#45 nesta continuação. Não integrado na main nem ativado |
| Bot CART-01 | `codex/cart-01-telegram` | Incremento separado de revisão/callback PREPARE_CART e recuperação técnica por GET. OFF; revisão final e identificação legível completa continuam pendentes |
| Dependências | [CART-01 #18](https://github.com/Modo-Escuro/api-backend/issues/18), [INT-02 #40](https://github.com/Modo-Escuro/api-backend/issues/40), [BOT-03 #3](https://github.com/Modo-Escuro/telegram-bot/issues/3), [BUY-01 #19](https://github.com/Modo-Escuro/api-backend/issues/19) | Código parcial/testes offline não encerram as issues nem comprovam operação externa |

Atualização posterior ao merge de API #43 e bot #16. Os retratos anteriores permanecem no histórico Git; não foram usados como estado ao vivo. Produção, deploys, volumes e modelo pago não foram alterados nesta continuação.

## Decisão vigente e limites

O usuário determinou que o único escopo vigente é o carrinho real e confirmou a aprovação da equipe: **carrinho real permitido somente após confirmação humana específica do organizador**. Essa é uma decisão de escopo já tomada. A revisão D8/D10 sincroniza os documentos com ela; não é uma nova aprovação solicitada à equipe.

PREPARE_CART autoriza somente as alterações da composição revisada. A revisão precisa explicitar itens, opções, quantidades, destinatários, vínculo/conta, loja/endereço, versão/hash, expiração e custos conhecidos/desconhecidos. Sem evidência alimentar obrigatória, não escrever para o consumidor afetado. Estimativa ou custo desconhecido nunca comprova orçamento completo.

Enviar pedido (`submitOrder`), selecionar/processar pagamento (`setCartPayment`) e alterar produção continuam proibidos neste incremento. A aprovação futura de pedido é outra finalidade, depende de BUY-01/BUY-02 e exige custo completo confirmado. Nenhuma confirmação simulada, login, senha ou texto da IA pode ser convertida em autorização real.

## Marcos distintos

1. **Código integrado:** agente, grupo, ranking e infraestrutura presentes nos SHAs remotos.
2. **Carrinho real:** escopo aprovado; implementação publicada em draft, canal humano parcial e respostas reais ainda pendentes. [INT-02](https://github.com/Modo-Escuro/api-backend/issues/40) bloqueia ativação, não o desenvolvimento offline.
3. **Fechamento externo do briefing:** continua pendente. Carrinho preparado não comprova pedido aceito nem pagamento; validar DA10 e obter resultado confiável quando esse escopo for autorizado.

A INT-01 #7 fechada cobre auditoria/metadados, não saídas reais de negócio. O usuário confirmou que não havia capturas de createCart/getCart/mutações ou ambiente autenticado disponibilizado nesta sessão. Não inferir execução de tools/list, escopos ou CI.

## Evidência e manutenção

O ensaio de login de 17/10 e os testes contra commits fixados continuam históricos. Não alterar fixtures, hashes, StRS ou proveniência para fazê-los parecer evidência atual. Código integrado não prova ativação do modelo ou conversa ponta a ponta no Telegram.

Ao atualizar este retrato, registrar novos SHAs e evidências; nunca somar o estado de uma branch local ao estado da main remota. As cópias históricas de documentos estão no histórico Git dos SHAs acima.
