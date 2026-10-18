# Resumo do Projeto: Compra com Contexto (SEMCOMP × iFood)

## Resumo executivo

O projeto é um **MVP de recomendação de comida com contexto** construído para o evento SEMCOMP em parceria com o iFood. O usuário fornece restrições alimentares, orçamento e preferências; o sistema busca ofertas reais no marketplace iFood via uma integração MCP (Model Context Protocol), detalha os candidatos, valida as restrições, compõe preços honestos e retorna recomendações explicadas — **sem checkout automático**. A integração com o Telegram permite que um organizador vincule sua conta iFood ao bot e acione o pipeline de avaliação.

---

## 1. O que o projeto faz

1. **Entrada de contexto**: restrições alimentares (vegano, sem glúten, alergias etc.), orçamento máximo por item/pedido, preferências de busca (texto livre).
2. **Descoberta**: chama `searchOffers` no MCP do iFood com filtros server-side para restrições obrigatórias; pagina até 2 páginas (máx. 40 candidatos por padrão).
3. **Detalhamento**: chama `getItem` para os top candidatos (máx. 10 por padrão) em paralelo (concorrência 4), com cache em memória de 60 s.
4. **Validação de restrições**: modelo tri-estado (`PASS | FAIL | UNKNOWN`) por restrição × item; heurística textual para inferir violações; alergia nunca resulta `PASS`.
5. **Composição de preço honesta**: base (`promotionalUnitPrice ?? unitPrice`) + Σ `additionalPrice` das opções; detecta e sinaliza a ambiguidade "unitPrice = Σ obrigatórias mínimas" (padrão "a partir de").
6. **Resposta explicada**: cada candidato carrega `blockers`, `warnings`, `dataLimitations`, missingFields, detalhamento de preço e estado de cada restrição.

---

## 2. Arquitetura

```
src/
  server/
    index.ts          # ponto de entrada: serve Hono na porta 8000
    app.ts            # factory createApp(): monta todas as rotas e middlewares
    auth.ts           # OAuth 2.1/PKCE/PAR (IfoodAuth)
    botAuth.ts        # middleware de autenticação bot→API (Bearer + X-Telegram-User-Id)
    config.ts         # lê variáveis de ambiente; nunca expõe segredos
    mcp/
      client.ts       # McpSession: cliente Streamable HTTP com retry 401
      tools.ts        # wrappers tipados + ALLOWED_TOOLS (blocklist de tools de escrita)
      errors.ts       # McpToolError (inline errors[] do MCP)
      types.ts        # interfaces derivadas de respostas reais
    domain/           # funções puras (sem fetch): lógica de negócio testável
      fields.ts       # tipo Field<T>: PRESENT | NULL | ABSENT | INVALID
      normalize.ts    # MCP → NormalizedItem/SearchResult
      constraints.ts  # tri-estado de restrições, heurística textual
      configuration.ts# validação de optionGroups (minSelections/maxSelections)
      pricing.ts      # composição de preço, ambiguidade, faixas
      eligibility.ts  # avaliação completa de candidato (chama tudo acima)
    links/
      service.ts      # IfoodLinkService: state machine do vínculo Telegram↔iFood
      store.ts        # persistência de vínculos em JSON (modo 600)
      session.ts      # SessionFactory real (MCP session por vínculo)
      identity.ts     # identidade mascarada (getUser)
      classify.ts     # classifica falhas em RECONNECT | UNAVAILABLE | OTHER
    routes/
      bot.ts          # rotas /api/bot/ifood/* + /auth/ifood/start + callback
      evaluate.ts     # POST /api/evaluate (valida input, converte centavos→BRL)
    services/
      evaluate.ts     # pipeline E2E runEvaluation(): busca→detalhe→avaliação
      evaluate-view.ts# formata EvaluateOutcome para a API
      cents.ts        # conversão BRL decimal ↔ centavos inteiros (borda do bot)
  web/
    App.tsx           # UI de diagnóstico (React + Vite): auth status, MCP test, busca rápida
    index.html / main.tsx / styles.css
```

O backend é uma aplicação **Hono** (Node 22 + TypeScript strict). O frontend é **React + Vite** servido em proxy no desenvolvimento.

---

## 3. Stack e dependências

