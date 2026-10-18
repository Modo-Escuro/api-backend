# GRP-01 — Busca progressiva e ausência de propostas

Desenvolvida em 18/10/2026 na branch `codex/grp01-progressive-search`, inicialmente sobre API #47 `a72f7958bafda3036a5c6f77045d13925b25233b`. O usuário autorizou publicar as melhorias. Na conferência para publicação, o #47 já estava mergeado; a entrega segue em PR de continuação, com base atualizada para `main@a027ed40ec24fb8957d28131e432bcdc566b45aa`, preservando #47 e #48. Publicação não autoriza merge, deploy, mudança de flags ou compra real. Os textos acessíveis do bot permanecem em outra branch e fora deste incremento da API.

## Causa e evidência

A imagem fornecida mostra grupo com dieta obrigatória sem lactose, alergia obrigatória a frutos do mar, teto de R$100 e resposta informando seis itens em duas lojas. Ela comprova o texto exibido e os comandos Retomar conversa; não contém respostas brutas, cursores, tempos, falhas MCP ou SHA Railway. Não permite afirmar qual desses fatores produziu os seis itens na instância.

No código anterior:

- `generateProposals` solicitava até **12 detalhes**, em até duas páginas de 20 candidatos (máximo 40), com prazo de 25 segundos. **Seis não era um limite fixo.**
- O número mostrado vinha do conjunto aceito pelo compositor, após descartar falhas de detalhe, duplicatas, identidade inconsistente e itens fora da loja fixada. Não expunha a causa de término da leitura.
- A busca era única e sem filtros alimentares. Isso preservava as diferenças individuais, mas não tentava consultas independentes por dieta. Sem a classificação do catálogo, texto como “sem lactose” ou ausência de leite não gera PASS: a heurística nunca comprova segurança.
- Os primeiros candidatos recebidos consumiam o orçamento de detalhes; uma loja podia ocupar todo o primeiro lote. Uma loja fixada na compra só era filtrada depois da leitura.
- `evaluateCandidate` bloqueia alergia UNKNOWN e aplica as restrições antes de `rankCandidates`. O ranking não tem como recuperar um item sem evidência. O compositor também usa um ranqueador de planos separado; preço e score não compensam bloqueio alimentar.
- A explicação genérica podia atribuir falta de preço/opções/disponibilidade à segurança alimentar e não oferecia uma próxima ação concreta.

Os bloqueios do cenário são coerentes com os dados suportados: **não existe canal de confirmação de restaurante habilitado na demo** (`VERIFIED_EVIDENCE_CHANNELS` vazio). O contrato atual não pode produzir PASS para alergia. Mais busca pode melhorar a cobertura de quem tem dieta, mas não comprova segurança para a pessoa alérgica.

## Implementação

`services/group-search.ts` coordena fases dentro da mesma intenção de leitura, reutilizando o pipeline `runEvaluation`:

1. Busca original, primeira página, até seis detalhes, alternando lojas disponíveis.
2. Até duas consultas independentes com os filtros de dieta obrigatória suportados, derivados de participantes distintos; até 12 detalhes por fase. Não aplica a união das restrições ao grupo nem transforma preferência em obrigação.
3. Ampliação da consulta original pelas páginas retornadas e até 24 detalhes.
4. Se ainda houver orçamento de leitura, consulta do mesmo termo por preço. Não muda a comida solicitada nem troca a loja fixada.

Limites globais: **quatro chamadas `searchOffers`, 24 identidades item/loja detalhadas, 80 candidatos, concorrência de quatro detalhes e 25 segundos**. Limites menores passados pelo chamador prevalecem. Endereços são lidos uma vez na exploração; as guardas autorizadas de #47 continuam antes e depois da busca. O deadline/sinal do turno chega às leituras e impede agendar fases após cancelamento. O transporte MCP continua responsável pelos timeouts das chamadas; o processador mantém sua barreira externa de prazo.

Páginas e leituras de item são memoizadas somente dentro da requisição, inclusive falhas: ampliar a busca não repete a mesma chamada nem reinvoca o modelo. O cache continua pertencendo ao vínculo do organizador. Identidade inclui loja e item. Cursores cíclicos não são reenviados; `hasMore=true` sem cursor ou com cursor repetido é paginação não verificada. Não se inventam páginas ou endpoints.

O mesmo item pode acumular classificações de consultas distintas somente se listagem e detalhe normalizados forem idênticos. Observações divergentes removem o item da composição durante aquela busca. A loja declarada é enviada no refinamento e candidatos fora dela não consomem detalhes. Todos os itens continuam passando por `getItem`, elegibilidade por pessoa e composição determinística.

A exploração encerra quando encontra uma proposta com cobertura de todas as pessoas ou atinge os limites. Cobertura alimentar não valida o custo completo: serviço, entrega ou outros custos desconhecidos não viram zero nem liberam orçamento/aprovação. Uma proposta parcial não é apresentada como atendimento completo.

