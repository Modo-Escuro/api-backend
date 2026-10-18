# AI-02 — Agente conversacional

Issue: [#16 AI-02](https://github.com/Modo-Escuro/api-backend/issues/16) · Base: [DATA-01](data-01-compra.md), [RUN-01](runtime-turnos.md), [conversa v1](conversation-api-v1.md), [DEC-01](decisoes-conversacionais.md)

O agente interpreta a mensagem do organizador e propõe **ações num vocabulário fechado**. O servidor valida cada ação
contra a compra persistida, aplica só o que o domínio aceita e monta a resposta a partir de fatos gravados. O modelo
não aprova compra, não confirma nada em nome do usuário, não escolhe vínculo e não recebe nem devolve IDs de conta.

## Fluxo

```
mensagem (TEXT) ─► RUN-01 aceita (202, idempotente) ─► worker
  └─► processor.ts
        1. linkOf(organizador autenticado) ─► linkId real (OPS-01)
        2. buildModelInput: contexto mínimo por allowlist + mensagem (dado não confiável)
        3. model.propose(...) com prazo (20 s; corta mesmo se o provedor ignorar o sinal)
        4. AgentProposalSchema (estrito) ─► saída inválida ⇒ UNAVAILABLE
        5. planActions: ação → operação de domínio, validada uma a uma com previewDomain
        6. renderSnapshot: GROUP + resumo + pendências (só servidor)
  └─► DATA-01/RUN-01 finish: recalcula o domínio, confere GROUP, grava tudo numa transação
```

## Arquivos

| Arquivo | Papel |
| --- | --- |
| `src/server/agent/model.ts` | Interface de provedor (`ConversationModel`), entrada mínima (`AgentModelInput`) e schema estrito da proposta |
| `src/server/agent/policy.ts` | Contexto por allowlist, conversão ação → operação, pendências e "perguntar só o que falta" |
| `src/server/agent/render.ts` | Snapshot de resposta montado pelo servidor |
| `src/server/agent/processor.ts` | `createAgentProcessor({ model, linkOf })` → `TurnProcessor` |
| `src/server/agent/mock-model.ts` | Modelo determinístico de regras (testes e ensaio local; não instalado em produção) |
| `src/server/turns/runtime.ts` | `TurnContext.principal`: identidade autenticada, para consultar o vínculo do organizador |

## Vocabulário do modelo

`ADD_PARTICIPANT`, `RENAME_PARTICIPANT`, `REMOVE_PARTICIPANT`, `ADD_RESTRICTION`, `SET_NO_RESTRICTIONS`,
`REMOVE_RESTRICTION`, `SET_LIMIT`, `SET_NO_LIMIT`, `SET_PRIORITY`, `ASK_CLARIFICATION`, `REQUEST_ORDER`,
`CLOSE_PURCHASE`, `SUGGEST_PROPOSALS` (termo de busca), `SELECT_PROPOSAL` (posição 1–4, nunca ID) e `CLEAR_BAG` (GRP-01). Participantes são indicados por `ref` (emitida pelo servidor no contexto) ou por nome.
Qualquer campo fora do schema (ex.: `humanConfirmed`, `linkId`, `merchantId`, aprovação) invalida a proposta inteira.
Não há ação de loja, endereço, item, carrinho, aprovação, confirmação humana nem ferramenta MCP nesta etapa.

## Política do servidor

| Situação | Comportamento |
| --- | --- |
| Várias informações na mesma mensagem | Todas aplicadas; pendências só para o que falta (restrições não informadas, orçamento, prioridade, perguntas abertas) |
| Nome ambíguo ou desconhecido | Pergunta; nada é aplicado àquela pessoa; nenhuma pessoa é criada por engano |
| Ação inválida no meio | Vira pendência; as demais seguem (validação incremental com `previewDomain`) |
| Alergia proposta como preferência | Registrada como obrigatória |
| Remover alergia/restrição, "não tem restrição" com restrição obrigatória, tirar/rebaixar teto rígido, remover quem tem restrição obrigatória | Pendência "precisa de confirmação explícita"; nada muda (o agente nunca marca `humanConfirmed`) |
| Valor sem indicação de teto máximo × referência | Pergunta; o teto fica `UNCLEAR` (nunca "sem teto") |
| "Sem teto" proposto pelo modelo | Só é aplicado se a **própria mensagem do usuário** contiver uma declaração explícita ("sem teto", "não temos limite", "qualquer valor"...); senão vira pergunta. Teto rígido continua exigindo confirmação humana |
| "Pode pedir" | Explica que a revisão/aprovação por botão é necessária e ainda não existe nesta etapa; nenhuma aprovação, `OUTCOME` ou `REVIEW` |
| Encerrar/cancelar a compra | Pendência: apaga dados (D7) e exige confirmação humana |
| Recusa do modelo | Todas as ações da proposta são descartadas; orientação sobre o que o agente pode registrar |
| Pergunta de esclarecimento | Texto escolhido pelo servidor a partir de (alvo, campo); o texto do modelo é descartado e nunca é exibido, gravado ou reenviado ao modelo |
| Remover e recriar a mesma pessoa no turno | Recusado (não apaga teto rígido nem pergunta pendente) |
| Renomear para nome já usado | Recusado com pendência |
| Teto acima de R$ 100 mil | Tratado como implausível: pergunta, nada muda |

Respostas: bloco `GROUP` gerado do estado (conferido no `finish`), resumo do que mudou e orçamento, todos
`source: SERVER`. Texto livre do modelo não é exibido. Fase `COLLECTING`; `humanApproval` sempre `null`.

## Falhas

| Falha | Resultado |
| --- | --- |
| Provedor fora, exceção, timeout | Operação `FAILED` com `UNAVAILABLE` (`recovery: POLL_OPERATION`); estado e versão intactos; reenviar funciona |
| Saída fora do schema | Idem; nada aplicado |
| Consulta ao vínculo falha ou trava | Idem (não segue sem saber a conta); vínculo e modelo dividem o mesmo prazo do turno, e travamento não derruba o runtime |
| Conflito de versão | RUN-01 (`STALE_VERSION`) |

Logs do agente: só códigos (`MODEL_TIMEOUT`, `MODEL_OUTPUT_INVALID`, ...), nunca mensagem, nomes ou saída do modelo.

## Integração e dependências

- **Produção hoje:** `index.ts` cria o runtime sem processador; com `CONVERSATION_RUNTIME_ENABLED=true`, eventos novos recebem 503 `UNAVAILABLE` e nada é gravado (teste em `test/agent/processor.test.ts`). O modelo determinístico não é importado fora de testes.
- **AI-01 (#15):** escolhe e implementa o provedor real de `ConversationModel` e as metas da D10. Até lá, o runtime
  de produção continua sem processador (eventos novos → 503), e o modelo determinístico só roda em testes.
  Instalação: `new TurnRuntime(store, { processor: createAgentProcessor({ model, linkOf: async (org) => (await links.status(org)).linkId }) })`.
- **BUY-01 (#19):** confirmação humana por botão (para remoções/encerramento) e revisão/aprovação fictícia.
- **GRP-01 (#17):** propostas, consumo por participante e rateio (DOM-01) — fora deste agente.
- **DOM-01:** ao integrar rateio, teto `UNCLEAR` deve bloquear (ver auditoria DATA-01 × DOM-01).
- O contrato v1 só aceita eventos `TEXT`; ações por botão (`CALLBACK`) dependem de evolução da RUN-01/API-01.

## Limitações

- Sem histórico de mensagens: o contexto é o estado estruturado da compra mais a mensagem atual.
- Sem ferramentas MCP (busca/detalhe) nesta etapa; loja e endereço não são definidos pelo agente.
- Nome do participante é dado do usuário e volta ao modelo no contexto; ele só pode produzir ações do vocabulário.