| Camada | Tecnologia |
|---|---|
| Runtime | Node 22+ |
| Linguagem | TypeScript strict (`tsconfig.json`) |
| Framework HTTP | Hono 4 + `@hono/node-server` |
| Cliente MCP | `@modelcontextprotocol/sdk` v1.32 (Streamable HTTP/JSON-RPC) |
| Validação de schema | Zod 4 |
| Frontend | React 19 + Vite 8 |
| Testes | Vitest 5 |
| Linting | ESLint 10 + typescript-eslint |
| Build | Vite (frontend) + `tsx` (backend em dev) |

---

## 4. Como a autenticação funciona

### 4.1 OAuth 2.1/PKCE com o iFood (IfoodAuth — `src/server/auth.ts`)

- Authorization Server: `https://id.ifood.com.br` (OIDC discovery em `/.well-known/openid-configuration`).
- Fluxo: `authorization_code` + PKCE S256 + PAR (Pushed Authorization Request, quando o AS suporta).
- `client_secret_basic` via `Authorization: Basic` (RFC 6749 §2.3.1).
- Tokens ficam em **memória** e, opcionalmente, em arquivo `*.tokens.json` com `chmod 600` (nunca no Git).
- Refresh automático quando o token expira em < 60 s; proteção contra refreshes concorrentes com `Promise` compartilhada.
- Falha de rede/provedor → `PROVIDER_UNREACHABLE` — **nunca equivale a logout** (tokens mantidos).

### 4.2 Autenticação bot→API (botAuth — `src/server/botAuth.ts`)

- Cabeçalho `Authorization: Bearer $BOT_API_TOKEN` — validado com `timingSafeEqual`.
- Cabeçalho `X-Telegram-User-Id` — ID numérico do organizador, já validado pelo adaptador Telegram; conferido contra `ALLOWED_ORGANIZER_IDS`.
- A identidade **nunca** vem do corpo, da query ou de texto do usuário/LLM.
- Sem configuração → `503` (fail closed).

### 4.3 Vínculo Telegram↔iFood (IfoodLinkService — `src/server/links/service.ts`)

Estado machine com 6 estados: `DISCONNECTED → AWAITING_AUTHORIZATION → AWAITING_CONFIRMATION → CONNECTED` (ou `RECONNECT_REQUIRED`, `UNAVAILABLE`).

**Fluxo de conexão:**
1. `POST /api/bot/ifood/connect` → gera tentativa com state + PKCE aleatórios + link de start.
2. Navegador na máquina local abre `/auth/ifood/start` → reivindica a tentativa (cookie HttpOnly) → redireciona ao iFood.
3. iFood redireciona de volta ao callback `GET /` → troca código por tokens → consulta identidade mascarada (`getUser`) → estado `AWAITING_CONFIRMATION`.
4. Organizador toca **Confirmar conexão** no Telegram → bot chama `POST /api/bot/ifood/confirm` → instala vínculo com tokens, sessão MCP e cache próprios → executa `listAddresses` para verificar que é operacional.

**Garantias de segurança:**
- Callback só aceita conexões de loopback por padrão.
- Primeiro navegador "reivindica" a tentativa via cookie; outro navegador recebe 409.
- `confirmationId` é opaco, uso único, válido por 10 min.
- Cada vínculo tem seu próprio `IfoodAuth`, arquivo de tokens, `McpSession` e `ItemCache`.

---

## 5. Integração MCP

**Endpoint:** `https://consumer-mcp.ifood.com.br/marketplace` (Streamable HTTP/JSON-RPC)

O cliente MCP (`src/server/mcp/client.ts`) usa `StreamableHTTPClientTransport` com uma função `fetch` customizada que injeta `Bearer` no header e faz retry automático em 401 com refresh.

**Tools permitidas** (blocklist explícita em `ALLOWED_TOOLS` — `src/server/mcp/tools.ts`):

| Tool | Uso |
|---|---|
| `listAddresses` | Resolve localização do usuário antes de qualquer busca |
| `searchOffers` | Descoberta de candidatos (query descritivo + refinamentos) |
| `browseOffers` | Fallback sem termo descritivo |
| `getItem` | Detalhamento obrigatório antes de recomendar (preço final + opções) |
| `getMerchant` | Detalhe opcional da loja |
| `getRecommendations` | Opcional |
| `getUser` | Apenas para identidade mascarada na confirmação do vínculo (`includeProfileData: false`) |

