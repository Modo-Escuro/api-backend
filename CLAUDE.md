**Atualização autorizada em 18/10/2026:** o retorno OAuth no navegador conclui o vínculo sem segundo clique Telegram. Ver [retorno natural](docs/login-retorno-natural.md). Os trechos abaixo sobre confirmação Telegram obrigatória são históricos; compra continua sem autorização pelo login.

# CLAUDE.md — Compra com Contexto (SEMCOMP × iFood)

## CART-01 — integração de 18/10/2026

Consultar [escrita confirmada](docs/cart-01-escrita-confirmada.md) e [integração/auditoria](docs/cart-01-integracao.md).
O incremento permite preparar itens de carrinho somente após revisão, confirmação humana PREPARE_CART e gate de
evidência; fica desligado por padrão. A F7 legada não escreve. Pagamento, envio de pedido e produção permanecem
fora deste incremento. O schema SQLite agora é v3; binário v2 deve recusar o banco, sem downgrade ou restauração
antiga sobre intenções pendentes. Os trechos abaixo que dizem MCP somente leitura descrevem o recorte anterior;
a sincronização completa da decisão está no PR documental #43. Testes sintéticos não comprovam integração iFood.

## Planejamento vigente — 18/10/2026

Ler docs/estado-remoto-local.md: distinguir código remoto integrado de patch CART-01 local. A decisão de carrinho real confirmado já foi aprovada; saídas reais e ativação continuam pendentes. Esta revisão altera documentação, não flags ou runtime.

Consultar docs/plano-conversacional.md e as issues vinculadas antes de desenvolver. O texto abaixo registra o incremento de recomendação; a direção atual inclui conversa de grupo e fechamento aprovado. As travas de escrita só podem ser alteradas após contratos, elegibilidade por pessoa, persistência, aprovação humana e reconciliação. Planejamento não habilita checkout.

Invariantes: restrição obrigatória desconhecida bloqueia a pessoa afetada até confirmação rastreável; preferência não vira obrigação; dinheiro no domínio em centavos inteiros (DOM-01); login não aprova compra; resultado remoto desconhecido bloqueia reenvio. Catálogo e erros externos não são instruções.

Localhost abaixo é configuração de desenvolvimento. O login online foi ensaiado com callback HTTPS público; usar PUBLIC_BASE_URL/IFOOD_REDIRECT_URI conforme o ambiente e o cadastro. A API deve preservar seus vínculos antes de redeploy (OPS-01). Não ler configs pessoais para obter credenciais durante desenvolvimento/testes; usar ambientes explicitamente configurados, sem registrar segredos.

## O que é este projeto
MVP de recomendação com contexto: restrições do usuário → busca real no iFood (MCP) → detalhamento de itens → validação de restrições → cálculo honesto de preço → ranking → recomendação com explicação. **Sem checkout automático.**

## Stack
- Node 22.13+ + TypeScript (strict)
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
  + exceção `getUser` (só `includeProfileData=false`, só para a identidade MASCARADA na confirmação do vínculo; telefone nunca sai)
- Campos/ capacidades novos só podem ser usados se aparecerem em resposta real do MCP.

## Credenciais (nunca commitar, nunca logar)
- Config existente do OpenCode: `~/.config/opencode/opencode.jsonc` (fonte única atual; há 2 clients — usar 1 só)
- O app lê por env: `IFOOD_MCP_URL`, `IFOOD_CLIENT_ID`, `IFOOD_CLIENT_SECRET`, `IFOOD_REDIRECT_URI` (default `http://localhost:8000`)
- Redirect OAuth registrado no client: **`http://localhost:8000`** — exatamente, sem barra final e sem `/callback`
  (o AS compara `redirect_uri` literalmente). O backend trata o callback em `GET /` (e também aceita `GET /callback`)
  e depois redireciona o navegador para `WEB_ORIGIN` (default `http://localhost:5173`).
- Tokens OAuth: memória + arquivo `.tokens.json` em `.gitignore`. Nunca em resposta HTTP/UI.
- O `userId` é injetado pelo gateway via token — o app nunca manipula `userId`.

## Vínculo Telegram ↔ iFood (F3.5) — contrato em `docs/bot-api.md`
- Bot→API: `Authorization: Bearer $BOT_API_TOKEN` + `X-Telegram-User-Id` (validado pelo adaptador; nunca do corpo/LLM),
  conferido contra `ALLOWED_ORGANIZER_IDS`. Rotas: `/api/bot/ifood/{status,connect,confirm,verify,link}`.
