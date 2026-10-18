# AI-01 — Montagem do processador, provedor Gemini e ensaio

> **Consolidação dos PRs #35 (Maylon) e #36 (kujojorin).** Do #36 vêm a montagem (`createConversationRuntime`),
> a configuração explícita e a avaliação encadeada. Do #35 vêm a escolha do Gemini 3.8 Flash, o adaptador e o
> ensaio ao vivo ([resultado](ai-01-result.md)). O candidato OpenAI do #36 (nunca avaliado) e os caminhos
> Groq/Anthropic do #35 (comparação abandonada / HTTP 400) foram removidos.

Base: `main@2df4e54` da API. Continuação do bot: [PR #11](https://github.com/Modo-Escuro/telegram-bot/pull/11)
integrado em `main@681d21d`. A BOT-02 continua aberta. DEC-01 permanece: sacola simulada, MCP somente leitura,
sem envio real. Nenhuma variável, volume, credencial ou instância Railway foi alterada por este incremento.

## Entrega e limites

O entrypoint usa `createConversationRuntime`, compartilhando a mesma instância de `IfoodLinkService` entre login,
agente e leitura MCP. Com os dois opt-ins e configuração válida, monta
`createGeminiModel → createAgentProcessor (+ linkedProposalProvider da GRP-01) → RUN-01/DATA-01`. Sem opt-in do
modelo, o comportamento anterior é preservado: runtime sem processador, eventos novos retornam `UNAVAILABLE`.
Não existe fallback de regras em produção.

- **Coleta não depende do iFood:** `linkOf` devolve o vínculo confirmado mesmo com verificação de rede falhando
  (`UNAVAILABLE`); só falha de armazenamento interrompe o turno. Operações que dependem do MCP (sugestões) passam
  por `withOperational`, que exige vínculo operacional e devolve mensagem específica quando não há.
- **Sugestões (GRP-01) ligadas:** "Sugere pizza" lê `searchOffers`/`getItem` pelo vínculo; escolha só por posição;
  sacola simulada, total `UNKNOWN`, aprovação bloqueada. Nenhuma ferramenta de escrita é alcançável.

## Configuração explícita na API

| Variável | Regra |
| --- | --- |
| `CONVERSATION_RUNTIME_ENABLED` | `true` para RUN-01; exige banco e ID do bot |
| `CONVERSATION_DB_FILE` | Caminho exclusivo em disco persistente; preservar o SQLite atual |
| `BOT_TELEGRAM_ID` | ID numérico do bot, nunca token |
| `BOT_API_TOKEN`, `ALLOWED_ORGANIZER_IDS` | Canal autenticado e organizador autorizado |
| `CONVERSATION_MODEL_ENABLED` | `false` por padrão; `true` habilita chamadas pagas |
| `CONVERSATION_MODEL_PROVIDER` | `google` (único suportado) |
| `CONVERSATION_MODEL` | `gemini-3.8-flash` (único avaliado); obrigatório, sem fallback |
| `GEMINI_API_KEY` | Só no ambiente secreto da API; não no bot, Git, comandos compartilhados ou chat |
| `CONVERSATION_MODEL_TIMEOUT_MS` | Padrão 8000; faixa 1000–20000 ms (o turno ganha +2 s para o vínculo) |
| `CONVERSATION_MODEL_MAX_OUTPUT_TOKENS` | Padrão 800 (inclui raciocínio contabilizado); faixa 256–2048 |
| `CONVERSATION_MODEL_MAX_REQUESTS` | Obrigatório; 1–100000 chamadas por processo, inclusive falhas |
| `CONVERSATION_MODEL_MAX_REQUESTS_PER_CONVERSATION` | Padrão 200; faixa 1–1000 |
| `CONVERSATION_MODEL_BUDGET_MICRO_USD` | Padrão 2000000 (US$ 2); faixa até US$ 50; reserva local conservadora |
| `IFOOD_CART_ENABLED`, `DEV_GLOBAL_SESSION` | Devem permanecer `false` |

Os limites substituem o teto fixo 20/12 do #35 (que travava a demo depois de 20 mensagens) e o contador único
do #36: um só lugar (o adaptador), configurado pela API. São contadores em memória do processo: reinício zera e a
recuperação do runtime pode chamar o modelo de novo. **Não são teto mensal de cobrança**: configurar limite de
gasto no console do Google. Persistência, alertas e liberação gradual ficam para a OPS-02. Esgotado o limite, o
turno falha com `UNAVAILABLE` sem alterar o estado; não há retry interno.

**Riscos conhecidos dos contadores:** não têm janela de tempo e contam falhas. Uma conversa trava ao atingir o limite
por conversa (padrão 200) e o processo ao atingir `CONVERSATION_MODEL_MAX_REQUESTS`, até reiniciar; com erros 5xx,
cada chamada reserva cerca de US$ 0,013, então US$ 2 cobrem cerca de 150 falhas. O usuário vê `UNAVAILABLE`
genérico. Dimensionar para a demo e acompanhar; janela/alerta ficam para a OPS-02.

Falha HTTP, rede, timeout, resposta truncada (`MAX_TOKENS`), corpo de resposta acima de 64 KB (lido com teto, sem
confiar em `Content-Length`) ou proposta fora do schema não altera o estado. A configuração antiga do #35
(`CONVERSATION_MODEL=gemini-…` sem `CONVERSATION_MODEL_ENABLED`) falha no boot com motivo claro. Erros viram códigos fixos (`QUOTA`, `AUTH`, `UNAVAILABLE`, `TIMEOUT`, `INVALID_OUTPUT`, `BUDGET`...);
corpo, headers e mensagens do provedor nunca são registrados. Endpoint fixo
`generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent`; redirects recusados.

## Dados e contrato externo

O modelo recebe o contexto por allowlist da AI-02 e a mensagem atual como dado: participantes simulados, condições,
limites, pendências e prioridade. Não recebe o snapshot integral, vínculo, endereço, identidade Telegram ou referência
de aprovação. A chave de limite por conversa é um hash opaco local e nunca vai ao provedor. A mensagem livre ainda
pode conter dados que o organizador inserir: usar somente conteúdo sintético na avaliação.

Saída estruturada via `generateText` + `Output.object` (Vercel AI SDK) com o schema da AI-02 projetado para
transporte; validação local estrita (`AgentProposalSchema` + `allowedActions` + política) depois da resposta.
`thinkingLevel: low`, sem pensamentos na saída, sem ferramentas nem streaming, telemetria do SDK desligada.

## Avaliação reproduzível

Dois ensaios complementares, ambos só com dados sintéticos e **chave exclusiva de teste** `AI_EVAL_GEMINI_API_KEY`
(nunca a chave de produção nem `railway run` com o ambiente de produção):

| Comando | Origem | O que mede |
| --- | --- | --- |
| `npm run ai:demo:offline` / `npm run ai:demo:gemini` | #35 | 18 casos isolados sobre o contrato de ações (16 originais + 2 de GRP-01); custo, tokens, p95; para no primeiro erro |
| `npm run eval:agent` / `npm run eval:agent -- --live` | #36 | 8 conversas **encadeadas** pela política e pelo domínio reais (coleta, correção, alergia preservada, ambiguidade, pedido sem aprovação, injeção de catálogo, sugestão sem escolha às cegas) |

Offline, o stub de regras reprova `teto-ambiguo` de propósito (limitação do stub, registrada; não relaxa o critério).
O relatório contém IDs sintéticos de caso, aprovação/reprovação e duração, sem entradas/saídas do provedor.
Amostras pequenas: **não comprovam D10**.

## Roteiro operacional BOT-02

Operado pelo organizador; nunca iniciar um segundo polling com o token existente.

1. Conferir versões implantadas do bot e API. Merge/CI não demonstram deploy. Fazer a preservação/restauração
   dos vínculos e SQLite conforme [OPS-01](ops-01-persistencia.md), antes de qualquer redeploy/migração.
2. Confirmar volume efetivo, caminhos, credenciais correspondentes (`BACKEND_API_TOKEN` do bot = `BOT_API_TOKEN`
   da API), ID de bot e organizador. Conferir flags reais; não copiar defaults de localhost para Railway.
3. Concluir avaliação autorizada do modelo. Habilitar o processador da API e `TELEGRAM_CONVERSATION_ENABLED=true`
   no único worker do bot. Health de vínculos não comprova disponibilidade do modelo.
4. Preparar um grupo inteiramente sintético pela conversa: “Somos Ana e Bia. Ana é alérgica a amendoim.
   Teto de R$ 180. Preferimos o mais barato.” Corrigir: “Na verdade, no máximo R$ 150”. Conferir duas pessoas,
   alergia obrigatória preservada e orçamento de R$ 150. Não usar dados privados dos integrantes.
5. `/conectar` → autorizar pessoalmente no navegador → conferir identidade mascarada → clicar humanamente →
   `/verificar`. A retomada deve recuperar participantes, condições e orçamento atual. Login não aprova compra.
6. Verificar que a consulta de retomada não cria evento/execução de modelo nem muda a versão da conversa,
   não repete mensagem anterior e não apresenta proposta/aprovação antiga. Não registrar IDs, texto ou dados privados.
7. Testar replay, reinício e indisponibilidade primeiro em ambiente de teste. Conta trocada ou sessão sem acesso
   deve impedir apresentação pelo bot. `/retomar` após entrega incerta pode duplicar texto Telegram, nunca intenção.

Registrar resultado sanitizado e versões de cada serviço. A integração das futuras ações de compra à invalidação
de vínculo/versão permanece pendente; ausência de botões não comprova esse critério. Cinco demos seguidas e p95
ponta a ponta da D10 continuam sem evidência. Qualquer envio real está fora deste roteiro.

## Validação local da consolidação (18/10/2026)

Ambiente: Linux, worktree de integração sobre o #36 + `main@8191a0f` (GRP-01) + #35.

- `npm test`: 811 testes aprovados em 48 arquivos; `npm run typecheck`, `npm run lint`, `npm run build` e `git diff --check`: passaram.
- `npm run ai:demo:offline`: 18/18 casos (stub = esperado; não é inferência).
- `npm run eval:agent`: 7/8 casos pelo stub de regras; `teto-ambiguo` reprovado por limitação conhecida do stub.
- Testes com transporte Gemini falso: rotas autenticadas Hono, serviço real de vínculos com OAuth/MCP falsos,
  coleta com iFood indisponível, fluxo "Sugere pizza" → proposta → sacola simulada (MCP só leitura), limites por
  processo/conversa/gasto, cota preservando estado, respostas truncadas/malformadas e ausência de segredos nos logs.
- **Avaliação ao vivo não executada nesta consolidação:** nenhuma chave exclusiva de teste disponível no ambiente.
  A evidência real continua sendo a rodada do #35 ([resultado](ai-01-result.md)); repetir com
  `AI_EVAL_GEMINI_API_KEY` antes de ativar.

CI e revisão do PR são verificações separadas; o resultado local não afirma execução em outras plataformas.