Tools de escrita (`createCart`, `addItemToCart`, `submitOrder` etc.) são bloqueadas — nunca chamadas.

**Tratamento de erros inline:** O MCP retorna erros dentro do payload (`errors[]` em discovery, `error` singular em cart). `McpToolError` encapsula `code`, `retryable` e `errors`. Retry apenas para erros com `retryable: true`.

---

## 6. Lógica de domínio (`src/server/domain/`)

Todas as funções são **puras** (sem fetch) e testáveis com fixtures de respostas reais.

### 6.1 Sistema de campos (`fields.ts`)
`Field<T>` distingue explicitamente 4 estados: `PRESENT(value)`, `NULL`, `ABSENT`, `INVALID(raw)`. Isso impede confundir "campo não veio" com "campo é null" — regra crítica dado que o MCP às vezes omite campos.

### 6.2 Normalização (`normalize.ts`)
Converte respostas cruas do MCP em `NormalizedListingItem` (de `searchOffers`) e `NormalizedItemDetail` (de `getItem`). Campos desconhecidos são listados em `unknownFields`. IDs são validados como UUID. Itens sem UUID válido são descartados e reportados em `skipped`.

### 6.3 Restrições (`constraints.ts`)
- **Tri-estado:** `PASS | FAIL | UNKNOWN` por restrição × item.
- **Fontes de evidência:** `SERVER_FILTER` (filtro do catálogo iFood), `SERVER_FILTER_IMPLIED` (ex.: vegano implica vegetariano), `HEURISTIC` (palavras-chave em nome/descrição/opções), `CONFLICT` (filtro e heurística divergem), `NO_DATA`.
- **Alergias:** só `FAIL` ou `UNKNOWN` — nunca `PASS` (a classificação do catálogo não cobre contaminação cruzada nem opções).
- **Heurística:** listas de palavras para carne, laticínios, ovos, suínos, glúten, amendoim, nozes, soja, peixe, frutos do mar, açúcar — com negações (`"sem bacon"`) e marcadores de versão segura (`"muçarela vegana"`).

### 6.4 Configuração de opções (`configuration.ts`)
Valida uma seleção de opções contra os `optionGroups` retornados por `getItem` (respeita `minSelections`/`maxSelections`). Função `cheapestRequiredSelection` monta a configuração mínima mais barata (para o "a partir de" honesto), excluindo opções bloqueadas por restrições.

### 6.5 Preço (`pricing.ts`)
- Três níveis: `MINIMUM_CONFIGURABLE` (obrigatórias mais baratas), `SELECTED` (configuração do usuário), `CONFIRMED` (sempre `null` — só existe no carrinho).
- Detecção da ambiguidade "unitPrice = Σ obrigatórias mínimas" (`detectFromPricePattern`): quando detectada, o preço vira uma **faixa** (`UNCERTAIN`) com duas interpretações (`BASE_PLUS_OPTIONS` e `OPTIONS_ARE_PRICE`).
- Flags: `AMBIGUOUS_OPTION_PRICING`, `OPTION_PRICE_MISSING`, `OPTION_REPEAT_UNVERIFIED`, `PRICE_ANOMALY`.
- Pedido mínimo: compara com o subtotal de itens; `met: null` quando a faixa cruza o mínimo.

### 6.6 Elegibilidade (`eligibility.ts`)
Combina disponibilidade (`isOpen`), restrições, configuração e orçamento em um `EligibilityResult` com `eligible: boolean`, `blockers[]` e `warnings[]`. Orçamento é teto obrigatório: `UNKNOWN` de preço bloqueia quando há teto.

---

## 7. Pipeline E2E (`src/server/services/evaluate.ts`)

`runEvaluation(req, deps, cache)` é o coração do sistema:

