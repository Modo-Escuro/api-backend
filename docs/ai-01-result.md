# AI-01 — Gemini escolhido para a demo

Em 18/10/2026, após o usuário solicitar um ensaio curto adequado ao hackathon, foi escolhido **Gemini 3.8 Flash (`gemini-3.8-flash`)**. A escolha usa resultados no contrato de ações da AI-02; não é garantia de segurança geral nem comparação controlada de qualidade contra Claude/Groq, que não concluíram esse mesmo ensaio.

| Medida | Resultado da rodada curta |
| --- | --- |
| Corpus | 16 contextos sintéticos PT-BR, uma chamada por contexto, 12 críticos |
| Tarefa / críticos / schema | 16/16 · 12/12 · 16/16 |
| p95 da inferência | 3.175,38 ms, posição 16 de 16 (máximo da amostra); meta de seleção ≤ 4.000 ms |
| Tokens reportados | 12.584 de entrada, 1.483 de saída, conforme contabilidade do SDK/provedor |
| Estimativa de consumo | US$ 0,015005; aproximadamente US$ 0,000938 por tarefa aprovada |
| Orçamento da rodada | US$ 0,25 por candidato; sem retry, sem ferramentas ou alterações de domínio |
| Uso em produção | Implementado por opt-in; merge/deploy/ativação não realizados |

