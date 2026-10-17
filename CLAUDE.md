# CLAUDE.md — Compra com Contexto (SEMCOMP × iFood)

## O que é este projeto
MVP de recomendação com contexto: restrições do usuário → busca real no iFood (MCP) → detalhamento de itens → validação de restrições → cálculo honesto de preço → ranking → recomendação com explicação. **Sem checkout automático.**

## Stack
- Node 22 + TypeScript (strict)
- Backend: Hono na porta 8000 (compatível com `redirectUri: http://localhost:8000`)
- Frontend: React + Vite (dev em proxy para o backend)
- Cliente MCP: `@modelcontextprotocol/sdk` (Streamable HTTP + OAuth)
- Testes: vitest | Lint: eslint | `npm run typecheck`

## Comandos
```bash
npm install
npm run dev        # backend :8000 + vite
npm run typecheck  # tsc --noEmit
npm run lint
npm test
```

## Integração iFood MCP (fatos verificados — não inventar)
- Endpoint remoto (Streamable HTTP, JSON-RPC): `https://consumer-mcp.ifood.com.br/marketplace`
- OAuth 2.1/PKCE (S256) + PAR; AS: `https://id.ifood.com.br` (OIDC discovery confirmado)
- Resource metadata: `https://consumer-mcp.ifood.com.br/.well-known/oauth-protected-resource/marketplace`
- Ferramentas do MVP (somente estas, conforme schemas observados):
  `listAddresses`, `searchOffers`, `browseOffers`, `getRecommendations`, `getItem`, `getMerchant`
- Campos/ capacidades novos só podem ser usados se aparecerem em resposta real do MCP.

## Credenciais (nunca commitar, nunca logar)
- Config existente do OpenCode: `~/.config/opencode/opencode.jsonc` (fonte única atual; há 2 clients — usar 1 só)
- O app lê por env: `IFOOD_MCP_URL`, `IFOOD_CLIENT_ID`, `IFOOD_CLIENT_SECRET`, `IFOOD_REDIRECT_URI` (default `http://localhost:8000`)
- Redirect OAuth registrado no client: **`http://localhost:8000`** — exatamente, sem barra final e sem `/callback`
  (o AS compara `redirect_uri` literalmente). O backend trata o callback em `GET /` (e também aceita `GET /callback`)
  e depois redireciona o navegador para `WEB_ORIGIN` (default `http://localhost:5173`).
- Tokens OAuth: memória + arquivo `.tokens.json` em `.gitignore`. Nunca em resposta HTTP/UI.
- O `userId` é injetado pelo gateway via token — o app nunca manipula `userId`.

## Regras de ouro (transversais)
1. **Nunca inventar IDs** (`addressId`, `merchantId`, `itemId`, `cartId`, `optionId`...): só os retornados pelas respostas.
2. **`getItem` antes de recomendar/preço final** — `searchOffers` pode mostrar preço promo, mas só `getItem` traz `optionGroups` e limites.
3. **Ausente ≠ `null` ≠ lista vazia** — tratar e mostrar explicitamente (ex.: alérgenos ausentes ⇒ "informação indisponível", nunca "não contém").
4. **Restrição com dados insuficientes ⇒ marcar como "não verificado"**, não concluir.
5. **Sem checkout**: proibido `createCart` / `addItemToCart` / `submitOrder` no MVP.
6. **Preço exibido = composição**: base (`promotionalUnitPrice` ?? `unitPrice`) + Σ `additionalPrice` das opções escolhidas; avisar se < `merchantMinimumOrderAmount`.
   Exceção observada: quando Σ das opções obrigatórias mais baratas = `unitPrice`, a semântica é ambígua (preço "a partir de")
   ⇒ mostrar faixa, nunca um valor único. Ver `docs/pricing-audit.md`. Todo preço é estimativa; total confirmado só no carrinho.
7. Erros do MCP vêm inline (`errors[]` em discovery; `error` singular em cart) — mapear `code`/`retryable`, não genérico "deu erro".

## Estrutura alvo
```
src/
  server/
    index.ts        # Hono app, rotas /api/*
    auth.ts         # OAuth PKCE + PAR, refresh, armazenamento de token
    mcp/
      client.ts     # cliente Streamable HTTP (singleton)
      tools.ts      # wrappers tipados: listAddresses, searchOffers, getItem...
    domain/
      normalize.ts  # item MCP → NormalizedItem (campos ausentes marcados)
      constraints.ts# modelo de restrições + validação heurística
      pricing.ts    # composição de preço, promo, mínimo do lojista
      ranking.ts    # score explicável
      explain.ts    # gera motivos/avisos por recomendação
    routes/
      recommend.ts  # POST /api/recommend (pipeline E2E)
  web/              # React: contexto → resultados → detalhe
docs/requirements.md  # requisitos detalhados (fonte da verdade)
fixtures/             # respostas reais salvas p/ testes offline
```

## Convenções
- Dinheiro: number decimal BRL (ex.: `32.9`); enums `SCREAMING_SNAKE_CASE`; JSON `lowerCamelCase`.
- IDs sempre UUID vindos do MCP; em testes, fixtures de respostas reais — nunca IDs fabricados em produção.
- Pipeline de recomendação é função pura testável (`domain/*` não faz fetch).
