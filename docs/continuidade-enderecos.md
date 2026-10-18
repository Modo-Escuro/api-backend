# Continuidade automática e endereço iFood — 18/10/2026

Base: `main@8a6dadc82ff8c7e952b665dedad6876677fade6b`. Branch separada `codex/conversation-continuity-addresses`; os drafts CART-01 #46 e bot #17 foram preservados. Não houve merge, deploy, mudança de flags/volumes ou operação externa. Foram lidos CLAUDE.md, plano-conversacional.md, contrato bot/API, RUN-01, ligação Gemini/GRP-01 e regras de vínculos.

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

Sugestões da montagem de produção exigem a referência confirmada e revalidam vínculo/endereço antes e depois da busca. `runEvaluation` também confere addressId na lista; o fallback antigo do único endereço permanece apenas no avaliador legado, fora do agente montado. Remoção/mudança/troca durante a busca impede aplicar propostas. DATA-01 recebe SET_ADDRESS com SET_PROPOSALS no commit normal da RUN-01; sem seleção, coleta de pessoas/restrições/orçamento continua e as sugestões ficam pendentes. O modelo nunca recebe a referência de confirmação.

## Arquivos e regressões

- `services/address-reference.ts`: schema e validação da referência atual, compartilháveis com CART-01.
- `services/delivery-addresses.ts`: revisão, seleção persistente e releitura autenticada.
- `routes/conversation.ts` e `app.ts`: fronteira autenticada adicional, erros fixos e cache no-store.
- `conversation-runtime.ts`, `services/group.ts` e `agent/processor.ts`: conexão com a montagem existente e pendência de endereço sem impedir coleta.
- `test/addresses.test.ts`: zero/um/múltiplos, origem/autenticação/isolamento, replay/reinício, expiração, remoção/mudança, vínculo trocado, erro/schema/timeout e nenhuma busca antes da escolha.
- Testes de wiring/hardening foram atualizados para confirmar o endereço explicitamente antes de testar sugestões; não se relaxaram os bloqueios alimentares ou critérios de sucesso.

Checks finais e SHAs ficam na descrição do PR. Typecheck/lint/build e suíte completa são obrigatórios. Os testes usam SQLite/HTTP reais e OAuth/MCP/Gemini sintéticos; não comprovam operação iFood.

## GO/NO-GO e deploy coordenado

GO técnico é limitado à revisão do código com verificações aprovadas. NO-GO de produção até revisão, autorização de merge/deploy e ensaio controlado. CART-01 segue desligada e precisa conferir esta seleção autorizada além de reler vínculo/listAddresses antes de cada escrita; preparar não autoriza pedido/pagamento.

1. Preservar os bancos e eventuais WAL/SHM; conferir uma instância de cada serviço e os SHAs revisados. Sem restauração antiga sobre operações pendentes.
2. Implantar API primeiro, com o mesmo banco/vínculos e cart/pagamento/envio desligados. Conferir autenticação, rollout e rotas novas com usuário sintético autorizado.
3. Implantar bot depois, preservando outbox/cursor e um polling. Mensagens novas do worker têm markup editável. Entrega anterior realmente incerta não pode ser reenviada automaticamente sem risco de duplicação; recuperação manual continua explícita.
4. No ensaio humano: enviar texto e aguardar resposta automática; conectar pelo navegador e aguardar contexto/endereço; conferir zero/um/múltiplos, escolha e retomada. Repetir com reinício, outro organizador, sessão indisponível e endereço removido em ambiente controlado. Não provocar compras reais.
5. Rollback: reverter bot primeiro. A API antiga voltaria a aceitar fallback de endereço único no agente; se for necessário revertê-la, desabilitar sugestões/conversa durante a transição. Tabelas aditivas preservam referências e não autorizam negócio por si só.