A estimativa usa [preços Standard Gemini](https://ai.google.dev/gemini-api/docs/pricing): US$ 0,75 por milhão de tokens de entrada e US$ 3,75 de saída até 31/12/2026, arredondando cada chamada para cima em micros de dólar inteiros. Não é saldo/fatura observada; eventual franquia/crédito pode reduzir cobrança. Após o usuário informar billing configurado, a nova rodada voltou a responder; isso não comprova que billing era a única causa dos erros anteriores. Sem busca/grounding, cache explícito ou serviços adicionais.

## Evidência e revisão

- Rodada: `2026-10-18T07-55-20-109Z-google-2fdb51b1`, protocolo `AI02_DEMO_1`.
- [Manifesto](evidence/ai-01/2026-10-18T07-55-20-109Z-google-2fdb51b1/manifest.json), [relatório original](evidence/ai-01/2026-10-18T07-55-20-109Z-google-2fdb51b1/report.json), [decisão após revisão](evidence/ai-01/2026-10-18T07-55-20-109Z-google-2fdb51b1/decision.json).
- O relatório automático mantém `selected:null`; a decisão separada registra a revisão das 16 propostas pelo agente de desenvolvimento, sem fingir aprovação humana de compra.
- Foram conferidos alvos, criação antes das ações sobre participantes novos, valores em centavos, preservação de alergias, restrição não suportada, ambiguidade, instrução maliciosa e pedidos de aprovação/envio. As respostas não trouxeram texto livre; REQUEST_ORDER apenas leva à explicação de revisão humana do servidor. Nenhuma ação aprova ou envia pedido.
- Contextos têm estado de referência; não são conversa encadeada, demonstração Telegram/MCP ou D10 ponta a ponta. Poucas amostras, sem repetição, não medem estabilidade estatística nem toda a qualidade do português.
- SDKs efetivos: `ai@7.0.143`, `@ai-sdk/google@4.0.99`. O campo `sdkVersion` do manifesto original nomeia o pacote Anthropic instalado (`4.0.82`), que não executa a rodada Google; as dependências reais estão no lockfile com hash registrado. O CLI foi corrigido depois para registrar todos os SDKs e os limites efetivos, sem repetir inferências apenas para corrigir metadados.
- Código reproduzível: revisão `81cab8b` (prompt, corpus, schema e lockfile conferidos contra os hashes do ensaio). O CLI teve apenas correções posteriores de metadados. Revisão imutável do modelo não foi registrada; o ID é um alias. Não tratar alias como snapshot fixo.

O protocolo curto foi definido antes de suas chamadas: 100% dos 12 críticos, ≥ 90% das 16 tarefas, 100% de schema, deadline/p95 de até 8 s e revisão das propostas. A seleção também conferiu a meta anterior de p95 ≤ 4 s, que foi atingida. Dados fictícios P1/P2; nenhum endereço, token iFood, identidade Telegram, referência de aprovação ou pagamento foi enviado.

## Outros candidatos

| Candidato | Resultado e decisão |
| --- | --- |
| Groq GPT OSS 120B | Protocolo antigo 1.1: 46/60 chamadas, 25 tarefas aprovadas nesse oráculo, 0 erros de transporte. Interrompido quando o usuário pediu testes mais simples. Revisão encontrou atribuição arbitrária de pessoa e pergunta induzida por instrução maliciosa do catálogo. Não promovido. |
| Gemini antes do billing | Protocolo antigo: 13/60 chamadas, 7 falhas (timeout/indisponibilidade/cota), interrompido em QUOTA. Não extrapolar qualidade para os casos ausentes. |
| Claude Sonnet 5.5 | Chave presente, três tentativas iniciais interrompidas em HTTP 400; diagnóstico encontrou somente termos predefinidos `header`/`invalid`/`message`, sem identificar a causa exata ou divulgar erro bruto. Não há amostra de qualidade nem modelo Claude aprovado. Sem retries automáticos. Não bloqueia a escolha da Gemini. |

[Checkpoints antigos e resumo reconstruído](evidence/ai-01/2026-10-18T07-25-19-608Z-68434b2f/summary.json) e [revisão textual](ai-01-text-review.md) preservam a rejeição inicial. Os contratos, prompts e condições mudaram; **não comparar 25/46 da Groq com 16/16 da Gemini como se fossem o mesmo benchmark**. Piloto e diagnósticos separados não entram nas métricas acima.

Claude Max pode oferecer créditos incluídos após resgate no Console, mas criar uma chave não seleciona um modelo nem comprova saldo. Não é fallback ativo. Os dois transportes reais implementam a mesma interface fechada e validam o JSON integralmente com Zod; restrições omitidas do schema de transporte continuam obrigatórias localmente.

## Implementação e limites da demo

- `createGeminiModel` implementa `ConversationModel` da AI-02; `index.ts` instala o processador somente com opt-in. O serviço de vínculos é compartilhado pela API e pelo agente; o link vem do organizador autenticado, sem consulta MCP neste passo.
- Uma chamada por turno. Máximo **12 tentativas por conversa/organizador/bot por processo**, mais restritivo que 12 por compra; a chave do contador é metadado local e não chega ao modelo. Máximo **20 chamadas / US$ 0,50 de reserva por processo** no adaptador de demo; ensaio curto usa 16 / US$ 0,25. Contadores são em memória e reinício os zera; não constituem teto mensal de cobrança. Definir limite de gasto no provedor antes de ampliar uso.
- Contexto por allowlist: estado estruturado mínimo + mensagem atual; sem histórico completo ou metadados de conta. Entrada de contexto até 8.000 bytes; corpo HTTP até 24.000 bytes. Até **800 tokens de saída**, incluindo raciocínio conforme contabilizado pelo SDK. Raciocínio bruto não é registrado. Dados reais sensíveis continuam fora dos ensaios.
- Modelo: `thinkingLevel:low`, sem pensamentos na saída, schema nativo básico, validação local estrita, sem ferramentas/streaming, sem temperatura forçada na rodada curta. Deadline do modelo **8 s**; vínculo + modelo têm **9 s** no processador. Não há retry ou fallback automático.
- Antes de cada chamada, reserva conservadora por bytes + folga de protocolo + saída máxima; depois, custo estimado do uso reportado. Uso desconhecido/erro mantém reserva. Não é tokenizer nem fatura: orçamento de aplicação não substitui controle de billing. Valores em micros de dólar inteiros; dinheiro da compra continua em centavos.
- Timeout, cota, recusa ou saída inválida não produzem compra/aprovação. Erros deixam estado/versão intactos; novo turno pode tentar novamente dentro dos limites. Recusa descarta ações e usa resposta do servidor. Credenciais ficam na API, fora do prompt e dos logs.
- Servidor valida cada ação e renderiza fatos persistidos; nenhum estado completo gerado pelo modelo é aplicado ao banco. Sacola simulada e MCP somente leitura continuam sob DEC-01.

## Reproduzir e ativar após revisão

```text
npm run ai:demo:offline
railway run --project <projeto-autorizado> --environment production --service api-backend --no-local -- node --import tsx scripts/ai-eval-railway.ts --claude-demo --live --provider=google
```

O segundo comando faz inferência paga conforme a conta e tem teto de aplicação de US$ 0,25; o offline não usa chaves/rede nem promove modelo. O wrapper verifica o serviço autorizado e remove as demais variáveis antes de importar os adaptadores.

Depois de merge/deploy, para instalar o agente no serviço:

```text
GEMINI_API_KEY=<já cadastrada na Railway>
CONVERSATION_MODEL=gemini-3.8-flash
CONVERSATION_RUNTIME_ENABLED=true
CONVERSATION_DB_FILE=<banco em volume persistente configurado na RUN-01>
BOT_TELEGRAM_ID=<ID do bot, não token>
```

Chave presente sozinha não ativa modelo. `CONVERSATION_MODEL=off` mantém o runtime sem processador; sem opt-in de runtime, as rotas seguem desativadas. Não foi alterada configuração remota por este incremento. O ensaio D10 de Telegram/API/MCP, com 40 execuções e p95 ≤ 10 s, fica para validação integrada da demo; a amostra isolada não o substitui.

## Verificações

**736 testes aprovados, 2 pulados no Windows, 44 arquivos.** Inclui transporte falso dos SDKs, bloqueio de credenciais/escopo incorretos, orçamento/cancelamento, schema estrito, opt-in e Gemini → AI-02 → RUN-01 → SQLite, com cota preservando estado e recuperação no turno seguinte. Typecheck, ESLint e build Vite aprovados. Testes de SDK usam respostas falsas; os 16 cenários acima são inferências reais autorizadas. CI/Linux e deploy não foram executados localmente.
