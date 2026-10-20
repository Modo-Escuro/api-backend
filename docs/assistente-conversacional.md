# Assistente de compras orientado por intenção

## Decisão de produto nesta conversa

O usuário pediu que a API interprete situações naturais — por exemplo, “hoje é um dia especial, quero comprar um bolo pra minha namorada” — e entregue a mensagem à IA autenticada por uma chave de API. A IA conhece as ferramentas disponíveis, propõe consultas ao iFood e usa seus resultados para conduzir a conversa.

O usuário também definiu o objetivo de **concluir um pedido pelo Telegram após um botão humano de confirmação**. Esse é o destino do produto, detalhado na seção de fechamento abaixo. O código local entrega descoberta, resposta progressiva e seleção de sacola; não implementa nem habilita envio/pagamento. As superfícies legadas foram [retiradas localmente](retirada-legado.md).

## Experiência esperada

1. A pessoa escreve o objetivo e a ocasião, sem preencher previamente um formulário.
2. A IA acolhe e sugere uma combinação pertinente: “Que lindo! Que tal um bolo acompanhado de uma flor? Vou procurar algumas opções.”
3. A API executa consultas independentes em paralelo, respeitando a localização da conta e os limites do turno.
4. A IA vê resultados sanitizados, pede detalhes dos itens relevantes e escolhe o que apresentar.
5. O servidor monta os cartões com nomes, preços compostos, entrega e limitações observadas. A pessoa pode refinar a busca pela conversa.

Orçamento, nomes e prioridade não são pré-requisitos de **descoberta informativa**. Adequação para consumo, composição de carrinho e envio continuam exigindo os dados relevantes. Complementos sugeridos são opcionais; pesquisar uma flor não significa adicioná-la à compra. Opções de lojas diferentes representam entregas e custos separados, sem prometer um único carrinho entre lojas.

“Instantâneo” significa resposta progressiva: a prévia aparece depois de identificar o destinatário e do primeiro passo de compras da IA, enquanto o catálogo é consultado. Não há promessa de latência zero nem ofertas disponíveis antes da resposta do iFood.

## Arquitetura implementada localmente

```text
Telegram → evento autenticado → RUN-01 / SQLite
                                  ↓
                       roteador de destinatários (sem fatos)
                                  ↓
                       recuperação por conta/pessoa/finalidade
                                  ↓
                       IA (GEMINI_API_KEY)
                       mensagem + contexto + ferramentas
                                  ↓
                       requests tipadas pelo schema
                                  ↓
                    API valida e executa consultas MCP
                                  ↓
                       resultados sanitizados → IA
                                  ↓
                    narração + cartões do servidor → Telegram
```

O protocolo usa saída JSON estruturada do Gemini. A IA **solicita** ferramentas por nome/argumentos; a execução pertence ao backend. Não há conexão direta do modelo ao MCP nem execução automática de JSON arbitrário.

Implementação:

- `src/server/assistant/protocol.ts`: ferramentas, entradas e schema de passos.
- `src/server/assistant/tools.ts`: executor autenticado, proveniência, normalização e apresentação de fatos.
- `src/server/assistant/processor.ts`: ciclo de decisão, contexto, orçamento, paralelismo e snapshot.
- `src/server/assistant/audience.ts`: identificação dos destinatários sem acesso aos fatos pessoais.
- `src/server/assistant/memory.ts`: pessoas, fatos compactos e validação da declaração original.
- `src/server/assistant/memory-store.ts`: consultas seletivas e commit transacional no SQLite.
- `src/server/ai/gemini.ts`: transporte Gemini compartilhado entre roteador e planejador, com contagem comum de chamadas/gasto.
- `src/server/assistant/bag.ts`: composição validada da GRP-01, cartões numerados e escolha de proposta persistida.
- `src/server/conversation-runtime.ts`: montagem pelo ambiente.
- `src/server/turns/runtime.ts`: prévia transitória por operação.

### Ferramentas do agente nesta entrega

`listAddresses`, `searchOffers`, `browseOffers`, `getRecommendations`, `getItem` e `getMerchant`.

Os nomes/campos MCP vêm do contrato observado em `fixtures/tools-list.json`. Os argumentos internos fazem uma projeção menor desse contrato:

- Localização e conta são resolvidas pela API, não fornecidas pelo modelo.
- `itemRef`, `merchantRef` e `nextPageRef` apontam para observações deste turno; não são IDs MCP inventados.
- A API valida a referência e só então injeta o ID ou cursor real na requisição.
- Cursores ficam vinculados à consulta que os retornou.
- Filtros monetários internos usam centavos; a conversão para BRL acontece na fronteira MCP.
- Busca retorna até seis candidatos por chamada; só itens detalhados por `getItem` podem virar cartões finais.
- Conteúdo de catálogo é dado, nunca instrução. Respostas privadas e erros brutos não são copiados para o contexto.
- Restrições pessoais são propostas por `memoryActions`, com referência à pessoa e trecho literal da mensagem atual. `contextActions` fica limitado a orçamento coletivo, prioridade e revisão; não cria participantes genéricos para o titular.

