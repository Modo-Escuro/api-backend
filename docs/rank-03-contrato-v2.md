# RANK-03 — Ordenação D9 e resposta de avaliação 2.0

Issue [#11](https://github.com/Modo-Escuro/api-backend/issues/11). **Implementação integrada à main** pelo
[PR #34](https://github.com/Modo-Escuro/api-backend/pull/34): código `8d54bfcfca13f99ff05f23c6abe93f187ac66216`,
merge `2df4e54177ad31bdb1502883ac763f9d1a9485a7`. Esse estado foi confirmado por ancestralidade e leitura de código,
não pelo estado da issue. Integração Git não comprova deploy nem validação real com iFood.

## Estado conferido na auditoria documental — 18/10/2026

- Backend remoto: `origin/main@dc448f9e117e05192004514a639c3ed5acd1098a`, contendo o merge #34. Conferidos
  `src/server/domain/ranking.ts` (`RANKING_CONTRACT_VERSION = '2.0'`, D9 e políticas), `contracts/evaluate.ts`,
  `services/evaluate.ts`, `services/evaluate-view.ts` e `services/cents.ts`.
- Checkout local: `branchBruna@2df4e54`, já com o merge #34; referência remota `origin/branchBruna@8d54bfc`.
  A main remota contém incrementos posteriores de GRP-01/AI-01/acesso. Não foram trazidos para o checkout
  nesta auditoria; [estado das integrações](plano-conversacional.md).
- A resposta de **avaliação/ranking é 2.0**; o [contrato de conversa é v1.0](conversation-api-v1.md).
  São interfaces distintas, sem alteração de schemas, formatos ou regras por esta sincronização.
- Esta atualização só corrige documentação. Não executa testes funcionais, aplicações, deploy ou chamadas de
  modelo/iFood; resultados anteriores abaixo permanecem identificados como históricos.

## Diagnóstico original e dependências — registro histórico da implementação

Estado inicial: `branchBruna@d2883f1`, sem alterações rastreadas; `.agents/pipeline/` já existia como não rastreado.
Foram executados `git branch --show-current`, `git status --short`, `git log -5 --oneline` e `git remote -v`.
Após `git fetch origin`, `origin/main` também era `d2883f1` (divergência `0/0`). Nenhum checkout/merge/rebase
foi executado durante aquela implementação local. Esse registro não é o estado atual: depois houve o commit
`8d54bfc` e o merge #34 (`2df4e54`), confirmados acima. Esta auditoria não cria novos commits ou integrações.

- **DEC-01 presente:** documento e commit `aeee828` registram adoção humana em 18/10/2026. D9 escolhe
  ordenação **estrita**, e não score ponderado. D3–D6 preservam centavos, desconhecidos e limites rígidos.
- **DOM-01 realmente integrada à branchBruna:** implementação `939f801`, merge do PR #31 `8cff588`,
  presentes no histórico. `money.ts`, normalização, preço, limites locais e projeção HTTP operam em centavos.
  `services/cents.ts` só renomeia/valida, sem multiplicação adicional. Não foi feita outra migração monetária.
- **RANK-01/02 presentes:** PR #30 integrado por `d2883f1`, incluindo configuração preferida separada do mínimo,
  alternativas com quantidade original, orçamento UNKNOWN conservador, evidência da seleção e negações.
- Issues #11, #10, #5 e #9, [DEC-01](decisoes-conversacionais.md), [DOM-01](dom-01-centavos-limites.md),
  plano conversacional, contrato HTTP, frontend e testes foram consultados.

## Economia e rapidez

Somente candidatos com elegibilidade confirmada entram na ordenação; score não libera restrições.

| Prioridade declarada | Chave 1 | Chave 2 | Chave 3 | Desempate |
| --- | --- | --- | --- | --- |
| `ECONOMY` | Total completo estimado, crescente | Prazo estimado, crescente | Preferências atendidas, decrescente | `merchantId`, `itemId`, comparação lexical de IDs |
| `SPEED` | Prazo estimado, crescente | Total completo estimado, crescente | Preferências atendidas, decrescente | mesmos IDs |

Desconhecido fica depois de todos os conhecidos **naquela chave**, conforme D9. Se ambos desconhecidos,
passa-se à próxima chave, com a limitação explícita. Sem prioridade, ou com `PREFERENCES` legado, retorna
`PRIORITY_REQUIRED` e uma pergunta ECONOMY/SPEED, sem recomendação ordenada. Não se infere a resposta.

### Custo

- Fonte: preço da configuração efetivamente avaliada (`selected ?? minimumConfigurable`), já com quantidade,
  adicionais e promoções aplicadas. Não usar o mínimo de outra configuração para pontuar a selecionada.
- A chave é um total completo estimado de valor único, em centavos, com serviço conhecido e entrega conhecida.
  O catálogo nunca gera cotação confirmada; `confirmation.status` continua `NOT_CONFIRMED` e total confirmado nulo.
- Subtotal de itens + entrega, faixa aberta/fechada ou ausência de componente relevante não viram valor único.
  Não usar ponto médio, mínimo de faixa, frete/serviço zero inferido ou descontos inventados.
- Exemplo A/B: com custos completos **sintéticos** e serviço explicitamente zero, A = 1000 + 2000 = 3000,
  B = 2000 + 0 = 2000. ECONOMY põe B primeiro e explica os mesmos 2000/3000 usados na comparação.
- O tipo de serviço admite `KNOWN` com centavos explícitos para representar uma estimativa completa.
  **Não foi criado um caminho de catálogo que preencha esse valor:** `computePrice` continua retornando
  serviço `UNKNOWN`. O helper de teste completo é explicitamente sintético, não evidência de capacidade MCP.
- Com o catálogo atual, ambos os totais A/B ficam desconhecidos quando falta serviço. Não é possível afirmar
  qual total completo é menor só pelos subtotais: D9 aplica as próximas chaves e mostra a lacuna. Comparar
  subtotais como política alternativa exigiria decisão explícita; não foi introduzido esse fallback.

### Prazo

- `estimatedMinutes` é o **máximo observado** do intervalo de entrega, também utilizado por DOM-01 nos
  limites de prazo. Não há ponto médio inventado; mínimo sozinho, valor inválido ou intervalo incoerente
  ficam desconhecidos. Máximo conhecido com mínimo ausente é utilizável, com limitação explícita.
- DELIVERY pontua só esse prazo. Frete não reduz nota de rapidez; entra no custo completo.
- SPEED preserva o aumento legado do peso diagnóstico DELIVERY de 0.1 para 0.2. A chave estrita de prazo
  prevalece sobre score; não basta dobrar um peso para cumprir a prioridade aprovada.
- `refinements` obrigatórios já bloqueiam FAIL/UNKNOWN na elegibilidade. `softLimits` são alvos flexíveis
  usados em CONTEXT e na contagem de preferências atendidas; não filtram MCP nem tornam alguém inelegível.

### Preferências e evidências

O terceiro desempate conta sinais explicitamente atendidos e limites flexíveis PASS, não a média somente
dos sinais restantes. Remover menção desfavorável não aumenta esse contador. Falta de evidência não comprova
ausência de ingrediente; texto heurístico serve apenas para preferência. Evidência usa item-base + opções
selecionadas, excluindo nome da loja e adicionais não selecionados. Negação não vira presença.

## Cobertura e score diagnóstico

Pesos configurados preservados: PREFERENCES 0.35, CONTEXT 0.25, PRICE 0.2, DELIVERY 0.1, RATING 0.1.
ECONOMY dobra PRICE para 0.4; SPEED dobra DELIVERY para 0.2. Esses valores não são probabilidades.

Para o diagnóstico, cada critério informa `weight`, `effectiveWeight`, `status`, `score`, `contribution`,
`basis`, `reasons` e `dataLimitations`. `NO_DATA` tem score/contribuição nulos e peso efetivo zero.

```
configuredWeight = soma dos pesos após o aumento da prioridade
scoredWeight = soma dos pesos de critérios SCORED
weightedFraction = scoredWeight / configuredWeight
effectiveWeight[critério SCORED] = weight / scoredWeight
score = soma das contribuições arredondadas a 4 casas (score null se scoredWeight = 0)
```

`coverage` traz `scoredCriteria`, `noDataCriteria`, `scoredCount`, `totalCount`, `configuredWeight`,
`scoredWeight`, `weightedFraction`. Mede cobertura **de critérios com algum sinal avaliável**, não completude
de todos os campos, certeza, qualidade nem segurança. Observações parciais permanecem nas limitações.

Exemplo com ECONOMY e só prazo/rating observados: peso configurado 1.2, observado 0.2, fração 0.1667;
DELIVERY e RATING recebem peso efetivo 0.5 cada. Os demais ficam NO_DATA.

**Ponto sem aprovação para uso na ordenação:** redistribuir pesos pode elevar score diagnóstico ao remover
uma nota ruim. DEC-01 escolheu chaves estritas; não se inventou penalidade, imputação ou nova política de
score para a ordem. A redistribuição legada fica isolada no diagnóstico, com cobertura/limitações visíveis,
e score não participa sequer do desempate. Remover evidência ruim não melhora silenciosamente a posição.

## Classificação e precedência

1. Sem blockers: ELIGIBLE; a defesa do ranking exige também `evaluation.eligible`.
2. Incompatibilidade confirmada: BLOCKED, mesmo acompanhada de falta de dados.
3. Código desconhecido: BLOCKED como fallback conservador, mesmo junto de NOT_DETAILED. Isso não afirma
   uma incompatibilidade alimentar comprovada; o código e a mensagem originais permanecem no diagnóstico.
4. Só blockers reconhecidos de informação insuficiente: NEEDS_VERIFICATION (não recomendado).

As pendências de DOM-01 foram reconhecidas explicitamente: disponibilidade/configuração/preço não verificáveis
e limites suportados não verificáveis. Um novo código desconhecido não é classificado por semelhança de nome.
Cada bucket preserva todos os `blockers`, inclusive motivos mistos, e `summary.blockerCounts` os contabiliza.
Zero/uma opção elegível retorna somente zero/uma recomendação, sem completar a lista com não elegíveis.

## Contrato HTTP antes/depois

O endpoint continua `POST /api/evaluate`, com a mesma autenticação. A versão 2.0 descreve respostas de sucesso;
erros de autenticação/validação existentes e o contrato conversacional 1.0 não mudam.

| Aspecto | Antes, sem versão explícita | Agora, 2.0 |
| --- | --- | --- |
| Identificação | ausente | `contractVersion: "2.0"` no topo e em `ranking` |
| Ordem | score ponderado desc, busca como desempate | D9 estrita; IDs no desempate; score diagnóstico |
| Prioridade ausente / PREFERENCES | score implícito | `status: PRIORITY_REQUIRED`, pergunta, recommendations vazio |
| Economia | preço unitário; ponto médio/limite de faixa | total completo de valor único; sem ele, chave desconhecida |
| Rapidez | média de ETA e frete | máximo observado do prazo, sem frete |
| Categorias | inferidas pelo nome do bucket | `category` explícita em cada candidato; todos os buckets preservados |
| Motivos | blockers e mensagens | todos preservados, incluindo desconhecidos e motivos de verificação |
| Score | podia aparentar confiança e decidir ordem | `scoreInterpretation: RELATIVE_DIAGNOSTIC_NOT_PROBABILITY` |
| Dados ausentes | redistribuição sem cobertura estruturada | política explícita + cobertura + pesos efetivos + limitações |
| Valores | centavos de DOM-01 | continuam centavos; `orderingKeys.estimatedTotalCents` também em centavos |

Schema Zod do recorte contratual: `src/server/contracts/evaluate.ts`. Campos de catálogo/diagnóstico fora do
recorte não são descartados pelo schema. `services/evaluate-view.ts` projeta a versão e os dados;
`services/cents.ts` preserva centavos sem reconversão. Não se expõe a alternativa do domínio como configuração
aplicada no HTTP: ela continua somente como sugestão explícita nos motivos, sem bônus na seleção original.

Recorte ilustrativo de uma única opção com total desconhecido (não é payload completo):

```json
{
  "contractVersion": "2.0",
  "money": { "currency": "BRL", "unit": "CENTS" },
  "ranking": {
    "contractVersion": "2.0", "status": "RANKED", "priority": "ECONOMY",
    "orderingPolicy": "DEC_01_D9",
    "scoreInterpretation": "RELATIVE_DIAGNOSTIC_NOT_PROBABILITY",
    "missingDataPolicy": "UNKNOWN_LAST_SCORE_DIAGNOSTIC_ONLY", "clarification": null
  },
  "recommendations": [{
    "category": "ELIGIBLE", "blockers": [],
    "ranking": {
      "rank": 1, "score": 0.5,
      "orderingKeys": { "estimatedTotalCents": null, "estimatedMinutes": 40, "preferencesSatisfied": null },
      "coverage": {
        "scoredCriteria": ["DELIVERY", "RATING"], "noDataCriteria": ["PREFERENCES", "CONTEXT", "PRICE"],
        "scoredCount": 2, "totalCount": 5, "configuredWeight": 1.2, "scoredWeight": 0.2, "weightedFraction": 0.1667
      }
    }
  }]
}
```

## Consumidores inspecionados e adaptação

- **Frontend deste repositório:** `src/web/App.tsx` só usa diagnóstico (`/api/diagnostics/search`) e login;
  não consome `/api/evaluate` nem apresenta score. Nenhuma mudança incompatível nesses endpoints.
- **Testes/pipeline locais:** adaptados para declarar ECONOMY quando testam recomendações, validar D9,
  cobertura e chaves. Casos de #8/#9 preservam suas verificações; novos testes verificam ausência de prioridade.
- **Bot no diagnóstico original:** `Modo-Escuro/telegram-bot/main@e280807` tinha login, sem cliente de conversa.
  **Atualização desta auditoria:** em `main@9314c72`, o cliente de conversa v1.0, outbox e worker opt-in estão
  integrados (PR #10, `c29cc04`), assim como a retomada de contexto (PR #11, `681d21d`) e acesso por senha
  (PRs #13/#14). Conferidos `conversation.py`, `outbox.py`, `conversation_runner.py` e a CI. Não há cliente direto
  de `/api/evaluate`: conversa v1.0 não é consumidor automático do ranking 2.0.
- **Schemas e integração do bot são referências distintas:** `contracts-provenance.json` fixa schemas v1.0 em
  `6ce3d99`; a CI HTTP do bot fixa a API em `2b77c95`, anterior à RANK-03. Nenhuma dessas referências prova
  validação do cliente contra todo o backend atual. Não foram alteradas cópias, hashes ou configuração de CI.
- **Composição coletiva no backend atual:** GRP-01, integrada pelo PR #37 (`8191a0f`), usa `rankCandidates`
  para opções individuais; o ranqueador de planos é provisório. O fluxo de propostas da main não declara
  total completo ou autorização de compra. A montagem opt-in foi integrada pelo #36 (`dc448f9`); isto não
  comprova apresentação ponta a ponta no Telegram ou integração real com iFood.
- **Futuro cliente de ranking/outros repositórios:** validar versão 2.0, enviar prioridade declarada, tratar
  PRIORITY_REQUIRED com pergunta, usar `rank`/ordem retornada (não reordenar por score), preservar os três
  buckets e todos os motivos, mostrar cobertura/limitações, não exibir score como satisfação e não reconstruir
  total com `null ?? 0`. Não descartar NEEDS_VERIFICATION ou juntá-lo a incompatibilidade para simular compatibilidade.

## Validação e limites

Novos testes offline: `test/domain/rank03.test.ts`, `test/integration/rank03-http.test.ts`.
Fixtures reais com preços, frete, serviço explícito e prazos sintéticos identificados. Testes HTTP usam Hono
em memória e o pipeline com mocks; não autenticam conta real nem fazem chamadas iFood/MCP ou compras.

Limites remanescentes: catálogo sem serviço não fornece total completo; redistribuição de score não foi
aprovada como política de ordenação; adaptação de um futuro consumidor direto do ranking e validação operacional
continuam separadas. A implementação RANK-03 já tem commit e merge, conforme a evidência no início do documento.
DEC-01 D10 exige ensaios/metas operacionais além dos testes offline, não declarados concluídos aqui.

### Resultados históricos da implementação RANK-03 (`8d54bfc`)

Registro original em Linux, Node v24.14.1, npm 11.11.0. **Não reexecutados nesta auditoria** e não apresentados
como resultado da main `dc448f9` ou do serviço implantado:

| Comando efetivamente executado | Resultado |
| --- | --- |
| `npx vitest run test/domain/rank03.test.ts test/integration/rank03-http.test.ts` | 31 passaram, 0 falharam, 0 ignorados, em 2 arquivos |
| `npm run typecheck` | passou |
| `npm run lint` | passou |
| `npm test` | 670 passaram, 0 falharam, 0 ignorados, em 39 arquivos |
| `npm run build` | passou (`tsc` + build Vite) |
| `git diff --check` | passou |

Os quatro scripts também passaram na sequência `npm run typecheck && npm run lint && npm test && npm run build`.
A suíte inclui regressões das issues #3/#8/#9, orçamento, configuração, DOM-01, ranking e testes HTTP.
Na primeira execução direcionada de testes existentes, uma expectativa numérica diagnóstica antiga precisou
ser atualizada para a soma das contribuições arredondadas com os pesos da prioridade declarada; a validação
final acima passou. Nenhum teste foi removido, ignorado ou enfraquecido para contornar falhas de ambiente.

Aviso observado naquela execução: SQLite experimental do Node. Windows/CI não foram executados naquela
implementação local; isso não descreve execuções posteriores de CI. Nenhum ensaio real de iFood/MCP foi feito
na implementação registrada. `.env`, credenciais e conteúdo não rastreado foram preservados. A afirmação
original de alterações somente no working tree foi superada pelo commit `8d54bfc` e merge `2df4e54`.

### Pendências atuais

- Confirmar separadamente versões implantadas, flags e ensaio integrado do bot/API/iFood depois das tasks.
- Preservar bloqueio para alergias/`MANDATORY` não verificadas e para orçamento completo desconhecido;
  somente elegíveis são recomendados. Sacola simulada não significa pedido enviado e o modelo não aprova.
- A auditoria documental não muda o contrato nem resolve por suposição a aprovação simulada ainda pendente
  de contrato/implementação próprios. Novos commits/publicação desta documentação dependem de autorização.
