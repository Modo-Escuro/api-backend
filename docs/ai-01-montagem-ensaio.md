# AI-01 — Montagem do processador e preparação do ensaio

Base: `main@2df4e54` da API. Continuação do bot: [PR #11](https://github.com/Modo-Escuro/telegram-bot/pull/11)
integrado em `main@681d21d`. A BOT-02 continua aberta. DEC-01 permanece: sacola simulada, MCP somente leitura,
sem envio real. Nenhuma variável, volume, credencial ou instância Railway foi alterada por este incremento.

## Entrega e limites

O entrypoint agora usa `createConversationRuntime`, compartilhando a mesma instância de `IfoodLinkService`
entre login e agente. Com os dois opt-ins e configuração válida, monta
`OpenAIConversationModel → createAgentProcessor → RUN-01/DATA-01`. Sem opt-in do modelo, o comportamento anterior
é preservado: runtime sem processador, eventos novos retornam `UNAVAILABLE`. Não existe fallback de regras em produção.

OpenAI Responses é **candidato implementado**, não escolha aprovada pela AI-01. Não houve comparação de modelos,
chamada paga nem validação da chave/conta. Modelo fica sem valor padrão. Modelo incompatível com o schema estrito
falha fechado. Os testes usam transporte falso; não comprovam aceitação do schema pelo serviço externo.

Apenas coleta de participantes, restrições, limites e prioridade está conectada ao agente. Propostas coletivas,
sacola e aprovação simuladas continuam dependentes de GRP-01/BOT-03/BUY-01 e evolução explícita do contrato.
Este adaptador não expõe ferramentas MCP. A integração conversacional de busca real continua pendente.

## Configuração explícita na API

| Variável | Regra |
| --- | --- |
| `CONVERSATION_RUNTIME_ENABLED` | `true` para RUN-01; exige banco e ID do bot |
| `CONVERSATION_DB_FILE` | Caminho exclusivo em disco persistente; preservar o SQLite atual |
| `BOT_TELEGRAM_ID` | ID numérico do bot, nunca token |
| `BOT_API_TOKEN`, `ALLOWED_ORGANIZER_IDS` | Canal autenticado e organizador autorizado |
| `CONVERSATION_MODEL_ENABLED` | `false` por padrão; `true` habilita chamadas potencialmente pagas |
| `CONVERSATION_MODEL_PROVIDER` | `openai` neste candidato |
| `CONVERSATION_MODEL` | Nome exato do modelo acessível e avaliado; obrigatório, sem fallback |
| `OPENAI_API_KEY` | Só no ambiente secreto da API; não no bot, Git, comandos compartilhados ou chat |
| `CONVERSATION_MODEL_TIMEOUT_MS` | Padrão 8000; faixa 100–20000 ms para vínculo + modelo |
| `CONVERSATION_MODEL_MAX_OUTPUT_TOKENS` | Padrão 2048; faixa 256–4096 |
| `CONVERSATION_MODEL_MAX_REQUESTS` | Obrigatório ao habilitar; 1–1000 tentativas por processo, inclusive falhas |
| `IFOOD_CART_ENABLED`, `DEV_GLOBAL_SESSION` | Devem permanecer `false` |

O contador de tentativas é conservador e em memória, compartilhado entre organizadores do processo. Ao esgotar,
turnos falham com `UNAVAILABLE`; não há chamada adicional nem retry interno. Reinício zera o contador e recuperação
do runtime pode chamar o modelo de novo. **Não é teto financeiro, por compra ou durável**. Autorizar orçamento e
configurar controles do projeto provedor antes da avaliação externa; não promover para uso aberto com base nesse contador.

Falha HTTP, timeout, resposta incompleta, corpo acima de 64 KiB ou proposta fora do schema não altera o estado.
As exceções do provedor são descartadas e não há logs de corpo, chave ou conteúdo. O endpoint é fixo
`https://api.openai.com/v1/responses`; redirects são recusados. Não há descoberta automática de credenciais.

## Dados e contrato externo

O modelo recebe o contexto por allowlist da AI-02 e a mensagem atual como dado: participantes simulados, condições,
limites, pendências e prioridade. Não recebe o snapshot integral, vínculo, endereço, identidade Telegram ou referência
de aprovação. A mensagem livre ainda pode conter dados que o organizador inserir: usar somente conteúdo sintético na avaliação.

Usamos `text.format` com JSON Schema estrito. Campos opcionais locais são nullable no transporte; apenas esses
campos conhecidos são normalizados antes da validação local. Recusa descarta ações; texto livre da resposta não
é exibido. [Contrato oficial de Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs).

As chamadas usam `store: false`, sem conversa remota, background ou ferramentas. Isso não equivale a retenção zero
nem comprova a política da conta; conferir os controles aplicáveis antes de usar dados reais.
[Documentação oficial de dados](https://developers.openai.com/api/docs/guides/your-data).

## Avaliação reproduzível

Após `npm ci --ignore-scripts`, executar `npm run eval:agent`. O padrão usa somente o modelo determinístico local,
sem rede. Sete cenários sintéticos cobrem coleta, correção de orçamento, preservação de alergia, dado ausente,
ambiguidade, pedido sem aprovação e instrução embutida em catálogo. Modelo que não coleta nada reprova.

Na execução offline desta implementação, o stub de regras passou em seis dos sete casos e reprovou
`teto-ambiguo`: não reconheceu “Talvez R$ 100, não sei” por causa da vírgula após o valor. O caso permanece no
corpus e o comando retorna código 1. Isso registra uma limitação do stub; não é avaliação do candidato OpenAI
nem motivo para promover um provedor com caso crítico reprovado.

Somente depois de definir modelo disponível e autorizar o gasto, preencher o ambiente acima e executar
`npm run eval:agent -- --live`. O comando não lê `.env` automaticamente, não abre banco nem usa OAuth/Telegram/MCP.
São até 12 chamadas, sem retry do adaptador. Não copiar valores secretos para a linha de comando ou evidência.

O relatório contém IDs sintéticos de caso, aprovação/reprovação e duração, sem entradas/saídas do provedor.
O p95 medido é apenas da chamada ao modelo, com amostra pequena; **não comprova D10**. Registrar commit, modelo
exato, configuração, custo observado no provedor e todas as falhas. A seleção continua pendente até comparar
candidatos acessíveis, medir custo/latência, revisar dados e satisfazer os critérios críticos. Não promover uma
execução que falhe, mesmo que parte dos casos passe.

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

## Validação local em 18/10/2026

Ambiente: Windows, Node 24.13.0 e npm 11.6.2; dependências instaladas pelo lockfile sem scripts.

- `npm run typecheck`, `npm run lint`, `npm run build` e `git diff --check`: passaram.
- `npm test`: 749 testes aprovados; dois testes de permissões POSIX omitidos no Windows, em 44 arquivos.
- Consumidor Python: seis testes de `test/contracts/test_python_consumer.py` passaram em Python 3.12.
- `npm run eval:agent`: seis de sete casos aprovados pelo stub de regras; código 1 por `teto-ambiguo`, conforme
  descrito acima. Não é resultado do candidato OpenAI. Reprovação não foi suprimida.
- Os testes novos usam transporte OpenAI falso; incluem rotas autenticadas Hono, serviço real de vínculos com
  OAuth/MCP falsos, montagem do processador, SQLite, replay, correção preservando alergia, limites e privacidade.
- Schemas versionados do contrato do bot preservados. Nenhuma chamada paga ou de negócio MCP, login real,
  polling Telegram, mudança Railway ou ensaio online foi executado.

CI e revisão do PR são verificações separadas; o resultado local não afirma execução em outras plataformas.
