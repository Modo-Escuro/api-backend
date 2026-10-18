# Ranking de recomendações (F4) — implementação

Status: **implementado no api-backend** (2026-10-17). Base: `docs/requirements.md` (FR-4, FR-5, FR-7, FR-8).
Contrato HTTP/centavos e exemplo de payload: `docs/bot-api.md` (seções 7 e 8).

## 1. Ordem das decisões

```
restrições obrigatórias (domain/constraints.ts + domain/eligibility.ts)
        │  decide elegibilidade ANTES de qualquer pontuação
        ▼
classificação (domain/ranking.ts → classifyBlockers)   ELIGIBLE | BLOCKED | NEEDS_VERIFICATION
        │  só ELIGIBLE segue
        ▼
pontuação (domain/ranking.ts → rankCandidates)         score 0–1 + critérios explicáveis
        │
        ▼
ORDERNAÇÃO + corte (score desc → ordem da busca → itemId; máx. 4)
```

Regra inegociável: **nenhuma pontuação compensa restrição obrigatória.** Preço, promoção, avaliação e
preferência nunca mudam a categoria de um candidato; `rankCandidates` ainda descarta defensivamente qualquer
candidato com `blockers` (defesa em profundidade). Nada aqui faz fetch, lê relógio ou usa aleatoriedade.

## 2. Classificação (três buckets mutuamente exclusivos)

`classifyBlockers(blockers)` particiona o resultado de `evaluateCandidate`:

| Categoria | Quando | Exemplos de código |
|---|---|---|
| `ELIGIBLE` | sem blockers (⟺ `evaluation.eligible === true`) | — |
| `BLOCKED` | **incompatibilidade identificada** | `MERCHANT_CLOSED`, `RESTRICTION_FAIL`, `OVER_ITEM_BUDGET`, `OVER_ORDER_BUDGET`, `NO_VALID_CONFIGURATION`, `CONFIG_*` |
| `NEEDS_VERIFICATION` | **falta de informação** (nunca vira "seguro") | `NOT_DETAILED`, `RESTRICTION_UNVERIFIED`, `ALLERGY_UNVERIFIED`, `ALLERGY_OPTIONS_UNVERIFIED`, `ITEM_BUDGET_UNVERIFIED`, `ORDER_BUDGET_UNVERIFIED`, `PRICE_UNAVAILABLE` |

- Incompatibilidade tem precedência sobre falta de informação (bloco com os dois ⇒ `BLOCKED`).
- Código desconhecido ⇒ `BLOCKED` (conservador: não recomendar).
- Alergia é sempre `MANDATORY` e nunca resulta `PASS` (`bot-api.md` §6): com dados insuficientes o item cai em
  `NEEDS_VERIFICATION` (`ALLERGY_UNVERIFIED`), não em `ELIGIBLE` nem `BLOCKED`.

No `POST /api/evaluate` isso vira: `recommendations` (só ELIGIBLE, ordenado), `eligible`, `blocked`,
`needsVerification` e `summary = { candidates, eligible, blocked, needsVerification, recommendations, blockerCounts }`
com `eligible + blocked + needsVerification === candidates`.

## 3. Entrada do ranking

| Campo (corpo da requisição) | Efeito |
|---|---|
| `restrictions[]` (DIETARY/ALLERGY) | **obrigatório** — decide elegibilidade; vira filtro server-side quando aplicável |
| `budget` | **obrigatório** — teto; exceder ⇒ `BLOCKED`/`NEEDS_VERIFICATION`, nunca "compensa ficar caro" |
| `refinements` (`maxDistanceKm`, `maxDeliveryTimeMinutes`, `maxDeliveryFeeCents`, `minRating`) | alimenta o critério CONTEXT |
| `preferences` (`foodTypes`, `likedIngredients`, `avoidedIngredients`, `occasion`, `priority`) | alimenta o critério PREFERENCES e os pesos — **nunca** vira filtro nem mexe em elegibilidade |

`priority` (`ECONOMY` \| `SPEED` \| `PREFERENCES`) dobra exatamente um critério (`PRICE`/`DELIVERY`/`PREFERENCES`)
via `weightsFor`; os pesos entram na resposta em `ranking.weights`.

## 4. Pesos e critérios

Pesos padrão (`DEFAULT_WEIGHTS`): `PREFERENCES 35% · CONTEXT 25% · PRICE 20% · DELIVERY 10% · RATING 10%` (somam 1).

| Critério | Sinal | Normalização | Origem |
|---|---|---|---|
| `PREFERENCES` | média de sinais (restrição marcada como `PREFERENCE`, `foodTypes`/`likedIngredients`/`avoidedIngredients`/`occasion` por similaridade de texto do nome/descrição/opções) | absoluta 0–1 | `preferences` |
| `CONTEXT` | folga relativa (`headroom`) de distância, tempo, taxa e nota mínima pedidos | absoluta 0–1 | `refinements` |
| `PRICE` | preço por unidade (`selected ?? minimumConfigurable`; faixa ⇒ ponto médio, com limitação explícita) | min–max entre os **ELIGIBLE** desta consulta (mais barato = 1) | `pricing` |
| `DELIVERY` | média de ETA (ponto médio do intervalo) e taxa de entrega | min–max entre os ELIGIBLE (menor = 1) | listagem |
| `RATING` | `merchant.rating.value` | min–max entre os ELIGIBLE (maior = 1) | listagem |