1. **Localização**: resolve endereço via `listAddresses` ou usa `userLocation` direto.
2. **Busca**: `searchOffers` paginado (até `maxPages`), deduplicando por `itemId`, respeitando `maxCandidates`.
3. **Filtros server-side**: só restrições **obrigatórias** viram `itemRestrictions` no MCP (preferências não excluem itens).
4. **Detalhamento**: lojas fechadas → `SKIPPED_CLOSED`; demais até `maxDetails` → `getItem` em paralelo (`mapLimit` com `concurrency`); prazo global (`deadlineMs`); cache por (`merchantId:itemId:lat,lng`).
5. **Avaliação**: `evaluateCandidate` para cada candidato (puro, determinístico).
6. **Saída**: `EvaluateOutcome` com listas `eligible`/`blocked` + metadados de busca/detalhe/prazo.

A rota `POST /api/evaluate` (`src/server/routes/evaluate.ts`) recebe o corpo **em centavos** (contrato do bot), converte para BRL decimal, executa o pipeline e converte a resposta de volta para centavos via `evaluateViewCents`.

---

## 8. Contrato bot→API

Definido em `docs/bot-api.md`. Pontos-chave:
- Autenticação dupla: `Bearer BOT_API_TOKEN` + `X-Telegram-User-Id`.
- Dinheiro em **centavos inteiros** na entrada e na saída (`*Cents`, `*Range.minCents/maxCents`).
- 6 estados de vínculo com transições bem definidas.
- Endpoints: `/api/bot/ifood/{status, connect, confirm, verify, cancel, link}`, `/api/addresses`, `/api/evaluate`.
- Confirmação por **botão** no Telegram (não por código digitado).
- `purchaseAuthorized: false` sempre — login não aprova compra.

---

## 9. Testes

Comando: `npm test` (vitest run). 14 arquivos de teste em `test/`.

| Arquivo | O que testa |
|---|---|
| `test/app.test.ts` | `pickAddress`, `errorBody` |
| `test/auth.test.ts` | IfoodAuth: PKCE, PAR, refresh, armazenamento, estados de erro |
| `test/mcp-parse.test.ts` | `parseToolResult`, erros inline do MCP |
| `test/domain/normalize.test.ts` | Normalização de `searchOffers` e `getItem`, campos ausentes/inválidos |
| `test/domain/constraints.test.ts` | Heurística textual, filtros server-side, tri-estado, alergias |
| `test/domain/configuration.test.ts` | Validação de seleções, `cheapestRequiredSelection`, opções bloqueadas |
| `test/domain/pricing.test.ts` | Composição de preço, padrão "a partir de", faixas, casos-limite |
| `test/domain/eligibility.test.ts` | Avaliação de candidato completa (restrições + orçamento) |
| `test/domain/allergy-regression.test.ts` | Regressão: alergias nunca resultam PASS |
| `test/integration/evaluate.test.ts` | Pipeline E2E com fixtures reais; paginação, cache, retry, prazo, campos ausentes |
| `test/links/service.test.ts` | IfoodLinkService: fluxo de vínculo, estados, erros |
| `test/links/routes.test.ts` | Rotas do bot (com app.test helpers) |
| `test/links/storage.test.ts` | LinkStore: persistência, migração, permissões |
| `test/links/concurrency.test.ts` | Serialização de operações por organizador (locks) |

As fixtures em `fixtures/` são respostas **reais** do MCP (searchOffers, getItem, tools-list), usadas offline. Nunca contêm dados pessoais ou segredos.

---

## 10. Convenções e padrões notáveis

- **Dinheiro**: BRL decimal no domínio; centavos inteiros na borda do bot (`services/cents.ts`).
- **Enums**: `SCREAMING_SNAKE_CASE`; JSON `lowerCamelCase`.
- **IDs**: sempre UUIDs vindos do MCP; nunca fabricados em produção.
- **Ausente ≠ null ≠ lista vazia**: o tipo `Field<T>` torna isso explícito em tempo de compilação.
- **Sem escrita no iFood**: `ALLOWED_TOOLS` é uma allowlist; qualquer tool de escrita lança erro antes de chegar ao MCP.
- **Segredos**: somente em variáveis de ambiente; tokens em arquivos `chmod 600` fora do Git; nunca em respostas HTTP, logs ou UI.
- **Testabilidade**: todo o domínio (`domain/*`) é puro e injetável. `EvaluateDeps` é uma interface que os testes substituem por fakes.
- **Resiliência**: falha de rede → `UNAVAILABLE` (não logout); refresh recusado → `RECONNECT_REQUIRED`; retry apenas para `retryable: true`.

---

