# AI-01 — Montagem do processador, provedor Gemini e ensaio

> Histórico de montagem/ensaios anteriores à [retirada do legado](retirada-legado.md). `agent/`, corpus e scripts `eval:agent`/`ai:demo:*` foram retirados localmente. Transporte atual em `ai/gemini.ts`, único processador em `assistant/`, configuração vigente em `.env.example`. Os resultados históricos abaixo não comprovam inferência ou operação online do fluxo atual.

> **Consolidação dos PRs #35 (Maylon) e #36 (kujojorin).** Do #36 vêm a montagem (`createConversationRuntime`),
> a configuração explícita e a avaliação encadeada. Do #35 vêm a escolha do Gemini 3.8 Flash, o adaptador e o
> ensaio ao vivo ([resultado](ai-01-result.md)). O candidato OpenAI do #36 (nunca avaliado) e os caminhos
> Groq/Anthropic do #35 (comparação abandonada / HTTP 400) foram removidos.

Base: `main@2df4e54` da API. Continuação do bot: [PR #11](https://github.com/Modo-Escuro/telegram-bot/pull/11)
integrado em `main@681d21d`. A BOT-02 foi encerrada pelo alcance implementado; ensaio humano é evidência separada. A DEC-01 vigente permite carrinho real confirmado; CART-01 nova continua local, com ativação condicionada à INT-02. Envio e pagamento seguem proibidos. Nenhuma variável, volume, credencial ou instância Railway foi alterada por este incremento.

## Configuração explícita na API

Montagem corrente conferida em 20/10/2026: `createConversationRuntime` monta dois modelos JSON com contabilidade compartilhada, roteador de audiência e planejador de compras, ambos em `ai/gemini.ts`, consumidos por `assistant/processor.ts`. `agent/` e `linkedProposalProvider` não existem mais. A configuração vigente está em [.env.example](../.env.example) e [assistente](assistente-conversacional.md#configuração).

| Configuração atual | Regra |
| --- | --- |
| Runtime | `CONVERSATION_RUNTIME_ENABLED=true`, `CONVERSATION_DB_FILE` explícito/persistente e `BOT_TELEGRAM_ID` válido |
| Autenticação | `BOT_API_TOKEN` com ao menos 32 caracteres e `ALLOWED_ORGANIZER_IDS` válidos para montagem do modelo |
| Modelo | `CONVERSATION_MODEL_ENABLED=true`, provider `google`, modelo `gemini-3.8-flash`, `GEMINI_API_KEY` no servidor |
| Limites | `CONVERSATION_MODEL_MAX_REQUESTS` obrigatório; demais valores/faixas em `config.ts`/`.env.example` |
| Prazo | timeout do adaptador por chamada padrão 15000 ms; prazo do turno do assistente padrão 45 s. Não há mais a folga legada de +2 s como prazo do turno |
| Proteção de custo | Roteador e planejador consomem chamadas separadas; contadores do adaptador e `SpendBudget` em RAM, não teto financeiro durável |
| Configurações retiradas | Remover `CONVERSATION_AGENT_MODE`, flags F7/sessão global e `WEB_ORIGIN`; modo structured/flags antigas true são recusados |
| Persistência | SQLite v6, unificando variantes v5; sem downgrade. [Guia](armazenamento-v6.md) |
| Carrinho | Opt-in/evidência/confirmação próprios da CART-01; nenhuma configuração do modelo autoriza escrita |

Sem opt-in do modelo, não há processador nem fallback determinístico: novos eventos recebem UNAVAILABLE; consultas/replay existentes têm regras próprias. Sem runtime, a montagem nem abre o banco. Chave incidental não ativa nada.

Testes vigentes: `test/assistant/`, `test/ops/gemini-integration.test.ts` e `test/turns/`. Os comandos `eval:agent`/`ai:demo:*` abaixo pertencem apenas aos ensaios históricos; não há CLI live equivalente entregue nesta árvore. Nova avaliação exige ambiente e chave de teste explicitamente configurados, sem usar produção.

## Registro histórico — entrega e limites do incremento #35/#36

O entrypoint usa `createConversationRuntime`, compartilhando a mesma instância de `IfoodLinkService` entre login,
agente e leitura MCP. Com os dois opt-ins e configuração válida, monta
`createGeminiModel → createAgentProcessor (+ linkedProposalProvider da GRP-01) → RUN-01/DATA-01`. Sem opt-in do
modelo, o comportamento anterior é preservado: runtime sem processador, eventos novos retornam `UNAVAILABLE`.
Não existe fallback de regras em produção.

- **Coleta não depende do iFood:** `linkOf` devolve o vínculo confirmado mesmo com verificação de rede falhando
  (`UNAVAILABLE`); só falha de armazenamento interrompe o turno. Operações que dependem do MCP (sugestões) passam
  por `withOperational`, que exige vínculo operacional e devolve mensagem específica quando não há.
- **Sugestões (GRP-01) ligadas:** "Sugere pizza" lê `searchOffers`/`getItem` pelo vínculo; escolha só por posição;
  composição local ainda não sincronizada, total `UNKNOWN` e aprovação de pedido bloqueada. A preparação real depende da integração CART-01 e confirmação PREPARE_CART. Nenhuma ferramenta de escrita é alcançável.

## Configuração histórica na API (#35/#36)

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
| `CONVERSATION_MODEL_TIMEOUT_MS` | Padrão 15000; faixa 1000–20000 ms (o turno ganha +2 s para o vínculo) |
| `CONVERSATION_MODEL_MAX_OUTPUT_TOKENS` | Padrão 2048 (inclui raciocínio contabilizado); faixa 256–4096 |
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
cada chamada reserva cerca de US$ 0,018, então US$ 2 cobrem cerca de 110 falhas. O usuário vê `UNAVAILABLE`
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

## Avaliação histórica — reprodução somente na revisão de origem

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
  coleta com iFood indisponível, fluxo "Sugere pizza" → proposta → composição local (transporte MCP falso, sem escrita externa), limites por
  processo/conversa/gasto, cota preservando estado, respostas truncadas/malformadas e ausência de segredos nos logs.
- **Avaliação ao vivo não executada nesta consolidação:** nenhuma chave exclusiva de teste disponível no ambiente.
  A evidência real continua sendo a rodada do #35 ([resultado](ai-01-result.md)); repetir com
  `AI_EVAL_GEMINI_API_KEY` antes de ativar.

## Validação com Gemini real (18/10/2026, segunda rodada)

Chave de teste local (sem Railway), só dados sintéticos; `modelVersion` reportado pelo provedor: `gemini-3.8-flash`.

- **Bug encontrado:** com 800 tokens de saída, ~1/3 das mensagens de coleta (inclusive a frase do roteiro BOT-02) truncavam
  (`FINISH_LENGTH`): o raciocínio interno (736–767 tokens) consumia o teto. `thinkingLevel: minimal` é recusado (HTTP 400) e
  `thinkingBudget`/temperatura 0 não reduzem a variância. A regra "teto coletivo só se disser grupo" fazia o modelo hesitar
  em "Teto de R$ 180" (pergunta em vez de registrar). Correções: padrões 2048 tokens / 15 s; prompt explicita que teto sem
  pessoa identificada é do grupo; falha inválida agora informa `FINISH_<motivo>:PARSE|SCHEMA` e cobra os tokens reportados
  (antes mantinha a reserva inteira); `modelVersion` registrado no uso. **O hash do prompt mudou em relação ao #35.**
- Após a correção: `ai:demo:gemini` 18/18 (críticos 13/13, schema 18/18, p95 3,4 s, ~US$ 0,017);
  `eval:agent --live` 8/8 em duas rodadas (p95 3,7 s e 4,8 s); bateria local de 13 conversas PT-BR 13/13 (p95 5,1 s,
  máx. 8,7 s); E2E pelas rotas autenticadas (Gemini real, OAuth/MCP falsos com fixtures reais) aprovado duas vezes.
- **Auditoria adversarial (F1, corrigido):** o modelo sozinho podia trocar restrição `UNCLEAR` (com pergunta pendente) por
  `NONE`, liberando a pessoa. Agora `SET_NO_RESTRICTIONS` exige frase explícita do usuário ("sem restrições", "não tem
  alergia"...), como `SET_NO_LIMIT`; senão vira pergunta e preserva o estado. Pendências registradas naquela avaliação histórica (não são aprovação para ativar carrinho real):
  aumento de teto rígido sem confirmação (F2); prompt acima de 8 KB em grupos grandes trava a conversa em `UNAVAILABLE`
  (F3); nome proposto pelo modelo ecoado em pendências (F4); `CONVERSATION_MODEL_ENABLED=""` desliga sem motivo (N1);
  dieta sem `requirement` vira obrigatória (N2).
- Antes da correção, encadeado: 7/8, 5/8, 7/8, 6/8 (falhas de truncamento/timeout/teto ambíguo; nenhuma removeu alergia,
  aprovou compra ou seguiu injeção). Amostras pequenas: não comprovam D10 nem estabilidade estatística.

CI e revisão do PR são verificações separadas; o resultado local não afirma execução em outras plataformas.
