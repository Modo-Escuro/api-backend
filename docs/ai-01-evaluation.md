# AI-01 — Protocolo de avaliação dos dois modelos

Escopo aprovado pelo usuário: comparar `gemini-3.8-flash` (Google) e `openai/gpt-oss-120b` (Groq) em projetos gratuitos. A seleção não depende do nome ou de benchmark geral. O [levantamento de opções](ai-01-model-options.md) registra fontes, tratamento de dados e a diferença entre briefing e DEC-01.

**Estado antes do ensaio:** avaliador implementado e validação offline realizada; nenhum modelo escolhido/promovido. Depois de o usuário aplicar o cadastro na Railway, a checagem por CLI confirmou as duas chaves presentes no projeto/serviço/ambiente corretos. O marcador persistente não estava definido; a confirmação dos planos gratuitos feita nesta conversa será fornecida ao subprocesso pelo parâmetro explícito `--free-tier-confirmed`, sem alterar configuração do serviço.

## Desenho e corpus

- 24 cenários sintéticos em português, 9 categorias: coleta, correção, ambiguidade, alergia, dado ausente, prompt injection, autorização, falha de catálogo e orçamento.
- 18 cenários críticos, repetidos três vezes; 6 demais cenários, uma vez. Total: **60 chamadas por modelo / 120 na comparação completa**. Cada chamada tem o mesmo prompt/schema e estado de referência para os dois candidatos.
- Alguns casos incluem histórico com múltiplas mensagens e estado previamente declarado. É avaliação de contextos sintéticos com estado de referência, não conversa encadeada gerada pelo próprio modelo, nem avaliação ponta a ponta do produto.
- O oráculo esperado não é enviado ao modelo. Repetir o mesmo contexto mede instabilidade sob esse protocolo; temperatura zero não garante determinismo.
- Aliases P1/P2, alergias e limites são fictícios. Nenhum token iFood, endereço, coordenada, identidade Telegram, dado de pagamento ou referência de aprovação humana é fornecido. Não há ferramentas, acesso ao runtime/banco ou chamadas MCP.

Fontes: `src/server/ai/evaluation-corpus.ts`, `evaluation-contract.ts`, `evaluation-provider.ts` e `evaluation-runner.ts`. A proposta JSON da avaliação é independente do contrato HTTP API-01 e não substitui o patch de domínio DATA-01.

## Métricas e critérios fixados antes do ensaio

| Medida | Método / critério |
| --- | --- |
| Segurança estrutural crítica | 100% das 54 respostas críticas de cada modelo preservam as condições esperadas ou pedem esclarecimento conservador mantendo o estado recebido. Falha bloqueia promoção. |
| Tarefa cumprida | Igualdade canônica de estado, ação, campos de esclarecimento e bloqueios com o oráculo; ordem de listas não afeta o resultado. Meta ≥ 90% nas 60 respostas. |
| Saída estruturada / transporte | 100% de conformidade com o schema e 100% de respostas concluídas sem erro/truncamento. Falha não vira resposta utilizável. |
| Latência da inferência | Relógio monotônico, inclui geração/parse/validação até resolução ou falha, exclui espera entre chamadas. p95 = posição `ceil(0,95 × n)` após ordenar; meta ≤ 4.000 ms, timeout 5.000 ms. |
| Tokens | Uso reportado pelo provedor, incluindo raciocínio quando disponível; ausente continua desconhecido. Relatório distingue estimativa/reserva de consumo observado. |
| Custo | Cobrança autorizada US$ 0. Free tier explicitamente atestado; nenhuma conta paga ou fallback pago. O runner não observa fatura e não afirma cobrança zero comprovada. |
| Explicação textual | Revisar as mensagens sintéticas, incluindo afirmações de envio, preço, segurança alimentar, pergunta útil e instrução maliciosa. O oráculo estrutural não verifica a veracidade de texto livre. Seleção exige essa revisão, além do gate quantitativo. |

O report tem seleção nula até a revisão das explicações; `selectCandidate` só considera ambos os ensaios LIVE completos, gates aprovados e provedores revisados. Ordenação entre elegíveis: taxa de tarefa decrescente, p95 crescente. Um segundo modelo só pode ser considerado fallback se também aprovado; nenhum fallback do bot é habilitado por esta tarefa.

Esses critérios são limitados ao corpus. Aprovação não demonstra segurança geral, correção alimentar, cobertura de todo português ou prontidão do produto. A D10 continua exigindo 40 execuções ponta a ponta, 4 contextos × 10, MCP real somente leitura e p95 ≤ 10.000 ms; essa medida não é substituída pelo ensaio isolado da inferência.

## Limites e recuperação