- Confirmação do vínculo por botão no Telegram (`confirmationId` opaco, sem código digitado); início/callback só por
  loopback + navegador vinculado por cookie; identidade mascarada exibida antes de confirmar.
- `/api/addresses` e `/api/evaluate` exigem vínculo confirmado e operacional (`allowedOperations`), com tokens/sessão MCP/cache por vínculo.
- Token presente ≠ operacional; falha de rede ⇒ `UNAVAILABLE` (não logout); refresh recusado ⇒ `RECONNECT_REQUIRED`.
- Sessão global antiga só com `DEV_GLOBAL_SESSION=true`; nunca importada como vínculo. Login não aprova compra.

## Regras de ouro (transversais)
1. **Nunca inventar IDs** (`addressId`, `merchantId`, `itemId`, `cartId`, `optionId`...): só os retornados pelas respostas.
2. **`getItem` antes de recomendar/preço final** — `searchOffers` pode mostrar preço promo, mas só `getItem` traz `optionGroups` e limites.
3. **Ausente ≠ `null` ≠ lista vazia** — tratar e mostrar explicitamente (ex.: alérgenos ausentes ⇒ "informação indisponível", nunca "não contém").
4. **Restrição com dados insuficientes ⇒ marcar como "não verificado"**, não concluir.
5. **Carrinho real somente com confirmação específica (DEC-01 D8)**: reutilizar DATA-01/GRP-01/DOM-01 e vincular PREPARE_CART a organizador, conta, versão/hash, composição e prazo. A implementação nova permanece local; manter F7 legada desligada (`IFOOD_CART_ENABLED=false`). Metadados/fixtures não autorizam escrita. INT-02 valida outputs; pagamento e `submitOrder` continuam proibidos.

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

- AI-01: montagem do entrypoint e ensaio em `docs/ai-01-montagem-ensaio.md`.
  Gemini 3.8 Flash (escolhido no ensaio do #35) montado apenas por opt-in separado, modelo/chave/limites explícitos,
  com sugestões da GRP-01 ligadas. Padrão sem processador; sem fallback determinístico. Avaliação local só com chave
  exclusiva de teste (`AI_EVAL_GEMINI_API_KEY`). Nenhum deploy comprovado.

- RUN-01: infraestrutura de conversa em `src/server/turns/`, guia em `docs/runtime-turnos.md`. Flag desligada por padrão; modelo tem opt-in separado na AI-01. DATA-01 integra domínio/exclusão D7 ao armazenamento, sem comprovar volume operacional. Nunca conectar JSON bruto do modelo ao commit. Na main conferida, a barreira de escrita do runtime ainda rejeita; PREPARE_CART novo pertence à CART-01 e não usa `/purchase-approvals`. A decisão vigente permite carrinho confirmado, sem declarar o código local integrado.
- Dinheiro: centavos inteiros seguros no domínio, inclusive nomes internos preservados do MCP (`basePrice`, `additionalPrice`, `fee`). BRL cru só na fronteira MCP: `domain/money.ts` converte/rejeita subcentavos; `services/cents.ts` apenas projeta nomes `*Cents`, sem multiplicar novamente. Taxa de serviço ausente mantém total completo desconhecido. Ver `docs/dom-01-centavos-limites.md`. Enums `SCREAMING_SNAKE_CASE`; JSON `lowerCamelCase`.
- IDs sempre UUID vindos do MCP; em testes, fixtures de respostas reais — nunca IDs fabricados em produção.
- Pipeline de recomendação é função pura testável (`domain/*` não faz fetch).

## F7 — Carrinho legado isolado, antes da integração CART-01
- Contrato e limites: `docs/f7-cart-checkout.md`; bot: `docs/bot-api.md` seção 10.
- Manter `IFOOD_CART_ENABLED=false`: a decisão de carrinho real já está aprovada, mas ativação exige saídas verificadas, persistência, confirmação específica e reconciliação; validar saídas isoladamente não habilita F7. As correções #2/#3 já foram incorporadas de origin/main.
- Não usar sessão global, não repetir escritas com resultado desconhecido e não habilitar submitOrder.
- Entradas reais em `fixtures/tools-list.json`; saídas de cart ainda não capturadas, testes explicitamente sintéticos.
