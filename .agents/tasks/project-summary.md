# Resumo do projeto — Compra com Contexto (SEMCOMP × iFood)

Reconciliação em 20/10 sobre origin/main@f6ef20e, em worktree isolado. Commit funcional `853adf2`; publicação de branches/PRs draft autorizada, sem merge/deploy nem consulta de produção/volumes. [Estado](../../docs/estado-remoto-local.md) e [sincronização](../../docs/sincronizacao-github.md).

## Produto e limites

API de recomendação e conversa coletiva com restrições alimentares, orçamento, preferências, ranking explicado, participantes, propostas e composição de sacola. A integração Telegram permite vincular a conta iFood e acompanhar operações persistidas.

A CART-01 implementa preparação de itens após revisão e PREPARE_CART. Está desligada por padrão e exige runtime, manifesto de evidência e callback BOT-03 validado para ativação real. Login/senha/modelo não autorizam escrita. Envio/pagamento continuam bloqueados; BUY-01/02 pendentes. F7, painel, sessão global e intérprete antigo foram retirados. O assistente gera propostas numeradas e aceita escolha digitada para sacola local; integração dessa experiência às revisões do bot ainda precisa ser verificada.

## Arquitetura

| Área | Implementação |
| --- | --- |
| Entrada HTTP | `src/server/index.ts`, factory Hono em `src/server/app.ts` |
| Configuração e autenticação do bot | `config.ts`, `botAuth.ts`: Bearer e identidade validada pelo adaptador; allowlist ou opt-in de senha |
| OAuth e vínculos | `auth.ts`, `links/`, `routes/bot.ts`: tokens, sessão MCP e cache isolados por vínculo |
| MCP | `mcp/client.ts`, `mcp/tools.ts`: descoberta/leitura; `mcp/cart.ts`: fronteira de carrinho confirmada |
| Domínio puro | `domain/`: campos, normalização, restrições, configuração, preço, ranking, dinheiro, limites, compra e grupo |
| Avaliação | `services/evaluate.ts`, `routes/evaluate.ts`, `services/evaluate-view.ts`, `services/cents.ts` |
| Conversa | `turns/`, `routes/conversation.ts`: fila, replay, cancelamento, leases e recuperação SQLite |
| IA e memória | `assistant/`, `ai/`, `conversation-runtime.ts`: audiência sem fatos, contexto seletivo e consultas Gemini opt-in |
| Carrinho confirmado | `cart/write-*`, `routes/cart-write.ts`: revisão, confirmação, intenção e resultado remoto |
| Operação | `ops/`: logs sanitizados, métricas, orçamento e permissões de armazenamento |
| Interface | Bot Telegram; callback de vínculo conclui no navegador, sem painel |

Caminhos relativos a `src/server/`, exceto quando incluem `src/`. Stack: Node >=22.13, TypeScript strict, Hono, MCP SDK, Zod, Vitest/ESLint. SQLite nativo; um processo da API e volume persistente. MCP sempre por cliente explícito do vínculo, sem singleton.

## Dinheiro, restrições e ranking

- Dinheiro no domínio e no contrato do bot é centavos inteiros seguros. BRL decimal do MCP é convertido na fronteira de normalização. `toDomainRequest` preserva centavos; `services/cents.ts` apenas projeta nomes `*Cents`, sem dividir ou multiplicar novamente.
- `getItem` precede recomendação/preço detalhado. Ausente, null, inválido e vazio têm significados distintos. Preço ambíguo vira faixa; custo desconhecido não vira zero nem total confirmado.
- Restrições usam PASS/FAIL/UNKNOWN. Alergia sem evidência suficiente permanece bloqueada; preferências não viram restrições obrigatórias.
- `domain/ranking.ts` e o pipeline de avaliação implementam ranking explicado dos elegíveis. Prioridade ausente exige esclarecimento; candidatos bloqueados ou pendentes de verificação não viram recomendações.

## Login iFood

