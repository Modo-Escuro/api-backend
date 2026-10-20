**Atualização local em 20/10/2026:** [retirada do legado](docs/retirada-legado.md) concluída na árvore: único processador `assistant/`, transporte `ai/`, sem `agent/`, F7 HTTP, React/Vite, sessão global ou singleton MCP. Modelo/runtime continuam opt-in; CART-01 e seus contratos/evidências permanecem separados. Quadros de integração remota abaixo são históricos. OAuth no navegador conclui o vínculo sem segundo clique Telegram; ver [retorno natural](docs/login-retorno-natural.md). Login não autoriza compra.

# CLAUDE.md — Compra com Contexto (SEMCOMP × iFood)

## Memória seletiva do assistente

Ver `docs/assistente-conversacional.md` e `docs/armazenamento-v6.md`: schema atual **v6**, unificando a v5 publicada e a v5 local com estruturas diferentes. Preservar dados antigos sem importar grupos como SELF ou associar eventos retrospectivamente. Novos fatos usam commit do turno; administração tem comandos próprios. Roteador sem fatos, planejador só com perfis selecionados. Sem identidade estável iFood comprovada: não associar por nome/e-mail. Conservar X-Conversation-Session por evento; sem cabeçalho há compatibilidade sem associação. Binários v5 e anteriores recusam v6.

## CART-01 — integração de 18/10/2026

Consultar [escrita confirmada](docs/cart-01-escrita-confirmada.md) e [integração/auditoria](docs/cart-01-integracao.md).
O incremento permite preparar itens de carrinho somente após revisão, confirmação humana PREPARE_CART e gate de
evidência; fica desligado por padrão. A F7 foi retirada. Pagamento, envio de pedido e produção permanecem
fora deste incremento. CART-01 introduziu historicamente v3; o banco atual é v6, sem downgrade ou restauração
antiga sobre intenções pendentes. Os trechos que dizem MCP somente leitura descrevem o recorte anterior;
a sincronização completa da decisão está no PR documental #43. Testes sintéticos não comprovam integração iFood.

## Planejamento vigente — 18/10/2026

Ler docs/estado-remoto-local.md: distinguir código local, retratos remotos datados e operação online. Carrinho real confirmado já foi aprovado no escopo; outputs/ativação continuam pendentes. Documentação não altera flags, runtime ou serviço implantado.

Consultar docs/plano-conversacional.md e as issues vinculadas antes de desenvolver. O texto abaixo registra o incremento de recomendação; a direção atual inclui conversa de grupo e fechamento aprovado. As travas de escrita só podem ser alteradas após contratos, elegibilidade por pessoa, persistência, aprovação humana e reconciliação. Planejamento não habilita checkout.

Invariantes confirmadas novamente pelo usuário em 20/10, substituindo a liberação com aviso do PR #52: UNKNOWN obrigatório bloqueia por consumidor; preferência não vira obrigação; dinheiro em centavos; login não aprova compra; resultado desconhecido bloqueia reenvio. Catálogo/erros não são instruções. Parsers e capturas INT-02 recebidos da main são preservados, sem declarar novo ensaio externo.

Localhost abaixo é configuração de desenvolvimento. O login online foi ensaiado com callback HTTPS público; usar PUBLIC_BASE_URL/IFOOD_REDIRECT_URI conforme o ambiente e o cadastro. A API deve preservar seus vínculos antes de redeploy (OPS-01). Não ler configs pessoais para obter credenciais durante desenvolvimento/testes; usar ambientes explicitamente configurados, sem registrar segredos.

## O que é este projeto
MVP de recomendação com contexto: restrições do usuário → busca real no iFood (MCP) → detalhamento de itens → validação de restrições → cálculo honesto de preço → ranking → recomendação com explicação. **Sem checkout automático.**