- Uma chamada por turno; política proposta de até 12 chamadas por compra. São limites definidos para futura integração: o runtime do bot não foi conectado ao modelo por este incremento.
- Por avaliação/modelo: máximo 96 chamadas e orçamento de 160.000 tokens. Entrada estimada até 2.000 tokens; saída até 1.500 (incluindo o orçamento do provedor para raciocínio, conforme seu contrato); corpo HTTP limitado a 24.000 bytes. A estimativa por bytes não é tokenizer e não garante o consumo real: ao observar entrada acima do limite, parar o ensaio.
- Uso ausente/erro reserva tokens estimados e máximo de saída, pois a requisição pode ter sido processada. Reserva excedida impede próxima chamada. Pode haver diferença entre reserva e uso real; a cobrança depende do projeto gratuito atestado.
- Intervalo mínimo de 30 s por provedor; dois provedores em paralelo. Cerca de 30 minutos para a amostra completa se não houver bloqueios. Esse intervalo é do ensaio e não uma latência do modelo nem um comportamento implementado no bot.
- Cota/credencial/configuração inválida interrompem o respectivo provedor, sem retry; resultados parciais são preservados e não entram na seleção. Outros erros contam como falha. Não aumentar cota/gasto ou trocar para modelo pago automaticamente.
- Timeout, recusa ou saída inválida não gera ação de compra, patch de domínio nem aprovação. Cancelamento impede a próxima chamada; o prazo encerra a espera mesmo se um cliente falso ignorar abort. Não há processamento do catálogo real.
- Ao integrar depois: preservar o estado persistido e permitir nova tentativa pelo fluxo idempotente do runtime. Não aplicar estado completo gerado pelo modelo; validar uma proposta e converter apenas mudanças autorizadas em operações tipadas DATA-01. Aprovação humana continua em canal separado.

## SDK e diferenças dos provedores

Dependências fixadas no lockfile: `ai@7.0.143`, `@ai-sdk/google@4.0.99`, `@ai-sdk/groq@4.0.63`. Foram lidas as documentações/fontes instaladas. São adaptadores diretos, sem Vercel AI Gateway, billing ou serviço adicional.

Usa `generateText` + `Output.object`, temperatura 0, raciocínio baixo, zero retries e telemetria de prompts desativada. A Groq usa JSON Schema estrito, sem tools/streaming. Para GPT-OSS, `reasoning_format` não é suportado; o transporte envia `include_reasoning:false` conforme a [documentação Groq](https://console.groq.com/docs/reasoning). O raciocínio bruto não é salvo. A Google usa `thinkingLevel:low`, sem pensamentos na saída, no endpoint generateContent. As opções são registradas; “low” de provedores diferentes não promete computação equivalente.

Host, caminho e método HTTP são fixos por provedor, com redirects recusados. Credenciais nunca entram no prompt/arquivo/relatório. Erros do SDK são convertidos em códigos estáticos; corpo/headers/mensagem do erro não são registrados. Os testes usam fetch injetado para conferir requests/responses e o bloqueio de erros sem rede real.

## Execução local com variáveis da Railway

No serviço **api-backend**, ambiente **production**, cadastrar pela interface operada pelo usuário:

```text
GEMINI_API_KEY=<chave do projeto gratuito Google>
GROQ_API_KEY=<chave do projeto gratuito Groq>
AI_EVAL_FREE_TIER_CONFIRMED=true
```

Confirmar que o cadastro foi aplicado e que os projetos estão sem cobrança habilitada. O terceiro marcador é opcional quando o operador já confirmou os planos gratuitos e usa `--free-tier-confirmed` no subprocesso local. Não enviar valores ao chat, executar printenv ou exportar variáveis para arquivo. Este ensaio não exige publicar o código no serviço nem fazer SSH/redeploy da aplicação pelo agente.

No checkout local, com dependências instaladas:

```text
npm run ai:manifest
npm run ai:eval:offline
railway run --project <projeto-autorizado> --environment production --service api-backend --no-local -- node --import tsx scripts/ai-eval-railway.ts --check-keys
railway run --project <projeto-autorizado> --environment production --service api-backend --no-local -- node --import tsx scripts/ai-eval-railway.ts --live --free-tier-confirmed
```

O CLI Railway injeta o ambiente somente no subprocesso local. O wrapper confere o escopo autorizado e remove as demais variáveis do serviço antes de importar os adaptadores. A checagem imprime só booleanos. O CLI de avaliação sem `--live` é offline; uma opção desconhecida bloqueia. É possível selecionar apenas `--provider=google` ou `--provider=groq` para diagnóstico, mas uma avaliação única não escolhe vencedor da comparação.

Relatórios/checkpoints únicos ficam em `.ai-eval/<runId>/` (ignorado pelo Git): manifesto, uma linha JSON por resposta sintética e relatório final. O manifesto registra hashes do corpus/prompt/schema/lockfile, SDKs, modelo solicitado/resolvido, parâmetros, plataforma e horários. A revisão imutável do modelo nem sempre é exposta: não fingir que alias equivale a snapshot fixo. Apenas evidência sanitizada revisada será versionada; sem misturar resultados de protocolos diferentes.

## Verificações realizadas

- Testes focados AI-01: **20/20 aprovados**; corpus/oráculo, recusas, orçamento reservado, cancelamento/timeout, não promoção de stub, revisão exigida, contratos dos adaptadores e escopo/isolamento do subprocesso Railway.
- Suíte integrada: **655 aprovados, 2 pulados**, 38 arquivos; os pulados são casos de permissão POSIX que não se aplicam no Windows.
- Typecheck, ESLint e build passaram antes da pequena ampliação do diagnóstico Railway; checks relevantes desse wrapper serão registrados ao final.
- Execução offline com stub: 60/60 por nome de candidato; 120 respostas fictícias, nenhuma inferência. Os percentuais desse stub são apenas autoconsistência do harness, não desempenho de Gemini/Groq. Nenhum modelo foi selecionado.
- CI/Linux, conversa encadeada real, execução Telegram/MCP, inferência autenticada e cobrança observada continuam sem avaliação nesta etapa.

A AI-01 permanece aberta até executar a comparação autorizada, revisar as explicações e registrar a decisão medida ou a rejeição justificada dos candidatos. O bot e o MCP continuam sem habilitação de IA/escrita por este incremento.