O contexto curto inclui somente os perfis selecionados e uma síntese estruturada das consultas anteriores para os mesmos destinatários/finalidade. Texto bruto da resposta anterior e participantes do domínio legado não são copiados. Referências transitórias `itemRef` não sobrevivem ao turno. Para FOOD, quando a GRP-01 encontra composição válida, os candidatos detalhados viram `SET_PROPOSALS` persistido com cartões numerados no mesmo commit; somente nesse caso se sincronizam participantes/restrições dos perfis. Restrição desconhecida impede incluir a pessoa como consumidora elegível; sem consumidor coberto não há proposta. A confirmação `Confirmo: escolher a opção 1.` resolve o número das propostas gravadas e aplica `SELECT_PROPOSAL`, sem chamar a IA nem escrever no iFood. A revisão/preparação real CART-01 é outra etapa, com gates próprios.

### Memória por titular e destinatário

Requisito solicitado: a restrição da namorada não vira restrição do titular, e só deve ser recuperada quando o pedido se relacionar a ela e à finalidade pertinente.

1. O roteador recebe a mensagem atual, um diretório com nomes/relações e o foco anterior. Não recebe alergias, dietas, preferências, ofertas, snapshots ou resumo livre da conversa.
2. A API valida nomes/relações explicitamente mencionados e pronomes com âncora inequívoca. Uma pessoa inventada, uma negação ou um pronome ambíguo produz pergunta de esclarecimento antes de ler os fatos.
3. Só então o SQL recupera os fatos da conta/vínculo, das pessoas selecionadas e da finalidade. Para flores, não são lidas as linhas de alergia/intolerância ou preferências alimentares.
4. A IA de compras recebe `context.people`, `targets`, `writableSubjects`, `purpose`, `budget` e `previous`. O titular usa `SELF`, apresentado como “Você”, sem nome criado pela API. Destinatários têm referências internas próprias, sem serem confundidos com contas iFood.
5. `memoryActions` só permite registrar dados sustentados por um trecho literal da mensagem humana atual e por uma pessoa autorizada pelo roteador. Catálogo e texto anterior do modelo não podem originar fatos pessoais.
6. Fatos novos, resumo do foco, snapshot e conclusão do turno são gravados na mesma transação. Falha, cancelamento, versão obsoleta e replay não gravam memória parcial nem repetem alterações.

Exemplos:

| Mensagem | Dados recuperados |
| --- | --- |
| “Quero uma pizza para mim” | Apenas condições/preferências alimentares do titular |
| “Quero um bolo para minha namorada” | Apenas condições/preferências alimentares dela |
| “Quero flores para minha namorada” | Preferências de presente dela; nenhuma condição alimentar |
| “Quero algo para nós dois” | Perfis separados, com condições avaliadas por consumidor |
| “Quero algo para ela” após pedido só para o titular | Pergunta quem é a pessoa; nenhum fato recuperado |

O foco para resolver pronomes dura até 15 minutos e é substituído a cada mudança de destinatário. A síntese de consultas só é reutilizada com o mesmo conjunto de pessoas e finalidade; não armazena uma frase livre que possa carregar restrições de outra pessoa. A memória não importa automaticamente os participantes legados como perfis do titular.

### Identidade e persistência: alcance real

O contrato observado de `getUser` usado pelo projeto ainda não entrega um `userId` estável ao adaptador. O gateway injeta a identidade iFood nas requisições autenticadas; não se cria um `userId` fictício nem se deduz identidade por nome/e-mail mascarado.

Nesta implementação, a partição é `(escopo Telegram autenticado, hash do linkId OAuth)`. Ela representa o vínculo autenticado da conta, não uma identidade estável comprovada entre reconexões. Troca de vínculo ou organizador não transfere perfis, fatos ou foco. Um novo login com novo `linkId` não recupera automaticamente a memória anterior, mesmo se o usuário acreditar ser a mesma conta. A futura associação entre reconexões exige um identificador estável verificado pelo provedor, antes de mapear para o mesmo perfil.

O schema atual é **v6**, unificando a v5 publicada e a v5 local anterior (que tinham formas diferentes). A migração preserva domínio, memória ou grupos antigos, eventos e intenções, sem importar grupos para SELF nem associar eventos retroativamente. Binários v5 e anteriores recusam v6. [Migração e compatibilidade](armazenamento-v6.md).