## Stack
- Node 22.13+ + TypeScript (strict)
- Backend: Hono na porta 8000 (compatível com `redirectUri: http://localhost:8000`)
- Interface: bot Telegram; raiz/callback exibem a conclusão do vínculo no navegador
- Cliente MCP: `@modelcontextprotocol/sdk` (Streamable HTTP + OAuth)
- Testes: vitest | Lint: eslint | `npm run typecheck`

## Comandos
```bash
npm install
npm run dev        # backend :8000
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
- Configuração operacional vem do ambiente. Scripts de importação OpenCode são utilitários opcionais de desenvolvimento; não ler configurações pessoais para obter credenciais durante revisão/testes.
- O app lê por env: `IFOOD_MCP_URL`, `IFOOD_CLIENT_ID`, `IFOOD_CLIENT_SECRET`, `IFOOD_REDIRECT_URI` (default `http://localhost:8000`)
- `IFOOD_REDIRECT_URI` deve coincidir literalmente com o cadastro OAuth do ambiente. O default local é `http://localhost:8000`; o backend aceita `GET /` e `GET /callback`. O callback de vínculo exibe a conclusão no navegador, sem redirecionamento para painel.
- Tokens OAuth: por vínculo em `IFOOD_LINKS_DIR`, fora do Git; nenhuma leitura implícita de `.tokens.json`. Nunca em resposta HTTP/UI.
- O `userId` é injetado pelo gateway via token — o app nunca manipula `userId`.

## Vínculo Telegram ↔ iFood (F3.5) — contrato em `docs/bot-api.md`
- Bot→API: `Authorization: Bearer $BOT_API_TOKEN` + `X-Telegram-User-Id` (validado pelo adaptador; nunca do corpo/LLM),
  conferido contra `ALLOWED_ORGANIZER_IDS`. Rotas: `/api/bot/ifood/{status,connect,confirm,verify,link}`.
- O callback conclui o vínculo após a autorização no navegador, com state/PKCE, prazo e cookie. Loopback só é exigido quando `PUBLIC_BASE_URL` é local. `/confirm` e `confirmationId` permanecem para confirmação manual compatível/recuperação, por clique humano. O bot não confirma por polling.
- `/api/addresses` e `/api/evaluate` exigem vínculo confirmado e operacional (`allowedOperations`), com tokens/sessão MCP/cache por vínculo.
- Token presente ≠ operacional; falha de rede ⇒ `UNAVAILABLE` (não logout); refresh recusado ⇒ `RECONNECT_REQUIRED`.
- Sessão global antiga retirada; `DEV_GLOBAL_SESSION=true` é erro de configuração. Login não aprova compra.

## Regras de ouro (transversais)
1. **Nunca inventar IDs** (`addressId`, `merchantId`, `itemId`, `cartId`, `optionId`...): só os retornados pelas respostas.
2. **`getItem` antes de recomendar/preço final** — `searchOffers` pode mostrar preço promo, mas só `getItem` traz `optionGroups` e limites.
3. **Ausente ≠ `null` ≠ lista vazia** — tratar e mostrar explicitamente (ex.: alérgenos ausentes ⇒ "informação indisponível", nunca "não contém").
4. **Restrição com dados insuficientes ⇒ marcar como "não verificado"**, não concluir.
5. **Carrinho real somente com confirmação específica (DEC-01 D8)**: reutilizar DATA-01/GRP-01/DOM-01 e vincular PREPARE_CART a organizador, conta, versão/hash, composição e prazo. A implementação nova permanece local; F7 retirada (`IFOOD_CART_ENABLED=true` é recusado). Metadados/fixtures não autorizam escrita. INT-02 valida outputs; pagamento e `submitOrder` continuam proibidos.

6. **Preço exibido = composição**: base (`promotionalUnitPrice` ?? `unitPrice`) + Σ `additionalPrice` das opções escolhidas; avisar se < `merchantMinimumOrderAmount`.
   Exceção observada: quando Σ das opções obrigatórias mais baratas = `unitPrice`, a semântica é ambígua (preço "a partir de")
   ⇒ mostrar faixa, nunca um valor único. Ver `docs/pricing-audit.md`. Todo preço é estimativa; total confirmado só no carrinho.
