# Plano de execução da API

Planejamento de 18/10/2026. [Plano integrado](https://github.com/Modo-Escuro/telegram-bot/blob/codex/plano-conversacional/docs/plano-conversacional.md) · [Épico](https://github.com/Modo-Escuro/telegram-bot/issues/6) · [Backlog](https://github.com/Modo-Escuro/telegram-bot/blob/codex/plano-conversacional/docs/backlog-conversacional.md).

## Estado e trabalho reaproveitável

main 686300d implementa vínculo e avaliação. branchBruna 8393615 acrescenta ranking; [revisão detalhada](reviews/branchBruna-8393615.md) identifica correções. feat/f7-cart-checkout b08957d (PR #4) contém carrinho com outputs provisórios, estado em memória e checkout desabilitado. Documentação F7 foi consultada; a auditoria e validação externas pertencem a INT-01.

As três branches não formam uma entrega integrada. Nenhum novo endpoint, armazenamento, modelo ou envio é implementado por esta atualização documental. Issues #1–#3 estão fechadas e permanecem histórico.

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

## Organização de módulos proposta

| Área | Responsabilidade |
| --- | --- |
| routes / botAuth | Autenticação do adaptador, schemas estritos, pertencimento e versão |
| conversation (novo, nome a fechar) | Eventos, tarefas, contexto e patches validados |
| storage (novo, nome a fechar) | Vínculos, estado transacional, intenções, revisões, recuperação e retenção |
| agent (novo, nome a fechar) | Modelo com entrada mínima, saída estruturada e ferramentas internas limitadas |
| domain | Centavos, restrições, evidência, configurações e planos por pessoa |
| services/evaluate e domain/ranking | Avaliação/ranking reutilizados e corrigidos |
| cart (F7) | Mutações com referências verificadas e persistência, após validação de outputs |
| approval / submission (a integrar) | Clique humano, revisão atual, autorização consumida atomicamente e reconciliação |

Os nomes novos são proposta, não estrutura já existente. API concentra autoridade; bot apresenta e valida origem humana. LLM não recebe aprovação, token de conta ou cartão.

## Gates antes da integração e liberação

1. OPS-01 antes de redeploy da API: preservar .ifood-links existente, validar cópia e recuperação.
2. Corrigir RANK-01 antes de afirmar que preferências não bloqueiam. Integrar Bruna com RANK-02/03 e compatibilidade das categorias.
3. Domínio por pessoa e valores em centavos antes de declarar orçamento e cobertura coletiva.
4. Auditar F7, validar saídas e persistir intenções antes de habilitar preparação de sacola.
5. Aprovação válida, contrato remoto e reconciliação antes de qualquer envio. Flag de carrinho não habilita checkout.
6. QA-01 prova resultado final do evento; simulação e health não bastam.

No protocolo externo, preservar listAddresses, getItem e listagens antes das escolhas; userId nunca é enviado. Não substituir componente de custo ausente por zero. Login não aprova compra.

## Documentos existentes e precedência

docs/requirements.md registra o recorte anterior de recomendação. O plano atual amplia o objetivo para conversa e fechamento aprovado; isso não remove as travas de escrita vigentes. Proposta de escopo não é autorização de compra.

A StRS e invariantes preservados são a referência do produto. Qualquer trecho antigo que proponha ignorar restrição obrigatória ou promover UNKNOWN por score não deve guiar nova implementação. Dinheiro interno decimal é estado atual a migrar em DOM-01, não regra de destino.

docs/bot-api.md descreve o contrato de login existente. O contrato novo de conversa continua [proposto](https://github.com/Modo-Escuro/telegram-bot/blob/codex/plano-conversacional/docs/contrato-conversa-proposto.md). Callback localhost é configuração de desenvolvimento; o ensaio online usou HTTPS público. Não substituir variáveis Railway por defaults locais.

## Verificação por incremento

Registrar checks realmente executados e commit. API: typecheck/lint/test/build conforme mudança; tests sem compras reais. Revisão Bruna: 237/239 no Windows com duas asserções POSIX; F7 documenta ajuste que precisa ser revisado na integração. Não omitir testes de storage para obter verde.

Review de código deve verificar restrições antes do ranking, autorização humana, idempotência/estado desconhecido, isolamento por vínculo, ausência de segredos no modelo/logs e instruções externas tratadas como dados.