1. O adaptador autenticado solicita `POST /api/bot/ifood/connect` para o organizador validado.
2. O primeiro navegador que abre o link reivindica a tentativa por cookie; state, PKCE e prazo protegem o callback. Loopback é exigido quando `PUBLIC_BASE_URL` é local.
3. O callback chama `completeBrowserAuthorization`, troca o código e instala o vínculo pelo caminho transacional de confirmação. O fluxo normal não exige segundo clique Telegram.
4. `listAddresses` verifica a capacidade operacional. Falha de rede preserva o vínculo e pode deixá-lo indisponível; refresh recusado exige reconexão. Consulta de status não executa chamadas ao iFood.
5. `AWAITING_CONFIRMATION` e `/confirm` permanecem para compatibilidade/recuperação. O bot só chama a confirmação manual após clique humano, nunca por polling.

O link inicial é uma capacidade privada: não compartilhar. Cookie/PKCE não provam que dois dispositivos são da mesma pessoa. Tokens nunca saem na API/UI; a identidade exibida é mascarada. O redirect deve coincidir com o cadastro OAuth do ambiente, sem impor localhost ao serviço online.

## Persistência, replay e retenção

Vínculos OAuth usam IFOOD_LINKS_DIR e tentativas ficam em RAM. SQLite atual **v6** unifica variantes v5, preservando domínio, eventos, memória ou grupos antigos e intenções. Sem importação automática de grupos como SELF; binários v5 e anteriores recusam v6. O bot conserva sessionRef por evento/replay; sem cabeçalho há compatibilidade sem associação. [Migração](../../docs/armazenamento-v6.md).

CART-01 consome confirmação e grava intenção antes da rede; replay consulta o resultado e não repete escrita. PENDING/RESULT_UNKNOWN bloqueiam novas mutações. A recuperação não retoma chamadas remotas. O expurgo permitido remove dados da compra, revisões, composição e snapshot remoto, preservando tombstones técnicos para impedir replay; trabalho pendente ou efeito externo não resolvido bloqueia o expurgo. Política D7: encerramento ou 24 h sem evento aceito; logs e backups dependem também da retenção operacional.

Rollback completo da conversa exige `CONVERSATION_RUNTIME_ENABLED=false`, `CONVERSATION_MODEL_ENABLED=false` e `IFOOD_CONFIRMED_CART_WRITES_ENABLED=false`, com reinício. Lista `CONVERSATION_ORGANIZER_IDS` vazia/ausente libera todos os usuários admitidos pela autenticação: remover o último ID não desativa a conversa. Rollback não rebaixa schema nem apaga intenções desconhecidas.

## Execução e verificação

```text
npm ci
# Copiar .env.example para .env e preencher apenas o necessário ao ambiente.
npm run dev
npm run typecheck
npm run lint
npm test
npm run build
```

Runtime, modelo e escrita confirmada têm opt-ins separados. Sessão global e CLIs antigos de smoke/avaliação foram retirados; flags antigas com true e modo structured são recusados. Usar ambiente explicitamente configurado, sem ler configs pessoais. `dev` inicia API; `build` valida TypeScript, execução via tsx.

A CI executa typecheck, lint, testes e build em Windows/Ubuntu e Node 22.13/24. Testes usam fixtures e transportes sintéticos conforme o recorte; não presumir que toda fixture é captura real. Contagens históricas não substituem execução sobre a árvore atual. Este resumo não declara uma nova execução de testes.

## Guias de referência

- [Contrato do bot e login](../../docs/bot-api.md)
- [Contrato de conversa](../../docs/conversation-api-v1.md) e [runtime](../../docs/runtime-turnos.md)
- [Dinheiro e limites](../../docs/dom-01-centavos-limites.md), [ranking](../../docs/ranking.md), [DATA-01](../../docs/data-01-compra.md) e [GRP-01](../../docs/grp-01-propostas.md)
- [Assistente](../../docs/assistente-conversacional.md), [armazenamento v6](../../docs/armazenamento-v6.md) e [retirada do legado](../../docs/retirada-legado.md); AI-02/ensaios antigos são históricos
- [Carrinho confirmado](../../docs/cart-01-escrita-confirmada.md)
- [Persistência OPS-01](../../docs/ops-01-persistencia.md) e [operação OPS-02](../../docs/ops-02-operacao.md)

Uma instância, tokens sem criptografia em repouso e ensaios operacionais pendentes continuam limitações. Evidência externa INT-02 e integração humana BOT-03 exigem verificação antes de ativação; envio/pagamento dependem de trabalho futuro. Baseline, fixtures/hashes e snapshots históricos permanecem preservados.