7. Erros do MCP vêm inline (`errors[]` em discovery; `error` singular em cart) — mapear `code`/`retryable`, não genérico "deu erro".

## Estrutura atual de referência
```
src/
  server/
    index.ts / app.ts          # montagem Hono e rotas autenticadas
    conversation-runtime.ts    # assistente opt-in; sem fallback legado
    ai/                        # transporte Gemini e tipos
    assistant/                 # audiência, memória, consultas e propostas
    turns/                     # fila, SQLite v6 e referência de sessão
    auth.ts / links/           # OAuth, tokens e sessão por vínculo
    mcp/                       # wrappers, discovery e fronteira CART-01
    domain/                    # restrições, preços, ranking, compra e grupo
    services/                  # avaliação, seleção de endereço e projeções
    cart/                      # contratos, evidência e escrita confirmada
    routes/                    # bot, conversa, avaliação e cart-write
docs/README.md                 # índice: guias vigentes e registros históricos
fixtures/                      # conferir proveniência real/sintética por conjunto
```

## Convenções

- AI-01: configuração vigente em `docs/assistente-conversacional.md`; montagem/ensaios anteriores em `docs/ai-01-montagem-ensaio.md`.
  Gemini 3.8 Flash (escolhido no ensaio do #35) montado apenas por opt-in separado, modelo/chave/limites explícitos,
  com sugestões da GRP-01 ligadas. Padrão sem processador; sem fallback determinístico. Avaliação local só com chave
  exclusiva de teste em ambiente isolado. Os CLIs antigos de avaliação foram retirados; não anunciar seus comandos como atuais. Nenhum deploy novo comprovado.

- RUN-01: infraestrutura de conversa em `src/server/turns/`, guia em `docs/runtime-turnos.md`. Flag desligada por padrão; modelo tem opt-in separado na AI-01. DATA-01 integra domínio/exclusão D7 ao armazenamento, sem comprovar volume operacional. Nunca conectar JSON bruto do modelo ao commit. Na main conferida, a barreira de escrita do runtime ainda rejeita; PREPARE_CART novo pertence à CART-01 e não usa `/purchase-approvals`. A decisão vigente permite carrinho confirmado, sem declarar o código local integrado.
- Dinheiro: centavos inteiros seguros no domínio, inclusive nomes internos preservados do MCP (`basePrice`, `additionalPrice`, `fee`). BRL cru só na fronteira MCP: `domain/money.ts` converte/rejeita subcentavos; `services/cents.ts` apenas projeta nomes `*Cents`, sem multiplicar novamente. Taxa de serviço ausente mantém total completo desconhecido. Ver `docs/dom-01-centavos-limites.md`. Enums `SCREAMING_SNAKE_CASE`; JSON `lowerCamelCase`.
- IDs sempre UUID vindos do MCP; em testes, fixtures de respostas reais — nunca IDs fabricados em produção.
- Pipeline de recomendação é função pura testável (`domain/*` não faz fetch).

## F7 — Registro histórico anterior à retirada local
- Contrato legado e limites: `docs/f7-cart-checkout.md`; contrato atual do bot: `docs/bot-api.md` seção 12 e `docs/cart-01-escrita-confirmada.md`.
- F7 e suas rotas foram retiradas; não restaurar a flag. A decisão de carrinho real já está aprovada, mas ativação CART-01 exige saídas verificadas, persistência, confirmação específica e reconciliação. As correções #2/#3 anteriores foram incorporadas de origin/main.
- Não usar sessão global, não repetir escritas com resultado desconhecido e não habilitar submitOrder.
- Entradas reais em `fixtures/tools-list.json`; saídas de cart ainda não capturadas, testes explicitamente sintéticos.