As tabelas `assistant_memory_accounts`, `assistant_memory_people` e `assistant_memory_facts` armazenam fatos curtos tipados, referência à pessoa, evento de origem e hash do trecho que sustentou a declaração. O trecho bruto não é salvo nessa memória. O limite é 21 pessoas por vínculo/escopo (incluindo titular), até 40 fatos por pessoa. As condições sobrevivem a reinício e às mensagens da conversa; o expurgo D7 permitido após 24 horas de inatividade remove os fatos do escopo. “Limpar tudo” limpa a memória do vínculo atual e encerra a compra ativa; “Meus dados” remove somente os fatos SELF. Não é memória de retenção ilimitada.

### Confirmações digitadas e diretório de memória

A administração da memória usa textos fixos confirmados por botão no bot, tratados pelo processor antes de qualquer modelo:

- `Confirmo: apagar todos os dados deste pedido.` — limpa a memória do turno e encerra (fluxo CLEAR existente).
- `Confirmo: apagar meus dados da memória.` — remove somente os fatos do titular (SELF) do vínculo; destinatários continuam registrados.
- `Confirmo: remover <rótulo> do pedido.` — resolve o rótulo no diretório do vínculo atual e remove a persona e os fatos dela. Rótulo desconhecido responde que nada foi alterado. Não remove automaticamente o participante DATA-01 ou itens de uma sacola já composta.

A rota `GET /api/bot/v1/conversations/:conversationId/memory` devolve `{contractVersion: "1.0", revision, recipients, enabled}`. A lista contém destinatários `RECIPIENT` explicitamente salvos (ref e rótulo, sem fatos), excluindo SELF. Sem vínculo conhecido: `enabled: false` e lista vazia. O bot obtém até dez botões de remoção desse diretório; quando a extensão está ausente/desabilitada usa nomes do bloco GROUP por compatibilidade. Uma lista vazia com extensão ativa é respeitada, sem fallback. O titular usa o controle separado “Meus dados”.

Novos fatos/foco usam o commit do turno. Restrição nova de consumidor já existente também atualiza seu domínio e invalida a sacola, mesmo sem nova busca; memória não cria participante genérico. Exclusões SELF/destinatário são administração direta de `MemoryReader`, não remoção automática de participante/item. Limpar tudo usa limpeza no resultado e END quando há compra ativa. Nenhum desses comandos revoga OAuth nem cancela carrinho/pedido no iFood.

