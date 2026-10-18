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

## Implementação e limites da demo (atualizado na consolidação #35 + #36)

- O adaptador vive em `src/server/agent/gemini-model.ts` (antes `ai/claude-model.ts`). A montagem é a do #36
  (`createConversationRuntime`), com as sugestões da GRP-01 ligadas. Configuração e limites: ver
  [montagem AI-01](ai-01-montagem-ensaio.md#configuração-explícita-na-api).
- O teto fixo **20 chamadas por processo / 12 por conversa** desta rodada foi substituído por limites configuráveis
  (`CONVERSATION_MODEL_MAX_REQUESTS*`, `CONVERSATION_MODEL_BUDGET_MICRO_USD`), porque travava a demo depois de 20
  mensagens. Prazo, 800 tokens de saída, reserva conservadora, ausência de retry e de ferramentas foram mantidos.
- Os caminhos Groq e Anthropic e o harness de comparação foram removidos do código; esta página e as evidências
  em `docs/evidence/ai-01/` permanecem como histórico da seleção.

## Reproduzir e ativar após revisão

```text
npm run ai:demo:offline
AI_EVAL_GEMINI_API_KEY=<chave exclusiva de teste> npm run ai:demo:gemini
```

O ensaio ao vivo tem teto de aplicação de US$ 0,25 e usa só a chave de teste. O script antigo via
`railway run --environment production` foi removido: avaliação local não deve puxar credenciais de produção.

Depois de merge/deploy, para instalar o agente no serviço (ver tabela completa na montagem AI-01):

```text
CONVERSATION_RUNTIME_ENABLED=true
CONVERSATION_DB_FILE=<banco em volume persistente configurado na RUN-01>
BOT_TELEGRAM_ID=<ID do bot, não token>
CONVERSATION_MODEL_ENABLED=true
CONVERSATION_MODEL_PROVIDER=google
CONVERSATION_MODEL=gemini-3.8-flash
GEMINI_API_KEY=<cadastrada só no ambiente secreto da API>
CONVERSATION_MODEL_MAX_REQUESTS=<limite autorizado>
```

Chave presente sozinha não ativa modelo. Não foi alterada configuração remota. O ensaio D10 de Telegram/API/MCP,
com 40 execuções e p95 ≤ 10 s, fica para validação integrada da demo; a amostra isolada não o substitui.

## Verificações

**736 testes aprovados, 2 pulados no Windows, 44 arquivos.** Inclui transporte falso dos SDKs, bloqueio de credenciais/escopo incorretos, orçamento/cancelamento, schema estrito, opt-in e Gemini → AI-02 → RUN-01 → SQLite, com cota preservando estado e recuperação no turno seguinte. Typecheck, ESLint e build Vite aprovados. Testes de SDK usam respostas falsas; os 16 cenários acima são inferências reais autorizadas. CI/Linux e deploy não foram executados localmente.
