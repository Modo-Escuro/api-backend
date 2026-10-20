# Continuidade automática e endereço iFood — 18/10/2026

Origem histórica: main@8a6dadc e branch de continuidade. O diagnóstico abaixo pertence àquele incremento. Na reconciliação atual há assistente único, executor com seleção observada e [SQLite v6](armazenamento-v6.md). [Sincronização GitHub](sincronizacao-github.md) distingue o código consultado dos serviços online não conferidos.

## Causa e fluxo

O bot já possuía outbox durável e worker com polling da RUN-01. A navegação adicionada no #15 passou a anexar ReplyKeyboardMarkup ao envio de processamento; o worker depois tentava editar essa mensagem. A Bot API só permite editar mensagens sem reply markup ou com teclado inline ([contrato Telegram](https://core.telegram.org/bots/api#updating-messages)). O erro 400 entrava em DELIVERY_UNKNOWN e o comando manual descartava o ID da entrega, enviando outra mensagem. A combinação foi reproduzida em transporte sintético fiel; a imagem é compatível com ela, mas não substitui diagnóstico de logs privados da instância.

O caminho continua: Telegram → outbox SQLite do bot → POST idempotente RUN-01 → operação persistida → GET limitado do worker → snapshot atual → envio/edição Telegram. A correção está no bot; a API não refaz RUN-01 nem cria turno ao consultar operação, endereço ou snapshot. Login só agenda consultas informativas e acompanhamento seguro de operações conhecidas.

## Contrato adicional

Prefixo: `/api/bot/v1/conversations/:conversationId`.

| Rota | Comportamento |
| --- | --- |
| `GET /addresses` | Exige runtime, Bearer, organizador/conversa privados, rollout, vínculo operacional e escopo observado `mcp.user.addresses.read`. Chama `listAddresses({})`; retorna EMPTY ou CHOICE_REQUIRED, hash técnico do vínculo e opções com referência opaca, resumo e prazo |
| `POST /addresses/select` | Corpo estrito `{source:"TELEGRAM_CALLBACK",choiceRef}`. Revalida vínculo/lista/hash/validade, persiste somente a referência autorizada e responde SELECTED; sem Gemini ou escrita MCP |

O schema de entrada `{}` vem de `fixtures/tools-list.json`. A projeção conservadora de saída usa os campos já observados/tipados em `mcp/types.ts`: addressId, alias, location, coordinates, formattedAddress e postalCode; os dois últimos entram apenas no hash, nunca no resumo. Não há nova captura autenticada nesta entrega. Formato inesperado, erro inline, lista duplicada, timeout, escopo desconhecido e vínculo trocado falham como indisponibilidade; nunca viram lista vazia.

O usuário exige confirmação mesmo com um endereço, prevalecendo sobre a descrição da ferramenta que permitiria uso automático. Zero orienta cadastro no app iFood; não há createAddress. Múltiplos endereços têm botões numerados. Resumo usa Casa/Trabalho e bairro/cidade, ou rua sem número. Resumos indistinguíveis/longos bloqueiam a escolha em vez de adivinhar.

Opções ainda não autorizadas ficam somente na RAM por cinco minutos; reinício invalida seus botões. A tabela aditiva `delivery_address_selected` no SQLite da RUN-01 guarda escopo, hash de vínculo, addressId autorizado, hash do endereço, hash da referência escolhida e prazo de 24 h. Não guarda lista, texto, endereço completo ou coordenadas. Replay da escolha reconhecida sobrevive a reinício, sem voltar para uma escolha substituída. Não altera user_version nem rebaixa esquema CART-01.

Na montagem atual, `AssistantTools` lê a lista e confere addressId/hash da seleção autorizada antes de consultar ofertas; também verifica o vínculo após a chamada. Sem seleção, informa ADDRESS_REQUIRED e não busca ofertas. O executor mantém a lista por turno; a revisão CART-01 realiza nova releitura antes da escrita, sem prometer atomicidade entre catálogo e entrega. `runEvaluation` mantém sua própria verificação de addressId e compatibilidade de endereço único; isso não é seleção automática no assistente. A ponte de propostas não garante SET_ADDRESS em toda composição. O modelo não recebe endereço, coordenadas ou referência humana.

## Arquivos e regressões

- `services/address-reference.ts`: schema e validação da referência atual, compartilháveis com CART-01.
- `services/delivery-addresses.ts`: revisão, seleção persistente e releitura autenticada.
- `routes/conversation.ts` e `app.ts`: fronteira autenticada adicional, erros fixos e cache no-store.
- `conversation-runtime.ts`, `assistant/tools.ts` e `assistant/processor.ts`: seleção autorizada, consultas e pendência de endereço sem impedir conversa. O provedor `services/group.ts` e `agent/` foram retirados.
- `test/addresses.test.ts`: zero/um/múltiplos, origem/autenticação/isolamento, replay/reinício, expiração, remoção/mudança, vínculo trocado, erro/schema/timeout e nenhuma busca antes da escolha.
- `test/assistant/assistant.test.ts`: catálogo bloqueado sem seleção, com endereço confirmado nos ensaios de consulta; não relaxa elegibilidade alimentar. Os testes antigos de wiring/hardening pertenciam ao processador retirado.

Checks finais e SHAs ficam na descrição do PR. Typecheck/lint/build e suíte completa são obrigatórios. Os testes usam SQLite/HTTP reais e OAuth/MCP/Gemini sintéticos; não comprovam operação iFood.

## GO/NO-GO e deploy coordenado

GO técnico é limitado à revisão do código com verificações aprovadas. NO-GO de produção até revisão, autorização de merge/deploy e ensaio controlado. CART-01 segue desligada e precisa conferir esta seleção autorizada além de reler vínculo/listAddresses antes de cada escrita; preparar não autoriza pedido/pagamento.

1. Preservar os bancos e eventuais WAL/SHM; conferir uma instância de cada serviço e os SHAs revisados. Sem restauração antiga sobre operações pendentes.
2. Implantar API primeiro, com o mesmo banco/vínculos e cart/pagamento/envio desligados. Conferir autenticação, rollout e rotas novas com usuário sintético autorizado.
3. Implantar bot depois, preservando outbox/cursor e um polling. Mensagens novas do worker têm markup editável. Entrega anterior realmente incerta não pode ser reenviada automaticamente sem risco de duplicação; recuperação manual continua explícita.
4. No ensaio humano: enviar texto e aguardar resposta automática; conectar pelo navegador e aguardar contexto/endereço; conferir zero/um/múltiplos, escolha e retomada. Repetir com reinício, outro organizador, sessão indisponível e endereço removido em ambiente controlado. Não provocar compras reais.
5. Rollback funcional preserva armazenamento; binários v5 e anteriores recusam v6. Não rebaixar schema nem restaurar cópia antiga sobre intenções. Bot precisa conservar contrato/outbox compatíveis; pausar conversa em transição incompatível. Referência não autoriza negócio por si só.