O bot também captura `sessionRef` em `/account-context`, conserva-o na outbox e usa `X-Conversation-Session` em envio/consulta/replay. A API recusa referência antiga; ausência do cabeçalho mantém o caminho de compatibilidade sem associação por evento. Detalhes no [contrato HTTP](conversation-api-v1.md#sessão-do-vínculo-atual).

Filtros de dieta são calculados pelos fatos selecionados: intolerância obrigatória à lactose usa `LAC_FREE`, preferência opcional não vira filtro duro e alergia a leite não vira “sem lactose”. Para vários consumidores, apenas filtros comuns são usados na consulta geral; a avaliação alimentar continua separada por pessoa. Filtro e descrição do catálogo não comprovam segurança de alergia.

### Exemplo de decisão da IA

```json
{
  "message": "Que lindo! Que tal um bolo acompanhado de uma flor? Vou procurar algumas opções.",
  "requests": [
    { "name": "searchOffers", "arguments": { "query": "bolo", "merchantType": "RESTAURANT" } },
    { "name": "searchOffers", "arguments": { "query": "flor", "merchantType": "SHOPPING" } }
  ],
  "itemRefs": []
}
```

Depois de receber resultados, a IA solicita `getItem` com as referências observadas. No último passo, retorna `requests: []` e até quatro `itemRefs`. Nome, preço, prazo, bloqueios e entrega são renderizados pela API; o texto social do modelo não é fonte de cotação ou confirmação de compra.

### Limites e falhas

- Uma identificação de destinatários e até quatro passos de compras da IA, quatro consultas simultâneas e dez consultas solicitadas por turno.
- Prazo total de 45 segundos; prazo de até oito segundos nas consultas de catálogo. Leitura/verificação de endereço usa os wrappers existentes, sempre contida pelo prazo total do turno.
- Consultas idênticas dentro do turno reutilizam a mesma promise, inclusive falhas; não há repetição cega.
- Cada passo reserva e ajusta o orçamento OPS-02. Roteador e planejador compartilham os limites do adaptador Gemini.
- Falha de provedor ou saída inválida preserva versão/domínio; o runtime não grava um sucesso fictício.
- Troca de vínculo invalida a leitura antes de publicar o resultado.
- Listagem vazia, falha e ausência de endereço são estados diferentes.

O endereço deve estar escolhido pelo canal humano existente. Este incremento não implementa cadastro de endereço; a proibição histórica de `createAddress` permanece separada do novo contrato de descoberta.

## Resposta progressiva para o Telegram

O contrato v1 de evento/operação/snapshot permanece compatível. A extensão é:

```text
GET /api/bot/v1/conversations/:conversationId/operations/:operationId/progress
```

Mesma autenticação e identidade Telegram das demais rotas. Retorna:

```json
{
  "contractVersion": "1.0",
  "enabled": true,
  "operationId": "referencia-da-operacao",
  "eventId": "evento-original",
  "text": "Que lindo! Que tal um bolo acompanhado de uma flor?"
}
```

`text` é `null` antes da prévia, depois do término/cancelamento ou quando não há prévia. Ela fica somente na RAM do worker, não em logs, SQLite ou cache HTTP (`Cache-Control: no-store`). Reiniciar perde a prévia; a operação durável continua sendo a fonte do resultado final.

O cliente Telegram consulta a extensão durante a operação pendente, apresenta a prévia uma vez e edita a mesma mensagem com o resultado final. Uma API anterior que devolve 404 desliga apenas essa consulta opcional no cliente. Falha da prévia não interrompe o acompanhamento do resultado final.

## Configuração

Além do runtime, adaptador autenticado e configuração AI-01 existentes:

```dotenv
CONVERSATION_MODEL_ENABLED=true
CONVERSATION_MODEL_PROVIDER=google
CONVERSATION_MODEL=gemini-3.8-flash
GEMINI_API_KEY=<chave configurada no ambiente do servidor>
CONVERSATION_MODEL_MAX_REQUESTS=<limite explícito>
```

`BOT_API_TOKEN` autentica Telegram → API; `GEMINI_API_KEY` autentica API → IA; OAuth autentica API → iFood. São credenciais distintas. A chave da IA não vai ao bot, ao prompt nem à resposta HTTP. O assistente é o único processador, mas continua sem montagem quando o modelo está desligado. Remova `CONVERSATION_AGENT_MODE`; o antigo valor `structured` é recusado. Nenhuma configuração operacional foi alterada nesta implementação local.

## Fechamento desejado: botão “Confirmar e fazer pedido”

Fluxo de produto solicitado, **a implementar no incremento BUY-01/BUY-02**:

1. Pessoa escolhe produtos, opções e quantidades pela conversa.
2. API prepara/sincroniza o carrinho pelo contrato CART-01 e consulta seu estado atual.
3. Pessoa escolhe entrega e pagamento entre opções realmente retornadas.
4. Bot mostra revisão final: loja, itens/opções/quantidades, endereço exato, prazo, pagamento identificado de forma mascarada, descontos, taxas e total confirmado.
5. Bot oferece **“Confirmar e fazer pedido — R$ X”** e uma ação para voltar/editar.
6. O clique humano validado autoriza `SUBMIT_ORDER` somente para essa revisão. A API relê o carrinho, verifica a igualdade da revisão e registra intenção durável antes da chamada.
7. Somente resposta externa verificada permite mostrar “Pedido confirmado”, com identificador e acompanhamento. Timeout mantém resultado desconhecido até reconciliação, sem segundo envio automático.

Contrato de confirmação:

- Finalidade `SUBMIT_ORDER`, distinta de `PREPARE_CART`.
- Vínculo a organizador, conta/vínculo, carrinho, versão/hash, composição, entrega, pagamento, total e validade.
- Callback autenticado pelo adaptador e preso ao bot/chat/mensagem originais; referência opaca fora do contexto da IA.
- Alteração de item, preço, taxa, entrega, endereço, pagamento ou vínculo invalida o botão anterior.
- Uso único, intenção persistida e recuperação idempotente após reinício.
- A sugestão da IA não conta como clique; “sim” nesta conversa de desenvolvimento não autoriza uma compra real.
- PIX e outros meios com ação humana adicional precisam apresentar essa etapa; o botão não pode prometer pagamento já concluído.
- Produtos de lojas distintas exigem fechamentos/revisões independentes, salvo futuro contrato explícito do provedor.

Este documento registra a direção solicitada sem apresentar como entregues os contratos de saída de pagamento/envio, a reconciliação externa ou a jornada real de compra. Implementar/ensaiar essa etapa exige os outputs e garantias ainda pendentes em INT-02 e BUY-01/BUY-02; habilitar F7 por flag não os substitui.

## Verificação

Os testes novos exercitam modelo roteirizado e transporte Gemini sintético, SQLite/HTTP reais, buscas paralelas, detalhe/proveniência, limite de chamadas, replay, prévia isolada e compatibilidade do cliente. `test/assistant/memory.test.ts` cobre isolamento por conta/pessoa, ausência da condição dela no pedido do titular, não leitura de fatos alimentares para flores, histórico contaminado, retomada, pronomes, filtros, rollback, exclusão e reinício. Não são inferência real do modelo nem operação iFood. Qualidade de linguagem e latência precisam de ensaio com a chave de teste explicitamente configurada.