## Resposta e próxima ação

O resultado interno acrescenta diagnóstico separado para evidência alimentar, orçamento, cobertura, catálogo, incompatibilidade e outros dados ausentes. A resposta mantém o resumo da busca, informa falhas/prazo/limites/paginação e preserva os motivos por pessoa. Não conclui que o catálogo inteiro foi esgotado.

Quando falta evidência, explica que elevar o teto não resolve esse bloqueio. Orienta consultar o restaurante sobre a restrição e contaminação cruzada e esclarece que uma mensagem no chat não constitui confirmação rastreável. Oferece outra busca por tipo de comida mantendo teto e restrições. Orçamento observado acima do teto, lojas fechadas, preço ausente e atendimento em lojas separadas recebem motivos próprios.

Até três candidatos com status não verificado podem aparecer com o prefixo **“Só informação, não é recomendação”**, pessoa afetada e bloqueio explícito. São texto de catálogo tratado como dado, com tamanho limitado e controles removidos. Não recebem bloco PROPOSAL, referência de escolha, sacola ou autorização humana. “Quero a proposta 1” não seleciona um candidato meramente informativo. As mensagens continuam no contrato v1 existente, sem alterar schemas ou pins históricos do bot.

## Retomar conversa e coordenação com bot

O bot #18 `52b9381b98b500a00d483d20c38e6255ea68e0fd` já contém a correção de entrega automática: mensagem de processamento editável, reconhecimento de edição já aplicada, retomada OAuth por GET e preservação de DELIVERY_UNKNOWN. Ver [continuidade e endereços](continuidade-enderecos.md) e o documento homônimo no bot. Não foi criada uma segunda implementação de polling/outbox, nem alterado o código do bot.

A imagem é compatível com o defeito antigo de teclado comum impedir edição da mensagem, já reproduzido sinteticamente. Sem logs e SHA da instância, essa causa online continua hipótese. Retomar conversa recupera/apresenta o resultado da intenção conhecida; não faz uma busca mais ampla nem deve iniciar outro Gemini. Nova busca requer uma nova solicitação humana. Resultado de entrega/negócio desconhecido não foi liberado para reenvio automático.

## Verificação e GO/NO-GO

- Regressores cobrem seis itens/duas lojas, sem lactose/frutos do mar/R$100, classificação incompatível/compatível/não verificável, informação sem seleção, novas páginas, diversidade de lojas, filtros individuais, limites globais, prazo, cancelamento, falha parcial, divergência de dados e cursores ausentes/cíclicos.
- Integração agente → propostas → snapshot → SQLite cobre o cenário, replay, consultas e reinício sem nova chamada ao modelo/MCP. Transportes são sintéticos; SQLite é real.
- Bot: **10 testes existentes aprovados** em `test_continuity_addresses.py`, incluindo entrega automática, ack perdido, reinício, OAuth, endereço e bloqueios de resultados desconhecidos. Não foi repetida toda a suíte do bot.
- API, Windows/Node 24.13.0: **972 testes aprovados, 2 ignorados, 58 arquivos** na repetição completa final. `npm run typecheck`, `npm run lint`, `npm run build` e `git diff --check` aprovados. Os arquivos novos também passaram pela conferência de whitespace. Não foram alterados timeout ou critérios de teste.
- Publicação sobre `main@a027ed4`, já com #47/#48: suíte completa com **1001 testes aprovados, 2 ignorados, 59 arquivos**; typecheck, lint, build e diff aprovados. O resultado 972/2 acima é da etapa de desenvolvimento sobre o head original do #47 e não foi reclassificado como teste da main atualizada.
- Prova adicional entre repositórios: snapshot sintético do cenário validado pelo schema e pelo renderizador Python real do bot #18. A resposta resultante tem 1.661 caracteres, cabe em um chunk Telegram, mantém R$100 e três avisos de candidatos informativos, sem proposta selecionável ou aprovação. JSON, prévia textual e logs sintéticos ficam em `docs/reviews/` do workspace hospedeiro, identificados como sintéticos; não são capturas online.
- Uma primeira regressão antiga esperava catálogo sem classificação, mas seu fake ignorava filtros e reapresentava a fixture original como resposta filtrada. O cenário agora retorna lista filtrada vazia; as expectativas de segurança originais foram preservadas.
- A primeira suíte completa encontrou um erro na montagem de um novo teste: reutilização do eventId ao adicionar outra pessoa. A correção usa intenções de teste distintas; nenhuma regra produtiva foi relaxada.

**GO técnico para revisão do patch local**, com as verificações acima aprovadas. **NO-GO operacional** para declarar a demo real corrigida, implantar ou liberar item com alergia: faltam autorização de implantação, versões/flags efetivas, ensaio humano e evidência alimentar confiável. Mesmo após implantar, esse cenário pode continuar sem proposta para a pessoa alérgica; a melhoria é ampliar a exploração e explicar o bloqueio corretamente. Carrinho, pedido e pagamento não foram alterados.
