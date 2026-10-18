# CART-01 — Integração sobre a main atual

Integração de 18/10/2026, base `f3b8b5561acc0c0ae5e9efe12b52acc2f29bf218`, branch `codex/cart-01-confirmed-writes`. Código reaproveitado da implementação local anteriormente auditada sobre `8191a0f`, cujo [relatório original](cart-01-auditoria.md) é histórico. A implementação original e seu patch foram preservados; SHA-256 do patch: `3897aef6d8be0dcbca65aca8409e873ebf5837ea772ec016990343b97ed173c0`.

## Resultado e alcance

O incremento prepara criação e alterações de itens de carrinho por confirmação humana específica PREPARE_CART, usando a compra/sacola da DATA-01/GRP-01 e o dinheiro da DOM-01. Confirmação/intenção e reconhecimento/cartId são persistidos atomicamente. Replay consulta a intenção; falha parcial interrompe a sequência; resultado desconhecido impede novas escritas. O [contrato e fluxo completo](cart-01-escrita-confirmada.md) detalha os limites.

O PR mantém **`IFOOD_CONFIRMED_CART_WRITES_ENABLED=false`**. Não inclui evidência operacional de contrato nem callback Telegram BOT-03. Não envia pedido, não seleciona/processa pagamento, não muda flags da Railway e não faz deploy/merge. Não há autorização de compra pela IA.

## Correções da integração

| Ponto | Comportamento integrado e evidência |
| --- | --- |
| Montagem atual | Mantém Gemini, orçamento/status OPS-02, autenticação por senha e rollout da main. CART-01 usa o mesmo runtime/banco, com opt-in próprio e sem exigir modelo |
| Permissões de vínculo | Auditor reproduziu P1: CART dependia da flag F7, incompatível com Gemini. O serviço agora anuncia CART_READ/CART_WRITE pelo opt-in novo e escopos, sem liberar CART_PAYMENT. Regressão usa IfoodLinkService real com OAuth/MCP falsos |
| Rollout | A lista `CONVERSATION_ORGANIZER_IDS` também restringe revisão, confirmação e consultas do carrinho; não amplia a autorização do middleware |
| Erros | A nova fronteira HTTP não devolve erro bruto MCP/SDK ou mensagem externa. Regressão usa erro com dados privados inteiramente sintéticos |
| Migração e rollback | Schema **v3**, migração aditiva/transacional desde v1/v2 preservando compra, operações e replay. Código v2 recusa o banco v3; desligar opt-in não remove intenções |
| Recuperação sem interface | Auditor reproduziu P2: PENDING vencido ficava preso se nenhuma rota CART era chamada. Agora o ciclo RUN-01 recupera mesmo sem montar CART: `sent=0 → FAILED`; `sent=1 → RESULT_UNKNOWN`. Nenhuma chamada remota é retomada |
| Status operacional | Informa `HUMAN_CONFIRMATION_REQUIRED` quando o caminho CART está montado. Isso não atesta contrato validado, compra autorizada ou capacidade de envio |

## Auditoria independente

O usuário autorizou subagente revisor somente leitura. A auditoria inspecionou o diff, reproduziu os dois problemas acima em SQLite/testes offline e reavaliou as correções. Também conferiu confirmação humana, replay, persistência de cartId, schema v3, rollout, sanitização e bloqueios alimentares/financeiros.

Parecer final: **GO técnico para PR com CART-01 desligada**, sem bloqueadores remanescentes no recorte auditado. Validação independente: **113/113 testes em quatro arquivos** e `git diff --check` aprovados; o probe de recuperação passou de PENDING para FAILED. O auditor não editou fontes nem usou rede/credenciais.

## Verificações da integração

Ambiente local Windows, Node 24.13.0, npm 11.6.2. Dependências do lockfile da main instaladas por `npm ci --ignore-scripts`; nenhum pacote/lockfile alterado.

- `npm run typecheck`: aprovado.
- `npm run lint`: aprovado.
- `git diff --check HEAD`: aprovado.
- Prova offline com o código anterior real: TurnStore v2 recusou o banco v3, mantendo schema e RESULT_UNKNOWN.
- Testes direcionados iniciais: 79/79 aprovados; após os ajustes de erro/recuperação, o revisor independente executou 113/113.
- `npm run build`: aprovado.
- `npm test -- --maxWorkers=2`: **983 aprovados, 0 falhas, 2 ignorados; 985 no total**. É a mesma concorrência configurada no repositório.

A primeira suíte completa teve 982 aprovações, 2 testes ignorados e um timeout de 5 s no teste de morte real do processo na etapa `effect`. A repetição completa passou com os mesmos critérios/timeout; não se contou a primeira execução como aprovada. Os dados, gateways e transportes usados são sintéticos; SQLite e processos filhos são reais.

## Gates que permanecem abertos

**NO-GO operacional** até [INT-02 #40](https://github.com/Modo-Escuro/api-backend/issues/40), capturas autenticadas revisadas, validação do comportamento remoto e callback humano [BOT-03](https://github.com/Modo-Escuro/telegram-bot/issues/3). Nenhuma fixture sintética foi apresentada como resposta real.

Na consulta anterior à publicação não havia branch/PR de código CART-01 concorrente no remoto; o trabalho não publicado de Maylon não foi sobrescrito. Uma eventual implementação paralela precisa ser confrontada antes do merge. A revisão documental [#43](https://github.com/Modo-Escuro/api-backend/pull/43) continua separada deste código.

[CART-01 #18](https://github.com/Modo-Escuro/api-backend/issues/18), [BUY-01 #19](https://github.com/Modo-Escuro/api-backend/issues/19) e [BUY-02 #20](https://github.com/Modo-Escuro/api-backend/issues/20) não são encerradas por este incremento. PREPARE_CART autoriza só as mutações revisadas; SUBMIT_ORDER exige outra finalidade/autorização e continua indisponível. Sem mecanismo confiável para reconciliar criação sem cartId ou escrita desconhecida, o bloqueio permanece. Releitura não elimina corrida externa nem promete execução única no iFood.
