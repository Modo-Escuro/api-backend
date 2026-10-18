# DATA-01 — Compra, participantes, restrições e evidências

Issue: [#13 DATA-01](https://github.com/Modo-Escuro/api-backend/issues/13) · Decisões: [DEC-01](decisoes-conversacionais.md) · Runtime: [RUN-01](runtime-turnos.md) · Contrato: [conversa v1](conversation-api-v1.md)

O estado local da compra fica **no mesmo SQLite da RUN-01** (schema v2) e muda **só por operações tipadas**,
gravadas na mesma transação do snapshot e da operação. A DATA-01 não sincroniza carrinho por si só. A main remota já integra montagem AI-01/AI-02; novos eventos dependem dos opt-ins e configuração explícitos. CART-01 deve reutilizar este domínio para preparar o carrinho real confirmado.

## Onde está cada coisa

| Arquivo | Conteúdo |
| --- | --- |
| `src/server/domain/money.ts` (DOM-01) | Fonte única de `Cents` e da aritmética/rateio em centavos; a DATA-01 só importa o tipo |
| `src/server/domain/purchase.ts` | `MoneyLimit { amountCents, kind: MANDATORY \| PREFERENCE }`, `PurchaseState`, as 13 operações, `applyPatch`, `applyLinkChange`, `nextPurchase`, evidência (função pura, sem I/O) |
| `src/server/turns/store.ts` | Migração v2, compra no `claim`, gravação atômica no `finish`, `purge()` da D7 |
| `src/server/turns/runtime.ts` | `TurnContext.purchase`, `TurnContext.previewDomain()`, `TurnResult.domain`, `purge` no tick |

Fronteira com a DOM-01 (#10): conversões de preço, rateio (D3) e verificação de limites (D4) estão em
`money.ts` e `purchase-costs.ts` da DOM-01, que recebem `participantId` e tetos em centavos; a DATA-01 fornece esses
dados a partir de `PurchaseState` (`participants[].limit`, `groupLimit`) e não reimplementa cálculos.

## Modelo

- **Uma compra ativa por conversa privada do organizador** (D2): o escopo da RUN-01
  (`TELEGRAM/bot/organizador/conversa`) isola cada organizador; leituras e escritas filtram por ele.
- **Participantes declarados pelo organizador** (D1): sem conta; nome e dados declarados pelo organizador. Máximo configurável
  (`TurnLimits.maxParticipants`, padrão 20; o contrato API-01 aceita até 100).
- **Textos** (nomes, perguntas) recusam caracteres de controle, formatação invisível (zero-width, bidi) e surrogate isolado.
- **Estados distintos** para cada campo declarável: `NOT_ASKED`, `UNCLEAR` (pergunta pendente), `NONE`
  ("nenhuma"/"sem teto" explícito) e `DECLARED`.
- **Restrições** reutilizam `RestrictionKey` (`domain/constraints.ts`). Alergia é sempre `MANDATORY`.
- **Limites** individuais e coletivo em centavos, com `kind` rígido ou flexível (D5).
- **Proveniência**: cada dado tem `origin.eventId`; cada alteração gera uma linha em `purchase_changes` com o mesmo
  `changeId` de `Operation.changes[]`, o `eventId` aceito, a origem do canal (`messageId`/`callbackQueryId`, nunca o
  texto), as versões base e resultante, a causa e as operações aplicadas.
- **IDs determinísticos**: compra, participante, restrição e esclarecimento derivam de (escopo, `eventId`, posição
  da operação). O processador pré-visualiza exatamente o estado que será gravado, e o armazenamento recalcula esse
  estado a partir do persistido — um estado pronto vindo de fora nunca é aceito.

## Operações

Um patch tem de 1 a 50 operações e é **atômico**: qualquer operação inválida rejeita tudo (`INVALID_REQUEST` na
operação, nada gravado).

| Operação | Regras |
| --- | --- |
| `ADD_PARTICIPANT { displayName }` | ID gerado pelo servidor; respeita o máximo |
| `RENAME_PARTICIPANT { participantId, displayName }` | ID precisa existir na compra deste escopo |
| `REMOVE_PARTICIPANT { participantId, humanConfirmed? }` | Exige `humanConfirmed: true` se o participante tiver restrição obrigatória, pergunta de restrição pendente ou teto MANDATORY (remover e recriar não apaga nada disso); remove também os esclarecimentos sobre ele |
| `SET_RESTRICTIONS { participantId, value: RestrictionKey[] \| 'NONE', humanConfirmed? }` | Mantém o ID das restrições que continuam; tirar ou rebaixar rígida exige `humanConfirmed: true` |
| `ADD_RESTRICTION { participantId, key }` | Preferência pode virar rígida; rígida não vira preferência |
| `REMOVE_RESTRICTION { participantId, restrictionId, humanConfirmed: true }` | Confirmação humana sempre |
| `SET_LIMIT { target: participantId \| 'GROUP', value: MoneyLimit \| 'NONE', humanConfirmed? }` | Não toca participantes nem restrições; mudar o valor de teto rígido é livre, tirá-lo ou torná-lo flexível exige `humanConfirmed: true` |
| `MARK_UNCLEAR { target, field, question }` | Ambiguidade vira pergunta. Valor já declarado (restrições, teto, loja, endereço, prioridade) continua valendo; só "não perguntado" ou "nenhum" viram `UNCLEAR` |
| `RESOLVE_CLARIFICATION { clarificationId }` | Campo ainda ambíguo volta a `NOT_ASKED`; nada é inventado |
| `SET_PRIORITY { value: ECONOMY \| SPEED }` | D9 |
| `SET_MERCHANT { merchantId }` / `SET_ADDRESS { addressId }` | ID precisa vir de resposta MCP (o processador valida) |
| `END { reason: CLOSED \| CANCELLED }` | Exige compra ativa antes do patch; encerra e dispara a exclusão D7 na mesma transação |
| `SET_PROPOSALS { proposals }` / `SELECT_PROPOSAL { proposalId }` / `CLEAR_BAG` | GRP-01: propostas (apagadas por qualquer outra alteração) e composição local a sincronizar pela CART-01; ver [grp-01-propostas](grp-01-propostas.md) |

`humanConfirmed` só pode ser preenchido pelo processador quando o organizador declarou a mudança explicitamente.

Vínculo (`TurnResult.domain.linkId`): a primeira associação e cada troca de conta limpam loja, endereço e evidência
que não possam ser atribuídos ao vínculo atual; participantes, restrições, limites e prioridade são preservados.
Uma compra criada no próprio turno já sob o vínculo mantém o que o turno definiu. Toda associação/troca gera uma
linha `DERIVED` (`LINK_ASSOCIATED` ou `LINK_CHANGED`) com `caused_by` = `changeId` da operação — nenhuma mensagem
humana é fabricada. Operações de domínio de um turno são `USER` por padrão (vêm de mensagem humana aceita).

**Snapshot × compra:** no `finish`, um bloco `GROUP` precisa refletir a compra gravada: um bloco só, exatamente os
mesmos participantes (`participantRef` = `participantId`, mesmo nome) e `budgetCents` igual ao teto coletivo
declarado (ou `null`). `GROUP` sem compra ativa é recusado. O texto das condições não é verificável e fica a cargo de
quem monta o snapshot.

## Evidência de restaurante (D6)

`VERIFIED_EVIDENCE_CHANNELS` está vazio: nenhum canal verificado existe na demo. `recordEvidence` sempre rejeita
(`EVIDENCE_SOURCE_UNVERIFIED`) e um estado com evidência de canal não aprovado não passa na validação. `findEvidence`
só aceita a combinação exata loja + item + opções + restrição dentro da validade (outro item, variante ou confirmação
vencida não libera — CA07).

## Exclusão D7

| Gatilho | O que acontece |
| --- | --- |
| `END` | Na mesma transação: compra e `purchase_changes` apagadas; operações anteriores ficam com snapshot neutro e sem `changes`; origem dos eventos substituída por `"PURGED"`. O snapshot de encerramento é **gerado pelo servidor** (só "Compra encerrada/cancelada", `pending` vazio): nada do processador é guardado. Ele e a operação de encerramento expiram pelo gatilho de 24 h. |
| 24 h sem evento aceito | `purge()` (tick a cada 60 s) faz o mesmo e troca o snapshot pelo inicial com versão incrementada, para que nenhum evento antigo passe na checagem de versão. Replay não conta como atividade. Cada conversa roda num `SAVEPOINT`: estado ilegível em uma não impede as demais (`{ purged, failed }`). |
| Migração v1 → v2 | Conversas existentes recebem `last_activity_at` = instante da migração: uma janela única de 24 h, sem tratar dados antigos como atividade recente nem apagá-los de surpresa logo após o deploy. |
| Trabalho em andamento ou resultado desconhecido | Conversa não é expurgada até terminar. |

Fica só a deduplicação mínima: chave e hash dos eventos e o status das operações, para replay não reprocessar.
O vínculo OAuth (OPS-01) é outro armazenamento e não é afetado.

## Para a AI-02 (processador)

```ts
const processor: TurnProcessor = async (ctx) => {
  const change: DomainChange = { ops: [{ op: 'ADD_PARTICIPANT', displayName: 'Ana' }], linkId };
  const next = ctx.previewDomain(change);             // mesmos IDs que o commit vai gravar
  return { snapshot: montarSnapshot(ctx.snapshot, next), completeness: 'COMPLETE', paths: ['PARTICIPANTS'], cause: 'USER', domain: change };
};
```

- Nunca repassar JSON do modelo como operação sem validar intenção, IDs e `humanConfirmed` no código do servidor.
  `humanConfirmed` só quando o organizador declarou a mudança explicitamente; hoje é um booleano do processador
  (vincular a um evento de botão consumido depende de suporte a ações no contrato e na AI-02).
- Enviar `linkId` do vínculo realmente usado no turno (OPS-01); sem ele, troca de conta não é detectada.
- Montar o bloco `GROUP` a partir de `previewDomain()` (o `finish` recusa divergência).
- `merchantId`/`addressId` só de respostas MCP do mesmo vínculo.
- Snapshot de encerramento sem blocos de dados da compra.

## Falhas isoladas

Domínio ou snapshot ilegível em uma conversa falha só a operação dela (`INTERNAL`) no `claim`; as demais conversas
continuam sendo processadas e o runtime não é marcado como indisponível. Falha do expurgo também não derruba a fila.

## Limitações

- Sem rotas novas: o estado é lido pelo processador (`TurnContext.purchase`) e exposto ao bot só pelo snapshot.
- Logs técnicos e backups seguem OPS-01/OPS-02; o banco em si não tem criptografia em repouso (volume privado, 700/600).
- Itens por participante, propostas e cobertura (GRP-01) e cálculo de rateio (DOM-01) não fazem parte desta entrega.
