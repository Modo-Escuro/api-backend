# OPS-02 — Observabilidade, limites, retenção e liberação gradual

**Continuação local CART-01:** [instrumentação e validação](cart-01-conclusao-offline.md) adicionam métricas por ferramenta/resultado e contagens persistidas de intenções ao status, mesmo com escrita desligada. Isso cobre parte pendente da #21; os ensaios operacionais seguem separados.

[Issue #21](https://github.com/Modo-Escuro/api-backend/issues/21) · [DEC-01 D7/D8](decisoes-conversacionais.md) · [RUN-01](runtime-turnos.md) · [AI-02](ai-02-agente.md) · [OPS-01](ops-01-persistencia.md)

## Estado deste incremento

Atualização documental de 18/10/2026: OPS-02 está implementada, e o código local inclui a montagem opt-in da CART-01. O [estado remoto/local](estado-remoto-local.md) registra separadamente as referências publicadas; esta revisão não verifica merge, deploy ou ativação. A preparação real exige evidência INT-02 e callback humano BOT-03 validados. Envio e pagamento continuam proibidos.

Entrega parcial, integrada à GRP-01 e à AI-01 (Gemini, #36): logs estruturados, métricas agregadas, orçamento de execução/gasto do modelo, status operacional separado, liberação gradual por organizador, verificação de permissões de storage e regressões de rollback. Na árvore local após a [retirada do legado](retirada-legado.md), o status distingue somente CART-01 montada (`HUMAN_CONFIRMATION_REQUIRED`) e desligada (`DISABLED`). Envio permanece `DISABLED`. Esses estados não comprovam evidência externa validada nem autorização de compra.

## Logs (`src/server/ops/log.ts`)

Uma linha JSON por evento: `{ts, level, event, ...campos}`. **Allowlist** de campos: `cid`, `component`, `method`, `route`, `status`, `durationMs`, `queueMs`, `tool`, `code`, `outcome`, `retryable`, `count`, `kind`, `errorName`, `reason`, `state`, contadores de tokens/expurgo. Qualquer outro campo é descartado (contado em `dropped`).

Strings só passam se parecerem código curto. São redigidas (`[redigido]`) quando têm espaço, `@`, `=`, `+`, 6 ou mais dígitos no total (telefone, CPF, cartão, ID do Telegram, mesmo com separadores), início de JWT ou bloco base64url aleatório. É o mesmo conteúdo autorizado pela D7: correlação opaca, rota, ferramenta MCP, código de status/erro, latência e contadores.

- Requisição: `http.request` com `cid`, método, **padrão da rota casada** (ex.: `/api/bot/v1/conversations/:conversationId/events`, `/api/bot/*`), status e duração. O caminho bruto nunca é usado: o conjunto de rótulos é fechado e definido no código, então requisições não autenticadas a caminhos arbitrários não criam séries nem levam IDs ao log. Rota não casada ou 404 vira `[nao-mapeada]`. O `cid` é aleatório por requisição, não deriva de identidade e é devolvido em `X-Correlation-Id`; um `X-Correlation-Id` enviado pelo cliente é ignorado.
- Erro 500: `http.unhandled_error` registra só a classe e o `code` em formato de enum. **A resposta passou a ter mensagem fixa** (`Erro interno` + `correlationId`). A exceção bruta não aparece mais no log nem no corpo.
- Assistente: `agent.budget_exceeded` (tipo de limite, nome técnico preservado). Falhas de turno aparecem em `turns.operation_finished`.
- Turnos: `turns.operation_finished` (resultado e duração), `turns.runtime_unhealthy`, `retention.purge_failed`.
- Inicialização: `storage.permissions` e `config.submit_flag_ignored`.

Os `console.*` antigos (auth, links, storage) já registravam só códigos e continuam como estão. Um teste estático impede que um `console.*` registre `.message`, a exceção ou `JSON.stringify` de payload.

## Métricas (`src/server/ops/metrics.ts`)

Ficam em memória por processo e zeram ao reiniciar. Os rótulos permitidos são `route`, `method`, `statusClass`, `tool`, `code`, `outcome`, `kind` e `component`. Rótulos de identidade são ignorados, e há um teto de 500 séries (`droppedSeries`). Nenhuma série é por pessoa, conversa ou vínculo. Por isso, não formam histórico pessoal.

| Métrica | O que mede |
| --- | --- |
| `http_requests_total`, `http_request_duration_ms` | Volume, classe de status e latência por rota |
| `mcp_tool_calls_total{tool,outcome,code}`, `mcp_tool_duration_ms` | Chamadas de leitura MCP, erros inline (`TOOL_ERROR` + código) e de transporte |
| `cart_write_attempts_total{tool,outcome}`, `cart_write_duration_ms{tool,outcome}` | Tentativas e duração em milissegundos de cada chamada de escrita CART-01; resultado `ACKNOWLEDGED` ou `RESULT_UNKNOWN` |
| `turn_queue_wait_ms`, `turn_run_duration_ms`, `turn_operations_total{outcome}` | Fila, execução e resultado dos turnos |
| `model_calls_total`, `model_call_duration_ms`, `model_tokens_total{kind}` | Chamadas ao modelo e tokens (`input`, `output` ou `reserved_unreported` quando o provedor não reporta) |
| `model_cost_micro_usd_total` | Custo estimado do Gemini pelo preço de referência do adaptador (não é fatura) |
| `agent_budget_exceeded_total{kind}` | Paradas por orçamento do assistente (nome técnico preservado) |
| `retention_purged_total`, `retention_purge_failed_total` | Expurgo D7 |

As métricas de escrita são registradas ao terminar cada despacho ao gateway, inclusive quando ele falha. `ACKNOWLEDGED` indica resposta reconhecida pelo parser daquela chamada, não sucesso da intenção inteira ou envio de pedido. Replay de confirmação e consultas GET não despacham novamente nem incrementam essas tentativas. Os rótulos contêm apenas ferramenta e resultado, sem IDs, conta, referência, endereço ou composição.

O estado desconhecido dos turnos sai de `TurnStore.stats().resultUnknown`. As intenções CART-01 são contadas separadamente em `purchase.cartIntents`. Ambas as contagens vêm do SQLite e sobrevivem ao reinício; as métricas de tentativas e duração ficam em memória e zeram ao reiniciar.

## Status operacional: `GET /api/ops/status`

Exige o mesmo `BOT_API_TOKEN` e um organizador autorizado, e responde com `Cache-Control: no-store`. Os números são agregados do processo inteiro, não do organizador que consulta: qualquer organizador autorizado vê as mesmas contagens. Devolve só contagens, sem caminhos ou identidades, e separa:

- `http`: o processo responde. Equivale ao `/api/health`, que continua 200 mesmo com o runtime parado.
- `linksStorage`: estado e durabilidade (OPS-01), mais `permissions`.
- `sessions`: `confirmed`, `operational` (última verificação OK), `unavailable`, `reconnectRequired`, `unverified`. A contagem usa o estado conhecido, sem chamada remota. Token presente ≠ operacional.
- `conversation`: `enabled`, `rollout`, `runtime` (`accepting`, `healthy`, `processorInstalled`, `storage` = `OK`/`UNAVAILABLE`/`CLOSED`, fila, `resultUnknown`, compras ativas), permissões do diretório do banco e resumo do orçamento.
- `purchase`: `capable: false`, `cartPreparation`, `submission: DISABLED`, `submitFlagIgnored`. Com CART-01 montada, preparação é `HUMAN_CONFIRMATION_REQUIRED` e motivo `PREPARE_CART_ONLY`; isso indica o caminho instalado, não evidência aprovada nem autorização de compra. Desligada, mantém o status anterior.
- `purchase.cartIntents`: contagens persistidas por estado `PENDING`, `SUCCEEDED`, `FAILED` e `RESULT_UNKNOWN`, inclusive com o opt-in de escrita desligado, desde que o runtime/banco esteja disponível. Sem runtime ou quando a consulta ao banco falha, retorna `null`; indisponibilidade não é contagem zero. Não inclui identidades ou conteúdo das intenções.

## Limites de execução/gasto (`src/server/ops/budget.ts`)

`SpendBudget` é opcional em `createAssistantProcessor({ budget })`. Cada chamada do roteador e do planejador consome sua própria reserva. Usa janela fixa (padrão 1 h) e tetos de chamadas e tokens por conversa (60 / 200 mil) e globais (2 000 / 4 milhões). Também limita o número de conversas acompanhadas (5 000; cheio ⇒ recusa).

1. Antes de chamar o provedor, reserva `estimativa da entrada + maxOutputTokens`.
2. Estourou ⇒ `ContractError('LIMIT_EXCEEDED')` **antes da chamada**. A operação termina `FAILED/LIMIT_EXCEEDED` (HTTP 429 no contrato), e o snapshot e a compra ficam na versão anterior. Assim que a janela vira, um novo evento continua do estado preservado (teste de regressão).
3. Depois da chamada, `reportUsage` ajusta a reserva ao uso real. O adaptador Gemini (`ai/gemini.ts`) reporta os tokens de entrada e saída devolvidos pelo provedor e o custo calculado pelo preço de referência.
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
| `CONVERSATION_ORGANIZER_IDS` | Restringe conversa e rotas CART-01 aos IDs listados, sempre após a autenticação do adaptador (allowlist ou opt-in de senha). Quem está fora recebe `UNAVAILABLE`. Qualquer entrada inválida impede a API de iniciar | ausente/vazio = todos os admitidos pela autenticação |
| `IFOOD_CONFIRMED_CART_WRITES_ENABLED` | CART-01: exige banco, manifesto de evidência e revisão/clique específico; não libera pagamento/envio | `false` |
| `IFOOD_SUBMIT_ENABLED` | **Não existe como habilitação.** Se definido, é ignorado e reportado | — |

Rollout sugerido: (1) ligar a conversa com `CONVERSATION_ORGANIZER_IDS=<1 organizador de teste>`; (2) acompanhar `/api/ops/status` (fila, `resultUnknown`, `budget_exceeded`, erros MCP/modelo); (3) ampliar a lista; (4) esvaziar a lista só depois de QA-01.

**Rollback da conversa:** definir `CONVERSATION_RUNTIME_ENABLED=false`, `CONVERSATION_MODEL_ENABLED=false` e `IFOOD_CONFIRMED_CART_WRITES_ENABLED=false`, então reiniciar a API. Modelo e CART-01 exigem runtime; mantê-los ativos impediria a inicialização. Para excluir somente um organizador pelo rollout, removê-lo de `CONVERSATION_ORGANIZER_IDS` apenas se restar pelo menos um ID; remover o último ou omitir a variável libera todos os admitidos pela autenticação. Para desligar somente a preparação CART-01, definir `IFOOD_CONFIRMED_CART_WRITES_ENABLED=false` e reiniciar. A configuração é lida na inicialização.

Rollback funcional não apaga dados: schema atual **v6**, binários v5 e anteriores recusados. A migração preserva variantes v5, memória, grupos anteriores e RESULT_UNKNOWN, sem transferir eventos entre contas. Visibilidade depende da sessão; recover continua sem repetir rede com CART-01 desligada. Restaurar binário compatível, sem downgrade ou backup antigo sobre efeito desconhecido. [Migração e limites](armazenamento-v6.md).

## Retenção (D7)

| Dado | Onde | Retenção |
| --- | --- | --- |
| Compra/participantes/restrições | SQLite RUN-01 | Exclusão ao encerrar e `purge()` após 24 h sem evento aceito (DATA-01), desde que não haja trabalho pendente ou efeito externo não resolvido. CART-01 com `PENDING`/`RESULT_UNKNOWN` bloqueia expurgo. No expurgo permitido, remove revisões CART-01, limpa plano/composição e snapshot remoto, preservando tombstones técnicos para impedir replay |
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

- **GRP-01**: o assistente reutiliza `domain/group.ts` para compor candidatos detalhados em propostas. As chamadas MCP da busca entram em `mcp_tool_calls_total`, mas **não** são cobradas pelo `SpendBudget`, que só conta chamadas ao modelo. Eventos `agent.proposals_unavailable`/`agent_proposals_total` pertenciam ao processador retirado.
- **AI-01** (#36, mergeada em `dc448f9`): integrada. O orçamento entra pela montagem (`conversation-runtime.ts`) e o adaptador Gemini chama `reportUsage`. Regressões em `test/ops/gemini-integration.test.ts`, com rede sintética: uso real substituindo a reserva, `LIMIT_EXCEEDED` antes da chamada, limite global, recusa antes da rede, timeout, concorrência, reinício e status com logs sanitizados.

## Lacunas

- CART-01 tem status de preparação, métricas por chamada de escrita e contagens persistidas de intenções. Permanecem pendentes a evidência externa INT-02 e os ensaios operacionais, incluindo o callback humano BOT-03 em ambiente autorizado. A integração offline do callback está registrada na [conclusão CART-01](cart-01-conclusao-offline.md); não comprova ativação real. BUY-01/02 e métricas de envio não estão implementadas; `purchase.capable` permanece `false`.
- Orçamento e métricas são em memória e por processo; reiniciar zera a janela. Aceitável enquanto houver uma única instância (RUN-01). Para várias instâncias, persistir no SQLite.
- Não há exportador Prometheus/OTel; o JSON de `/api/ops/status` é a interface.
- A retenção de 7 dias dos logs depende da configuração da plataforma.
- O custo em micro-USD é estimado pelo preço de referência do adaptador, não pela fatura do Google.