- **Dado ausente** (explícito): critério vem `status: "NO_DATA"`, `score: null`, `contribution: null`,
  `effectiveWeight: 0`; o total é a média ponderada **só dos critérios avaliados** e a limitação aparece em
  `dataLimitations`. Nenhuma nota é inventada; `score: null` só quando nenhum critério pôde ser avaliado.
- Min–max empatado (todos com o mesmo valor) ⇒ `0.5` neutro, não "o melhor".
- Preferências por texto são **heurística rotulada**: ausência do termo não prova ausência do ingrediente —
  usadas só para pontuar, nunca para segurança.

## 5. Saída

Por recomendação, o campo `ranking`:

```jsonc
{ "rank": 1, "score": 0.9124,
  "criteria": [ { "criterion": "PRICE", "weight": 0.4, "effectiveWeight": 0.4211,
                  "status": "SCORED", "score": 1, "contribution": 0.4211,
                  "basis": "Preço por unidade normalizado (min–max) entre 4 opção(ões) elegível(eis).",
                  "reasons": ["preço estimado R$ 29.90 por unidade", "menor preço entre as opções elegíveis"],
                  "dataLimitations": [] }, … ],
  "reasons": ["…"], "dataLimitations": ["critério CONTEXT sem dado (NO_DATA): …"] }
```

No topo: `ranking = { weights, priority, maxRecommendations: 4, eligibleConsidered, eligibleScored, notes }`
(com a nota "Nenhuma opção pôde ser confirmada como compatível…" quando `recommendations` for `[]`).

Garantias: `recommendations.length = min(4, eligible)`; bloqueados/pendentes nunca aparecem em
`recommendations`; ordem decrescente de `score`; empates determinísticos (score desc → ordem da busca →
`itemId`). Dinheiro segue o contrato em centavos (`services/cents.ts`); `ranking` não tem dinheiro e passa
intacto na saída.

## 6. Arquivos

| Arquivo | Papel |
|---|---|
| `src/server/domain/ranking.ts` | **novo** — classificação, pesos, critérios, `rankCandidates` (função pura) |
| `src/server/services/evaluate.ts` | classifica cada candidato, chama o ranking só com ELIGIBLE, `preferences` no request |
| `src/server/services/evaluate-view.ts` | buckets da resposta, `recommendations` + `ranking`, `summary`, `notes` |
| `src/server/services/cents.ts` | `recommendations`/`needsVerification` em centavos (genérico preserva `ranking`) |
| `src/server/routes/evaluate.ts` | zod `preferences` (strict, `priority` enum) — passa em `toDomainRequest` |
| `docs/bot-api.md` | §8 contrato + exemplo; §7 referência de centavos |

Não alterados (por decisão): `domain/constraints.ts`, `domain/eligibility.ts`, `domain/normalize.ts`,
`domain/pricing.ts` — a elegibilidade continua sendo decidida só ali.

## 7. Correção encontrada durante os testes

`pricePoint` (`src/server/domain/ranking.ts`) não tratava preço único (`unitTotalRange.min === max`, o caso
mais comum: item sem opções) e caía no retorno final ⇒ `PRICE` virava `NO_DATA` para todo mundo. Corrigido:
`min === max` devolve o valor sem limitação; faixa (`max > min`) continua com ponto médio + limitação.

## 8. Testes (25 novos; total 239)

| Arquivo | Cobre |
|---|---|
| `test/domain/ranking.test.ts` (14) | alergia ⇒ BLOCKED; alérgeno não verificável/`SERVER_FILTER_INSUFFICIENT` ⇒ fora do ranking; dieta sem dado ⇒ `NEEDS_VERIFICATION`; teto de preço ⇒ BLOCKED; ordenação 0.75/0.5/0.25; preferência reordena sem mudar buckets; `NO_DATA` redistribui peso (0.8333); `priority` dobra um critério; empate determinístico; teto de 4; sem elegível ⇒ explicação; pesos somam 1 |
| `test/integration/evaluate-rank.test.ts` (5) | pipeline real: 4 recomendações com rank/critérios/contribuições fechando com o score; preferência não vira filtro e não muda elegibilidade; 0 elegível ⇒ `notes`; pendentes (sem `getItem`) fora das recomendações; saída em centavos sem dinheiro decimal |
| `test/links/routes.test.ts` (+6) | `preferences` chega ao ranking e não vira `itemRestrictions`; 400 para `priority` inválida, chave desconhecida e texto vazio (sem chamada ao MCP) |
| `test/integration/evaluate.test.ts` | asserções migradas para `needsVerification` (orçamento não verificável, `FAILED`, `SKIPPED_LIMIT/DEADLINE`) |
| `test/integration/fakes.ts` | `fake()/fx/ADDRESS` extraídos e compartilhados entre as integrações |

Verificação: `npm run typecheck && npm run lint && npm test` — limpo (16 arquivos, 239 testes).

## 9. Fora de escopo / possíveis próximos passos

- **`CONTEXT` considera só `refinements`** — FR-7 cita também "preço final vs orçamento"; incluiria um
  `headroom` do `budget` no critério de contexto (hoje o orçamento age só como filtro duro).
- Preferências usam similaridade de texto; nenhuma resposta real do MCP traz ingredientes/alérgenos
  estruturados (heurística rotulada, nunca usada para segurança).
- Sem checkout (regra de ouro do MVP): preço é estimativa; total confirmado só no carrinho do iFood.
- Ordenação alternativa por `refinements.sort` (ordenação do iFood) continua existindo **antes** do ranking;
  o ranking reordena apenas os candidatos ELEGIBLE desta consulta.