## 11. Configuração e execução

```bash
npm install
cp .env.example .env          # preencher IFOOD_CLIENT_ID, IFOOD_CLIENT_SECRET etc.
# ou: npm run setup:env        # lê do ~/.config/opencode/opencode.jsonc
npm run dev                   # backend :8000 + Vite :5173
npm test                      # vitest run
npm run typecheck             # tsc --noEmit
npm run lint                  # eslint .
npm run smoke                 # scripts/smoke.ts (teste manual E2E com rede real)
```

Variáveis de ambiente relevantes (ver `.env.example`):
- `IFOOD_CLIENT_ID`, `IFOOD_CLIENT_SECRET`, `IFOOD_REDIRECT_URI` (deve ser exatamente `http://localhost:8000`)
- `BOT_API_TOKEN` (≥ 32 chars), `ALLOWED_ORGANIZER_IDS` (IDs numéricos Telegram)
- `DEV_GLOBAL_SESSION=true` habilita as rotas `/api/auth/*` e o diagnóstico com MCP (somente dev)
- `PUBLIC_BASE_URL`, `IFOOD_LINKS_DIR`, `WEB_ORIGIN`

---

## 12. O que está fora de escopo (MVP)

Checkout, carrinho automático, pagamentos, vouchers, rastreamento de pedidos, cadastro/login próprio, persistência de histórico, ranking explicado (implementado só a avaliação sem ranking), multi-endereço avançado.

---

## 13. Evidências por arquivo

| Achado | Arquivo(s) |
|---|---|
| Definição do produto e regras de ouro | `CLAUDE.md`, `docs/requirements.md` |
| Integração OAuth 2.1/PKCE | `src/server/auth.ts` |
| Cliente MCP Streamable HTTP | `src/server/mcp/client.ts`, `src/server/mcp/tools.ts` |
| Lógica de restrições tri-estado | `src/server/domain/constraints.ts` |
| Sistema de campos (ABSENT ≠ NULL) | `src/server/domain/fields.ts` |
| Composição de preço + ambiguidade | `src/server/domain/pricing.ts`, `docs/pricing-audit.md` |
| Elegibilidade completa | `src/server/domain/eligibility.ts` |
| Pipeline E2E | `src/server/services/evaluate.ts` |
| Vínculo Telegram↔iFood | `src/server/links/service.ts`, `docs/bot-api.md` |
| Contrato bot (centavos) | `src/server/services/cents.ts`, `src/server/routes/evaluate.ts` |
| Testes com fixtures reais | `test/integration/evaluate.test.ts`, `fixtures/` |
| Fixtures de respostas reais do MCP | `fixtures/searchOffers-*.json`, `fixtures/getItem-*.json` |

---

## 14. Recomendações (sem implementar)

1. **Ranking ainda não implementado**: `src/server/domain/` tem `constraints`, `configuration`, `pricing`, `eligibility` — mas não `ranking.ts` nem `explain.ts` mencionados em `CLAUDE.md`. O pipeline retorna os resultados na ordem do iFood sem pontuação. Implementar o `FR-7`/`FR-8` seria a próxima etapa natural.

2. **Frontend incompleto**: `src/web/App.tsx` é apenas uma tela de diagnóstico (auth status + busca rápida). As 3 telas do `FR-9` (Contexto → Resultados → Detalhe) não foram construídas.

3. **Sessão global desligada por padrão**: `DEV_GLOBAL_SESSION=false` significa que `/api/auth/*` e o diagnóstico MCP completo só funcionam se habilitados explicitamente. A UI atual depende dessas rotas — em produção com `DEV_GLOBAL_SESSION=false` ela não funciona.

4. **Sem criptografia dos tokens em repouso**: tokens ficam em arquivos `chmod 600` no `IFOOD_LINKS_DIR`. Para ambientes de maior risco, seria necessário criptografar em repouso.

5. **Sem rate limiting**: a documentação em `docs/bot-api.md` (seção 10) reconhece que não há rate limiting. Para produção com múltiplos organizadores seria necessário adicionar.

6. **Testes de alergia são regressão explícita**: `test/domain/allergy-regression.test.ts` existe para garantir que alergias nunca resultem `PASS` — uma invariante de segurança crítica que deve ser mantida em qualquer refatoração.
