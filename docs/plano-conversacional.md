# Plano de execução da API

Planejamento publicado em 18/10/2026; estado documental sincronizado por evidência Git nessa data.
[Plano integrado do bot](https://github.com/Modo-Escuro/telegram-bot/blob/main/docs/plano-conversacional.md) · [Épico](https://github.com/Modo-Escuro/telegram-bot/issues/6) · [Backlog](https://github.com/Modo-Escuro/telegram-bot/blob/main/docs/backlog-conversacional.md).
Os planos iniciais do bot preservam trechos históricos; para contratos e decisões vigentes, usar as referências abaixo.

## Estado e trabalho reaproveitável

**Referência auditada:** `origin/main@dc448f9e117e05192004514a639c3ed5acd1098a` do backend e
`telegram-bot/main@9314c72e1324a36da09c014e74f98a470dde6306`. Não se deduziu integração pelo fechamento de issues:
foram conferidos merges, ancestralidade e os arquivos correspondentes.

- O checkout desta auditoria continua em `branchBruna@2df4e54`, com RANK-03 já integrada; **não contém todos os
  incrementos posteriores da main**. A branch local `main@686300d` também está antiga; `origin/main` é a referência
  remota conferida. `origin/branchBruna@8d54bfc` conserva o commit do PR #34. Nenhuma branch foi trocada ou integrada.
- `branchBruna@8393615` e a [revisão correspondente](reviews/branchBruna-8393615.md) são históricos. RANK-01/02 foram
  integradas pelo PR #30 (`d2883f1`); RANK-03 pelo PR #34 (`2df4e54`), com implementação `8d54bfc` e resposta de avaliação 2.0.
- O código de conversa, persistência, agente e composição coletiva já existe na main, nos alcances da tabela abaixo.
  `src/server/index.ts` chama `createConversationRuntime`; em `dc448f9`, essa montagem conecta Gemini → AI-02 →
  RUN-01/DATA-01 e o provedor de propostas GRP-01 somente com opt-ins/configuração válidos. Sem modelo habilitado,
  runtime sem processador continua recusando eventos novos. Ver [montagem AI-01](https://github.com/Modo-Escuro/api-backend/blob/dc448f9e117e05192004514a639c3ed5acd1098a/docs/ai-01-montagem-ensaio.md).
- No bot, PR #10 (`c29cc04`) integra cliente v1/fila durável e acompanhamento de login; PR #11 (`681d21d`) integra
  retomada do grupo por consulta. PRs #13/#14 (`eb2f0be`/`9314c72`) acrescentam acesso por senha e correção do transporte.
  A contrapartida da API foi integrada pelo PR #39 (`fbb7a85`), sem alterar a fronteira de compra da DEC-01.
- Integração de código **não prova deploy, flags ativas, volume efetivo ou ensaio Telegram/API/iFood**. A integração
  real com iFood será validada depois das tasks. Esta auditoria não executa aplicações, testes funcionais ou chamadas reais.

## Tarefas da API

| Tarefa | Prioridade / marco | Dependências |
| --- | --- | --- |
| [DEC-01 — Fechar decisões de grupo, rateio, evidência alimentar e fronteira da demo](https://github.com/Modo-Escuro/api-backend/issues/5) | P0 / M0 | — |
| [OPS-01 — Migrar vínculos para armazenamento persistente com recuperação verificada](https://github.com/Modo-Escuro/api-backend/issues/6) | P0 / M0 | — |
| [INT-01 — Auditar F7 e validar contratos reais de carrinho, envio e reconciliação](https://github.com/Modo-Escuro/api-backend/issues/7) | P0 / M0 | [DEC-01](https://github.com/Modo-Escuro/api-backend/issues/5) |
| [RANK-01 — Impedir que preferências opcionais bloqueiem configurações válidas](https://github.com/Modo-Escuro/api-backend/issues/8) | P0 / M0 | — |
| [RANK-02 — Corrigir preferências textuais e pontuar somente a configuração avaliada](https://github.com/Modo-Escuro/api-backend/issues/9) | P1 / M1 | [RANK-01](https://github.com/Modo-Escuro/api-backend/issues/8) |
| [DOM-01 — Aplicar centavos inteiros e validar limites obrigatórios antes do ranking](https://github.com/Modo-Escuro/api-backend/issues/10) | P0 / M1 | [DEC-01](https://github.com/Modo-Escuro/api-backend/issues/5) |
| [RANK-03 — Alinhar economia, rapidez e evidência ao ranking e versionar sua resposta](https://github.com/Modo-Escuro/api-backend/issues/11) | P1 / M1 | [DEC-01](https://github.com/Modo-Escuro/api-backend/issues/5), [DOM-01](https://github.com/Modo-Escuro/api-backend/issues/10), [RANK-02](https://github.com/Modo-Escuro/api-backend/issues/9) |
| [API-01 — Especificar e validar o contrato versionado de conversa, eventos e ações](https://github.com/Modo-Escuro/api-backend/issues/12) | P0 / M0 | — |
| [DATA-01 — Persistir compra, participantes, restrições e evidências com versionamento](https://github.com/Modo-Escuro/api-backend/issues/13) | P1 / M1 | [DEC-01](https://github.com/Modo-Escuro/api-backend/issues/5), [OPS-01](https://github.com/Modo-Escuro/api-backend/issues/6), [API-01](https://github.com/Modo-Escuro/api-backend/issues/12) |
| [RUN-01 — Implementar processamento durável de turnos e recuperação após falhas](https://github.com/Modo-Escuro/api-backend/issues/14) | P1 / M1 | [OPS-01](https://github.com/Modo-Escuro/api-backend/issues/6), [API-01](https://github.com/Modo-Escuro/api-backend/issues/12), [DATA-01](https://github.com/Modo-Escuro/api-backend/issues/13) |
| [AI-01 — Selecionar modelo por avaliação de conversa, custo, latência e dados](https://github.com/Modo-Escuro/api-backend/issues/15) | P1 / M1 | [DEC-01](https://github.com/Modo-Escuro/api-backend/issues/5), [API-01](https://github.com/Modo-Escuro/api-backend/issues/12) |
| [AI-02 — Implementar agente conversacional com ações estruturadas e ferramentas controladas](https://github.com/Modo-Escuro/api-backend/issues/16) | P1 / M2 | [AI-01](https://github.com/Modo-Escuro/api-backend/issues/15), [RUN-01](https://github.com/Modo-Escuro/api-backend/issues/14), [DATA-01](https://github.com/Modo-Escuro/api-backend/issues/13) |
| [GRP-01 — Compor propostas coletivas com cobertura por pessoa e custo agregado](https://github.com/Modo-Escuro/api-backend/issues/17) | P1 / M2 | [DATA-01](https://github.com/Modo-Escuro/api-backend/issues/13), [DOM-01](https://github.com/Modo-Escuro/api-backend/issues/10), [RANK-03](https://github.com/Modo-Escuro/api-backend/issues/11) |
| [CART-01 — Integrar F7 com elegibilidade por pessoa e estado durável de carrinho](https://github.com/Modo-Escuro/api-backend/issues/18) | P1 / M3 | [INT-01](https://github.com/Modo-Escuro/api-backend/issues/7), [OPS-01](https://github.com/Modo-Escuro/api-backend/issues/6), [RUN-01](https://github.com/Modo-Escuro/api-backend/issues/14), [GRP-01](https://github.com/Modo-Escuro/api-backend/issues/17) |
| [BUY-01 — Vincular aprovação humana à revisão atual e consumir autorização atomicamente](https://github.com/Modo-Escuro/api-backend/issues/19) | P0 / M3 | [CART-01](https://github.com/Modo-Escuro/api-backend/issues/18), [API-01](https://github.com/Modo-Escuro/api-backend/issues/12) |
| [BUY-02 — Implementar envio idempotente e reconciliação de resultado desconhecido](https://github.com/Modo-Escuro/api-backend/issues/20) | P0 / M3 | [INT-01](https://github.com/Modo-Escuro/api-backend/issues/7), [BUY-01](https://github.com/Modo-Escuro/api-backend/issues/19) |
| [OPS-02 — Instrumentar operação, limites, retenção e liberação gradual](https://github.com/Modo-Escuro/api-backend/issues/21) | P1 / M3 | [RUN-01](https://github.com/Modo-Escuro/api-backend/issues/14), [AI-02](https://github.com/Modo-Escuro/api-backend/issues/16), [CART-01](https://github.com/Modo-Escuro/api-backend/issues/18) |

P0 bloqueia a ação afetada; P1 compõe a entrega principal; P2 é posterior. BUY-01/02 são P0 antes do envio, mas não precedem suas dependências.

### Estado de integração confirmado

Os estados descrevem artefatos e integração, não encerramento de todos os critérios das issues nem deploy.
As prioridades/marcos e dependências da tabela de planejamento acima são preservadas.

| Incremento | Evidência Git na main | Alcance conferido / limite |
| --- | --- | --- |
| DEC-01 | `aeee828`, PR #25 (`03f3ac1`) | [D1–D10 adotadas](decisoes-conversacionais.md), não decisões ainda abertas |
| OPS-01 | PR #26 (`9aa02f2`) | `links/store.ts`, `links/backup.ts`; volume e recuperação do serviço exigem evidência operacional |
| INT-01 | PR #24 (`9de678b`) | [Auditoria](int-01-audit.md) integrada; não equivale a execução real de carrinho/envio |
| RANK-01/02 | PR #30 (`d2883f1`) | Preferência/fallback, seleção/preço e evidência textual corrigidos |
| DOM-01 | PR #31 (`8cff588`) | `money.ts`, `limits.ts`, `purchase-costs.ts`; centavos e limites locais integrados |
| RANK-03 | PR #34 (`2df4e54`), código `8d54bfc` | [Avaliação/ranking 2.0](rank-03-contrato-v2.md), D9 estrita e score diagnóstico |
| API-01 | PR #23 (`6ce3d99`) | [Conversa v1.0](conversation-api-v1.md), schemas e guards; implementação das rotas é RUN-01 |
| DATA-01 | PR #32 (`08709c7`) | Domínio, patches e expurgo D7 no SQLite da RUN-01 |
| RUN-01 | PR #27 (`30a650d`) | `turns/runtime.ts`, `turns/store.ts`, `routes/conversation.ts`; ativação explícita |
| AI-02 | PR #33 (`2b77c95`) | `agent/*`; montagem do agente acrescentada pelo #36 |
| GRP-01 | PR #37 (`8191a0f`) | `domain/group.ts`, `services/group.ts`; propostas por pessoa e sacola simulada; ranqueador de planos ainda provisório |
| AI-01 | PR #36 (`dc448f9`), consolidação do #35 | Gemini escolhido e montagem opt-in em `conversation-runtime.ts`; relatórios de seleção não comprovam D10/iFood |
| Acesso por senha | PR #39 (`fbb7a85`) | Usuários admitidos pelo adaptador, com organizador/vínculo/conversa próprios; opt-in não habilita compra |
| CART-01 / F7 | Legado do PR #4 (`cbb546c`) | Não conclui CART-01 nem autoriza carrinho real na demo D8 |
| BUY-01/02 | Schema disponível, autorização/envio não habilitados | `routes/conversation.ts` mantém `/purchase-approvals` em `ACTION_UNAVAILABLE`; aprovação simulada ainda exige contrato/implementação próprios |

**Continuações não integradas à main auditada:** `origin/feat/ops-02@4f33cf3` tem dois commits exclusivos;
`origin/codex/run-01-finalizacao@2802505` tem três commits adicionais de testes. Não confundir a infraestrutura
RUN-01 já mergeada com essa validação adicional. `origin/codex/ai-01-montagem-processador@ae101fd` está contida
na main; a mera existência da branch não indica pendência de integração.

## Organização de módulos e limites confirmados

| Área | Responsabilidade |
| --- | --- |
| routes / botAuth | Autenticação do adaptador, schemas estritos, pertencimento e versão |
| contracts / routes/conversation / turns | Contrato v1.0, eventos, snapshots e persistência SQLite RUN-01/DATA-01 |
| links / storage | Vínculos persistentes, armazenamento durável, backup e recuperação OPS-01 |
| agent / conversation-runtime | Entrada mínima, saída estruturada, política e montagem explícita AI-01/02 |
| domain | Centavos, restrições, evidência, configurações e planos por pessoa |
| services/evaluate e domain/ranking | Avaliação/ranking reutilizados e corrigidos |
| domain/group / services/group | Composição por pessoa e sacola simulada GRP-01; não certifica total completo nem aprovação |
| cart (F7 legado) | Código isolado, desligado e fora da demo somente leitura |
| approval / submission | Não habilitados; clique humano e revisão atual nunca podem ser substituídos pelo modelo |

Os arquivos da tabela foram localizados na main auditada; isto não comprova que seus opt-ins estejam ativos no
serviço. API concentra autoridade; bot apresenta e valida origem humana. LLM não recebe aprovação, token de conta ou cartão.

## Gates antes da integração e liberação

1. Preservar vínculos e SQLite antes de qualquer redeploy; OPS-01 integrada não prova volume persistente e restauração verificados no serviço atual.
2. Manter as regressões RANK-01/02/03 já integradas: alergias/`MANDATORY` prevalecem, `UNKNOWN` obrigatório não é elegível e preferência opcional não bloqueia configuração válida.
3. DOM-01/DATA-01/GRP-01 têm código integrado. Total com componente desconhecido continua desconhecido; cobertura parcial não vira grupo integralmente atendido nem orçamento aprovado.
4. DEC-01 D8 limita a demo a sacola simulada e MCP somente leitura. Manter F7 desligada; proposta de aprovação de composição na GRP-01 não é decisão adotada nem contrato implementado.
5. Aprovação humana válida permanece necessária; sacola simulada não significa pedido enviado. Modelo, login, senha de acesso ou score não substituem autorização.
6. Validar a integração real com iFood depois das tasks e registrar separadamente versões implantadas, configuração efetiva e ensaios ponta a ponta. Relatórios de modelo, mocks, health e merges não comprovam a jornada ou as metas D10.

No protocolo externo, preservar listAddresses, getItem e listagens antes das escolhas; userId nunca é enviado. Não substituir componente de custo ausente por zero. Login não aprova compra.

## Documentos existentes e precedência

docs/requirements.md registra o recorte anterior de recomendação. O plano atual amplia o objetivo para conversa e fechamento aprovado; isso não remove as travas de escrita vigentes. Proposta de escopo não é autorização de compra.

A StRS v0.2 e o baseline permanecem preservados. D1–D10 foram adotadas em DEC-01; questões fora desse recorte
continuam separadas. Não ignorar alergia/`MANDATORY`, promover `UNKNOWN` por score ou converter desconhecido em zero.
Dinheiro no domínio já está em centavos inteiros pela DOM-01, não é migração futura.

Contratos distintos: [bot-api.md](bot-api.md) para vínculo/avaliação, [conversation-api-v1.md](conversation-api-v1.md)
para conversa **v1.0**, e [RANK-03](rank-03-contrato-v2.md) para avaliação/ranking **2.0**. A
[proposta v0 do bot](https://github.com/Modo-Escuro/telegram-bot/blob/main/docs/contrato-conversa-proposto.md) é histórica,
não alternativa normativa. A introdução da especificação v1 conserva o alcance original da API-01; para a
disponibilidade atual em código, conferir RUN-01/DATA-01 e a montagem AI-01 do commit auditado, sem mudar o fio.
Não inferir deploy a partir desses documentos nem substituir configuração remota por defaults locais.

## Verificação por incremento

Registrar checks realmente executados e commit. Números de testes em relatórios anteriores são evidências
históricas daquelas revisões, não resultados atuais. Esta sincronização é documental: confere Git, código e links,
sem repetir suítes, chamar provedores, iniciar serviços ou modificar configurações. O fechamento de issue não foi
usado como prova de integração; não se atesta deploy/validação online. `git diff --check` verifica a edição documental.

Review de código deve verificar restrições antes do ranking, autorização humana, idempotência/estado desconhecido, isolamento por vínculo, ausência de segredos no modelo/logs e instruções externas tratadas como dados.
