# Retirada local do legado — 20/10/2026

Etapa escolhida pelo usuário após a composição/seleção da sacola. Alteração na árvore local baseada em `3bcd4d8`, sem declaração de commit, merge remoto ou deploy.

## Superfícies atuais

- `conversation-runtime.ts` monta somente `assistant/`, com roteador e planejador Gemini sobre `ai/gemini.ts`. Sem `CONVERSATION_MODEL_ENABLED=true`, não instala processador; chave incidental não ativa o modelo.
- `assistant/bag.ts` reutiliza `domain/group.ts`: candidatos detalhados e elegíveis alimentam propostas DATA-01 persistidas e numeradas. A escolha digitada seleciona a sacola; não prepara carrinho remoto.
- CART-01 permanece em `cart/write-*`, `cart/presentation.ts` e `routes/cart-write.ts`. `cart/contracts.ts`, schemas e evidências observadas foram preservados. A revisão exige opt-in próprio, evidência externa e confirmação humana PREPARE_CART.
- OAuth continua por vínculo em `links/` e `IfoodAuth`. `/` e `/callback` mantêm a conclusão no navegador; raiz sem callback informa o canal Telegram.
- Cada chamada MCP exige cliente explícito do vínculo, sem fallback/sessão singleton.

## Retirado

- `agent/`: vocabulário fechado, política, renderer, modelo determinístico e corpus/demo; scripts `eval:agent` e `ai:demo:*`.
- F7 em memória (`cart/service.ts`, `catalog.ts`, `approval.ts`) e todas as rotas `/api/bot/cart` (404 após autenticação).
- Provedor de sugestões específico do intérprete antigo (`services/group.ts`); composição pura do domínio preservada.
- Sessão global de desenvolvimento: `/api/auth/*`, `/api/diagnostics/search`, autenticação global e importação de tokens OpenCode. O diagnóstico básico continua sem chamadas MCP.
- Painel `src/web/`, Vite/React como dependências diretas, proxy e scripts de frontend. Vite pode permanecer como dependência transitiva do Vitest.

## Configuração e armazenamento

Remova `CONVERSATION_AGENT_MODE`, `IFOOD_CART_ENABLED`, `DEV_GLOBAL_SESSION`, `WEB_ORIGIN` e `IFOOD_TOKEN_FILE`. `structured` e as flags antigas com `true` falham com motivo explícito; `assistant` antigo é aceito para transição, sem instalar outro caminho.

Use `.env.example` e os opt-ins separados de runtime/modelo/CART-01. `npm run dev` inicia somente a API; `npm run build` faz a validação TypeScript, e a execução continua via tsx. Nenhuma configuração externa foi lida ou alterada.

Tokens não são apagados/importados; IfoodAuth só persiste com caminho explícito. A retirada inicial usava a variante local v5. A reconciliação posterior encontrou outra v5 publicada e instalou [v6](armazenamento-v6.md), preservando ambas e bloqueios de intenções. [Estado da integração](sincronizacao-github.md).

## Verificação e limites de evidência

Executar `npm run typecheck`, `npm run lint`, `npm test` e `npm run build`. Testes exclusivos do intérprete/F7 retirados; verificações úteis migradas para assistente/transporte atual: orçamento/uso/privacidade, rejeição de configurações antigas, queda real de processo, replay e correção concorrente. Auditorias puras de composição e contratos CART-01 permanecem.

Executado localmente em 20/10: typecheck, lint e build aprovados; suíte completa com **54 arquivos, 953 testes aprovados e 2 ignorados**. O lockfile foi atualizado offline para acompanhar a remoção das dependências diretas do painel. A CI existente continua usando `npm ci` e os mesmos quatro comandos; execução remota da CI não foi consultada.

Testes usam OAuth, Gemini e MCP sintéticos; não confirmam conta iFood real, outputs externos, configuração de produção, volume, deploy ou jornada online no Telegram. Relatórios AI-01/AI-02/F7 antigos são históricos. O fio do novo fluxo de sacola às revisões/callbacks CART-01 do bot ainda requer integração/verificação própria.
