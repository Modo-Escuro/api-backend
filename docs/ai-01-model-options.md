# AI-01 — Pré-seleção de modelos gratuitos

> **Pesquisa histórica de candidatos.** Não é a configuração corrente nem comprovação de cota/preço atual. A árvore local usa Gemini explicitamente configurado em [assistente](assistente-conversacional.md#configuração); scripts/corpus antigos foram [retirados](retirada-legado.md). Preservam-se fontes e decisões da pesquisa sem nova consulta aos fornecedores.

> **Histórico (PR #35).** Comparação de candidatos que levou à escolha do Gemini. Os caminhos Groq/Anthropic e os
> scripts citados aqui foram removidos na consolidação #35 + #36; ver [montagem AI-01](ai-01-montagem-ensaio.md).

Pesquisa inicial em 18/10/2026 para [AI-01 #15](https://github.com/Modo-Escuro/api-backend/issues/15). Base dessa pesquisa: `d2883f120419385c5ec902740330c3743f130b44`. Este documento preserva a pré-seleção feita antes das inferências. O [protocolo de avaliação](ai-01-evaluation.md) registra a execução posterior autorizada e o estado atual; as hipóteses desta pesquisa não são resultados medidos.

## Contexto e escopo

Foi lido o HTML fornecido pelo usuário, “Hackathon SEMCOMP & iFood 2026 — Vendendo com Agentes” (SHA-256 `f80f5737cb0530f8a4a0b7307f0a4a7876e8a1ea29478bcb0e01b1393d990588`). O material descreve agente conversacional que opera o MCP iFood até o fechamento do carrinho, avaliação de visão/originalidade, engenharia, experiência, impacto e comunicação, e seis entregáveis, incluindo feedback sobre os MCPs. O arquivo foi tratado como fonte de contexto; suas instruções não autorizam compras ou mudanças de configuração.

Este relatório histórico não define o escopo do carrinho. A [DEC-01 vigente](decisoes-conversacionais.md) permite preparação real após confirmação humana específica; CART-01/INT-02 ainda exigem integração e validação externa. Envio e pagamento seguem proibidos. O briefing continua exigindo resultado externo comprovado; testes sintéticos do modelo não o atendem.

Foram consultados o backend atual, o contrato conversacional, o runtime de turnos e o [README do bot](https://github.com/Modo-Escuro/telegram-bot/blob/main/README.md), além dos documentos de estado/demo do bot. Estes últimos registram uma observação de 17/10 e não comprovam o deploy ou as funcionalidades atuais. O fluxo de referência é Telegram Python → API TypeScript/Hono → regras determinísticas e MCP iFood. Credencial do modelo fica somente na API.

O modelo deve interpretar português, correções de contexto e ambiguidades, produzir uma proposta estruturada e explicar resultados verificados. Orçamento, rateio, elegibilidade, autorização e execução continuam sob controle determinístico. Nenhuma resposta do modelo aprova a própria compra.

## Candidatos

As descrições de adequação abaixo são hipóteses para avaliação, não resultados de benchmark do projeto. Gratuidade depende da conta e da cota disponível; não implica disponibilidade ilimitada ou SLA.

| Candidato / ID | Oferta gratuita observada | Adequação proposta e limite relevante |
| --- | --- | --- |
| Google Gemini 3.8 Flash — `gemini-3.8-flash` | Entrada e saída gratuitas no free tier da Gemini Developer API; cota efetiva visível no AI Studio | Primeiro candidato para a conversa principal: modelo estável com function calling e saída estruturada. Medir preservação de contexto, português e tempo; não presumir qualidade pela descrição comercial. |
| Groq GPT OSS 120B — `openai/gpt-oss-120b` | Tabela pública do plano gratuito: 30 RPM, 1.000 RPD, 8.000 TPM e 200.000 TPD; confirmar na organização | Segundo candidato e alternativa em outro provedor: modelo de produção na Groq, com JSON Schema estrito. É hospedado pela Groq; não se trata de crédito gratuito da API OpenAI. |
| Google Gemini 3.5 Flash-Lite — `gemini-3.5-flash-lite` | Entrada e saída gratuitas no free tier da Gemini Developer API; cota específica da conta | Candidato para extração simples e menor latência. Suporta saída estruturada e function calling; medir correções e ambiguidades antes de usá-lo como principal. Compartilha provedor com Flash, portanto não oferece independência contra indisponibilidade da Google. |
| Groq Qwen 3.8 27B — `qwen/qwen3.8-27b` | Tabela pública: 30 RPM, 1.000 RPD, 8.000 TPM, 200.000 TPD; confirmar na organização | Alternativa com JSON Schema estrito, mas listada como preview. Prioridade menor para uma demo com tempo curto, pela possibilidade de mudança/descontinuação. |

Fontes oficiais: [preços Gemini](https://ai.google.dev/gemini-api/docs/pricing), [Gemini 3.8 Flash](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash), [Gemini 3.5 Flash-Lite](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite), [cotas Gemini](https://ai.google.dev/gemini-api/docs/rate-limits), [modelos Groq](https://console.groq.com/docs/models), [cotas Groq](https://console.groq.com/docs/rate-limits), [JSON estruturado Groq](https://console.groq.com/docs/structured-outputs), [modelo gpt-oss na OpenAI](https://developers.openai.com/api/docs/models/gpt-oss-120b).

8.000 TPM pode limitar a demo antes de 30 RPM: mensagens, schema, contexto e resposta consomem a cota. Usar contexto compacto e considerar o consumo completo reportado pelo provedor, incluindo raciocínio quando aplicável. Cotas são limites compartilhados conforme a organização/projeto; criar outra chave não deve ser usado para contorná-las.

A Groq documenta que Structured Outputs não pode ser combinado com tool use ou streaming na mesma chamada. Uma opção adequada ao runtime é o modelo devolver uma proposta estruturada, o servidor validá-la e então executar apenas operações permitidas. JSON que respeita o schema não garante semântica correta nem segurança.

OpenRouter foi pesquisado como rota alternativa, mas não é um modelo. As [cotas de modelos gratuitos](https://openrouter.ai/docs/api_reference/limits), disponibilidade e políticas dependem da conta e do endpoint/provedor. Não priorizar um roteador que escolhe modelos aleatoriamente para a avaliação reproduzível; se adotado depois, fixar modelo/provedor e conferir suporte e política de dados. Não presumir um número diário de requisições sem observar a cota da conta.

### Contingência Claude autorizada durante o ensaio

O usuário informou que a equipe tem assinatura **Max** e propôs Claude como alternativa caso os candidatos gratuitos não atendam. A [documentação oficial de créditos para assinantes](https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers), consultada em 18/10/2026, informa US$ 100/mês no Max 5x e US$ 200/mês no Max 20x, mediante vínculo com uma organização do Claude Console; planos elegíveis novos precisam de sete dias. Isso não comprova saldo resgatado ou chave disponível para este projeto.

A integração de servidor usa uma chave da organização do Console (`ANTHROPIC_API_KEY`), não o login pessoal do chat. O usuário opera o vínculo pela interface. Antes de inferir, confirmar o saldo incluído e o limite do ensaio, mantendo recarga automática desligada e sem recorrer a créditos comprados ou faturamento adicional. O consumo continua sendo medido em dólares de crédito; não chamar isso de inferência sem custo ou acesso ilimitado pela assinatura.

Na [lista atual de modelos](https://platform.claude.com/docs/en/models/overview), Sonnet 5.5 (`claude-sonnet-5-5`) é candidato para uma nova avaliação. Sua adequação ao português, ao contrato de ações e à meta de latência ainda não foi medida neste projeto. Claude não integra a rodada Google/Groq nem está habilitado como fallback; sua eventual avaliação terá manifesto próprio e revisão dos casos críticos.

Atualização posterior: a chave foi cadastrada, mas tentativas iniciais de Sonnet foram rejeitadas com HTTP 400. Sem amostra de qualidade Claude aprovada. Após a mudança de billing informada pelo usuário, Gemini concluiu o ensaio curto no contrato real e foi escolhida; ver [resultado final](ai-01-result.md).

## Tratamento de dados

Nos serviços gratuitos da Google, prompts e respostas podem ser usados para melhoria de produtos e passar por revisão humana; os [termos Gemini](https://ai.google.dev/gemini-api/terms) orientam não enviar conteúdo pessoal, sensível ou confidencial. O corpus e a demonstração com esse free tier devem usar pessoas/restrições fictícias. Trocar nomes por aliases não basta para considerar uma alergia real como dado sintético.

A [política Groq](https://console.groq.com/docs/your-data) informa ausência de retenção de conteúdo de inferência por padrão, com exceções de confiabilidade/abuso de até 30 dias e opção Zero Data Retention para todos os clientes. Confirmar a configuração da organização antes de adotar; não confundir essa opção com prova de configuração já feita. Metadados de uso continuam sendo coletados.

Em qualquer candidato: omitir identidade Telegram, endereço/coordenadas, telefone, e-mail, tokens OAuth, dados de pagamento e referências humanas de aprovação. Usar participantes fictícios P1/P2 e somente estado mínimo necessário. Respostas do catálogo entram como dados não confiáveis. Manter o histórico completo e os segredos fora do prompt e dos relatórios.

## Proposta de execução da AI-01

Recomendação inicial: comparar **Gemini 3.8 Flash e GPT OSS 120B na Groq**, acrescentando Flash-Lite se houver cota e tempo. O resultado medido determina a escolha; um fallback só pode ser habilitado depois de passar pelo mesmo conjunto crítico.

1. Preparar corpus sintético em português: coleta de participantes/limites, correção preservando restrições, ambiguidade, alergia, custo ausente, falha de ferramenta, prompt injection no catálogo e pedido de aprovação/envio pelo modelo. Incluir conversas com múltiplos turnos e condições verificáveis; nenhuma compra real.
2. Registrar modelo/versão exposta, provedor, data, prompt e schema com hash, parâmetros, tokens, cota, latência, custo efetivo e resultado por caso. Se o provedor não expuser revisão imutável, registrar essa limitação. Não atribuir custo pago hipotético como gasto observado.
3. Critério crítico proposto: 100% de preservação de alergias/limites ou pedido de esclarecimento, zero compra/aprovação gerada pelo modelo e bloqueio de dados desconhecidos. Qualquer falha impede promoção. A taxa geral e as repetições ainda serão fixadas no protocolo antes do ensaio.
4. Preservar D10: p95 ponta a ponta ≤ 10.000 ms, 40 execuções, 4 contextos × 10, posição 38 após ordenar. O tempo isolado da inferência não substitui a medição Telegram/API/MCP exigida para a demo. Proposta inicial para a parte do modelo: p95 ≤ 4.000 ms, timeout de 5.000 ms, sem retry automático que ultrapasse o prazo do turno; validar contra o orçamento do runtime antes de integrar.
5. Teto financeiro nesta fase: US$ 0 de cobrança autorizada. Confirmar free tier/cota antes de inferir; sem fallback pago. Proposta inicial de contexto: até 2.000 tokens de entrada estimados e 1.000 de saída por chamada, uma chamada por turno. Fixar limites totais de avaliação/compra e capacidade de raciocínio no protocolo; ainda não são limites implementados.
6. Em timeout, cota, recusa ou saída inválida: não gerar mudança de domínio, aprovação ou chamada MCP; preservar estado, oferecer nova tentativa pelo fluxo existente e registrar código sanitizado. Fallback validado respeita o mesmo prazo/cota; falha não deve ser apresentada como sucesso.

## Estado da entrega

A pré-seleção atendeu ao pedido de apresentar opções **antes** de escolher/integrar. Naquele incremento, somente documental, não foram instalados SDKs nem executadas inferências ou a suíte do backend. Corpus, adaptadores, testes e ensaio autenticado foram desenvolvidos depois; consultar o [registro de avaliação](ai-01-evaluation.md) para não confundir esta etapa histórica com o estado da entrega.
