# OPS-02 — Observabilidade, limites, retenção e liberação gradual

[Issue #21](https://github.com/Modo-Escuro/api-backend/issues/21) · [DEC-01 D7/D8](decisoes-conversacionais.md) · [RUN-01](runtime-turnos.md) · [AI-02](ai-02-agente.md) · [OPS-01](ops-01-persistencia.md)

## Estado deste incremento

Atualização documental de 18/10/2026: PR #38 mergeado na main conferida `f3b8b55`; issue #21 continua aberta pelo alcance parcial e ensaios abaixo. A [DEC-01 vigente](decisoes-conversacionais.md) já permite PREPARE_CART confirmado. O código CART-01 auditado permanece local e separado desta revisão; a preparação real exige integração e INT-02 #40. Envio e pagamento continuam proibidos.

Entrega parcial, integrada à GRP-01 e à AI-01 (Gemini, #36). O que não depende de CART-01 foi implementado e testado offline: logs estruturados, métricas agregadas, orçamento de execução/gasto do modelo, status operacional separado, liberação gradual por organizador, verificação de permissões de storage e regressões de rollback. A CART-01 (dependência da issue) não está concluída. Por isso, a instrumentação de sacola/envio se limita a reportar `DISABLED`. Nada neste código OPS-02 habilita escrita no MCP. A decisão aprovada de carrinho confirmado não instala o executor nem substitui seus gates.

## Logs (`src/server/ops/log.ts`)

Uma linha JSON por evento: `{ts, level, event, ...campos}`. **Allowlist** de campos: `cid`, `component`, `method`, `route`, `status`, `durationMs`, `queueMs`, `tool`, `code`, `outcome`, `retryable`, `count`, `kind`, `errorName`, `reason`, `state`, contadores de tokens/expurgo. Qualquer outro campo é descartado (contado em `dropped`).

Strings só passam se parecerem código curto. São redigidas (`[redigido]`) quando têm espaço, `@`, `=`, `+`, 6 ou mais dígitos no total (telefone, CPF, cartão, ID do Telegram, mesmo com separadores), início de JWT ou bloco base64url aleatório. É o mesmo conteúdo autorizado pela D7: correlação opaca, rota, ferramenta MCP, código de status/erro, latência e contadores.

- Requisição: `http.request` com `cid`, método, **padrão da rota casada** (ex.: `/api/bot/v1/conversations/:conversationId/events`, `/api/bot/*`), status e duração. O caminho bruto nunca é usado: o conjunto de rótulos é fechado e definido no código, então requisições não autenticadas a caminhos arbitrários não criam séries nem levam IDs ao log. Rota não casada ou 404 vira `[nao-mapeada]`. O `cid` é aleatório por requisição, não deriva de identidade e é devolvido em `X-Correlation-Id`; um `X-Correlation-Id` enviado pelo cliente é ignorado.
- Erro 500: `http.unhandled_error` registra só a classe e o `code` em formato de enum. **A resposta passou a ter mensagem fixa** (`Erro interno` + `correlationId`). A exceção bruta não aparece mais no log nem no corpo.
- Agente: `agent.turn_failed` (código) e `agent.budget_exceeded` (tipo de limite).
- Turnos: `turns.operation_finished` (resultado e duração), `turns.runtime_unhealthy`, `retention.purge_failed`.
- Inicialização: `storage.permissions` e `config.submit_flag_ignored`.

Os `console.*` antigos (auth, links, storage) já registravam só códigos e continuam como estão. Um teste estático impede que um `console.*` registre `.message`, a exceção ou `JSON.stringify` de payload.

## Métricas (`src/server/ops/metrics.ts`)

Ficam em memória por processo e zeram ao reiniciar. Os rótulos permitidos são `route`, `method`, `statusClass`, `tool`, `code`, `outcome`, `kind` e `component`. Rótulos de identidade são ignorados, e há um teto de 500 séries (`droppedSeries`). Nenhuma série é por pessoa, conversa ou vínculo. Por isso, não formam histórico pessoal.

| Métrica | O que mede |
| --- | --- |
| `http_requests_total`, `http_request_duration_ms` | Volume, classe de status e latência por rota |
| `mcp_tool_calls_total{tool,outcome,code}`, `mcp_tool_duration_ms` | Chamadas de leitura MCP, erros inline (`TOOL_ERROR` + código) e de transporte |
| `turn_queue_wait_ms`, `turn_run_duration_ms`, `turn_operations_total{outcome}` | Fila, execução e resultado dos turnos |
| `model_calls_total`, `model_call_duration_ms`, `model_tokens_total{kind}` | Chamadas ao modelo e tokens (`input`, `output` ou `reserved_unreported` quando o provedor não reporta) |
| `model_cost_micro_usd_total` | Custo estimado do Gemini pelo preço de referência do adaptador (não é fatura) |
| `agent_turns_total`, `agent_budget_exceeded_total{kind}` | Resultado do agente e paradas por orçamento |
| `retention_purged_total`, `retention_purge_failed_total` | Expurgo D7 |

O estado desconhecido sai de `TurnStore.stats().resultUnknown`, uma contagem persistida e não volátil.

## Status operacional: `GET /api/ops/status`

Exige o mesmo `BOT_API_TOKEN` e um organizador autorizado, e responde com `Cache-Control: no-store`. Os números são agregados do processo inteiro, não do organizador que consulta: qualquer organizador autorizado vê as mesmas contagens. Devolve só contagens, sem caminhos ou identidades, e separa:

- `http`: o processo responde. Equivale ao `/api/health`, que continua 200 mesmo com o runtime parado.
- `linksStorage`: estado e durabilidade (OPS-01), mais `permissions`.
- `sessions`: `confirmed`, `operational` (última verificação OK), `unavailable`, `reconnectRequired`, `unverified`. A contagem usa o estado conhecido, sem chamada remota. Token presente ≠ operacional.
- `conversation`: `enabled`, `rollout`, `runtime` (`accepting`, `healthy`, `processorInstalled`, `storage` = `OK`/`UNAVAILABLE`/`CLOSED`, fila, `resultUnknown`, compras ativas), permissões do diretório do banco e resumo do orçamento.
- `purchase`: `capable: false`, `cartPreparation`, `submission: DISABLED`, `submitFlagIgnored`. Com CART-01 montada, preparação é `HUMAN_CONFIRMATION_REQUIRED` e motivo `PREPARE_CART_ONLY`; isso indica o caminho instalado, não evidência aprovada nem autorização de compra. Desligada, mantém o status anterior.

## Limites de execução/gasto (`src/server/ops/budget.ts`)

`SpendBudget` é opcional em `createAgentProcessor({ budget })`. Usa janela fixa (padrão 1 h) e tetos de chamadas e tokens por conversa (60 / 200 mil) e globais (2 000 / 4 milhões). Também limita o número de conversas acompanhadas (5 000; cheio ⇒ recusa).

1. Antes de chamar o provedor, reserva `estimativa da entrada + maxOutputTokens`.
2. Estourou ⇒ `ContractError('LIMIT_EXCEEDED')` **antes da chamada**. A operação termina `FAILED/LIMIT_EXCEEDED` (HTTP 429 no contrato), e o snapshot e a compra ficam na versão anterior. Assim que a janela vira, um novo evento continua do estado preservado (teste de regressão).
3. Depois da chamada, `ModelRequest.reportUsage` ajusta a reserva ao uso real. O adaptador Gemini (`agent/gemini-model.ts`) reporta os tokens de entrada e saída devolvidos pelo provedor e o custo calculado pelo preço de referência.
   - Recusa antes da rede (limite próprio do adaptador, prompt grande, configuração): reporta uso zero, a reserva é devolvida e só a chamada fica contada.
   - Timeout, rede ou HTTP de erro sem uso reportado: a reserva é mantida (conservador) e expira com a janela. Não fica presa além dela.
   - Cada reserva é ajustada uma única vez. Relato que chega depois do prazo do turno é ignorado, então nada é cobrado duas vezes.
4. Chaves são hashes da conversa. `sweep()` remove janelas vencidas (limpeza de referências).

Os valores padrão são proteções técnicas, não metas de produto, e devem ser calibrados com o custo observado do Gemini. `index.ts` cria um `SpendBudget` quando `CONVERSATION_MODEL_ENABLED=true` e passa o mesmo objeto a `createConversationRuntime` (agente) e a `createApp` (status).

Há dois conjuntos de limites, ambos em memória por processo e zerados ao reiniciar. Nenhum é teto financeiro durável nem global entre instâncias; o limite de cobrança fica no console do provedor.
- **OPS-02** (`SpendBudget`): chamadas e tokens por conversa e global, em janela de 1 h.
- **AI-01** (`CONVERSATION_MODEL_MAX_REQUESTS*`, `CONVERSATION_MODEL_BUDGET_MICRO_USD`): chamadas e micro-USD por processo, sem janela.

## Flags e liberação gradual

| Flag | Efeito | Padrão |
| --- | --- | --- |
| `CONVERSATION_RUNTIME_ENABLED` | Conversa v1 (RUN-01) | `false` |
| `CONVERSATION_ORGANIZER_IDS` | Restringe a conversa a um subconjunto de `ALLOWED_ORGANIZER_IDS`; quem está fora recebe `UNAVAILABLE`. Nunca amplia a autorização. Qualquer entrada inválida impede a API de iniciar (falha fechada, para não virar "todos") | ausente/vazio = todos os autorizados |
| `IFOOD_CART_ENABLED` | F7 legada (preparação de sacola). Manter `false` (DEC-01) | `false` |
| `IFOOD_CONFIRMED_CART_WRITES_ENABLED` | CART-01: exige banco, manifesto de evidência e revisão/clique específico; não libera pagamento/envio | `false` |
| `IFOOD_SUBMIT_ENABLED` | **Não existe como habilitação.** Se definido, é ignorado e reportado | — |

Rollout sugerido: (1) ligar a conversa com `CONVERSATION_ORGANIZER_IDS=<1 organizador de teste>`; (2) acompanhar `/api/ops/status` (fila, `resultUnknown`, `budget_exceeded`, erros MCP/modelo); (3) ampliar a lista; (4) esvaziar a lista só depois de QA-01.

**Rollback** = desligar a flag ou tirar o organizador da lista. Nenhuma migração é revertida e nada é apagado. O schema SQLite é aditivo (v1 → v2 → v3 com CART-01), e um binário antigo recusa versão mais nova sem substituí-la. Vínculos (`.ifood-links`), compras e `RESULT_UNKNOWN` continuam no disco e voltam a aparecer ao reativar (teste `rollback ... não apaga`). Binário anterior à CART-01 não abre banco v3: restaurar o binário compatível, nunca rebaixar `user_version` ou aplicar backup antigo sobre operação desconhecida.

## Retenção (D7)

| Dado | Onde | Retenção |
| --- | --- | --- |
| Compra/participantes/restrições | SQLite RUN-01 | Exclusão ao encerrar e `purge()` após 24 h inativa (DATA-01); escopos com `RESULT_UNKNOWN` são preservados pela implementação atual; minimização/tombstones do requisito D7 da CART-01 ainda não integrados |
| Logs técnicos | stdout da plataforma | **Até 7 dias**: configurar a retenção de logs do serviço (Railway). Não é aplicado pelo código |
| Métricas | memória | Até reiniciar o processo |
| Orçamento | memória | Janela (1 h) + `sweep()` |
| Backups | OPS-01 | Rotação de até 7 dias |

## Ensaios exigidos (não executados aqui)

Estes ensaios exigem plataforma ou conta real e não foram feitos neste incremento (regra: não alterar produção):

1. **Permissões na plataforma**: com o serviço implantado, conferir `linksStorage.permissions.state` e `conversation.storagePermissions.state` em `/api/ops/status`. Esperado `PRIVATE` em Linux/Railway. No Windows o resultado é sempre `UNVERIFIED_PLATFORM` e a ACL NTFS precisa ser conferida manualmente. O teste da CI afirma esse comportamento por plataforma, sem pular o teste.
2. **Backup/restauração**: seguir [runtime-turnos](runtime-turnos.md#configuração-e-operação) (parar, copiar o diretório inteiro com WAL/SHM, restaurar em ambiente isolado, `quick_check`, conferir `stats()`) e [OPS-01](ops-01-persistencia.md) para os vínculos.
3. **Indisponibilidade**: derrubar a rede do MCP e conferir `mcp_tool_calls_total{outcome=TRANSPORT_ERROR}` e `sessions.unavailable`, sem `reconnectRequired`.
4. **Refresh**: token expirado com refresh válido ⇒ continua `operational`. Refresh recusado ⇒ `reconnectRequired`.

## Integração com GRP-01 e AI-01

- **GRP-01** (main `8191a0f`): integrada nesta branch. O processador mantém a busca de propostas; a falha de sugestões passou a usar o log estruturado (`agent.proposals_unavailable`) e a métrica `agent_proposals_total`. As chamadas MCP da busca entram em `mcp_tool_calls_total`, mas **não** são cobradas pelo `SpendBudget`, que só conta chamadas ao modelo.
- **AI-01** (#36, mergeada em `dc448f9`): integrada. O orçamento entra pela montagem (`conversation-runtime.ts`) e o adaptador Gemini chama `reportUsage`. Regressões em `test/ops/gemini-integration.test.ts`, com rede sintética: uso real substituindo a reserva, `LIMIT_EXCEEDED` antes da chamada, limite global, recusa antes da rede, timeout, concorrência, reinício e status com logs sanitizados.

## Lacunas

- CART-01 nova ainda não está integrada nesta main (há implementação local auditada); BUY-01/02 continuam pendentes: não há métrica de sacola, intenção ou envio, e `purchase.capable` é constante.
- Orçamento e métricas são em memória e por processo; reiniciar zera a janela. Aceitável enquanto houver uma única instância (RUN-01). Para várias instâncias, persistir no SQLite.
- Não há exportador Prometheus/OTel; o JSON de `/api/ops/status` é a interface.
- A retenção de 7 dias dos logs depende da configuração da plataforma.
- O custo em micro-USD é estimado pelo preço de referência do adaptador, não pela fatura do Google.
