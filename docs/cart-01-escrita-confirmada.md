# CART-01 — Escrita de carrinho confirmado pelo organizador

**Continuação:** [apresentação completa e auditoria](cart-01-conclusao-offline.md) acrescentam conta mascarada, loja/endereço e nomes de opções/remoções, vinculados por hash, além da composição/custos observados na consulta final. A publicação em draft não fornece evidência real do iFood nem ativa escrita.

[Auditoria original](cart-01-auditoria.md) · [Integração atual](cart-01-integracao.md) · [INT-02 #40 — gate externo](https://github.com/Modo-Escuro/api-backend/issues/40).

Revisão de escopo autorizada pelo usuário em 18/10/2026. Substitui a proibição geral de escrita da D8/D10 **somente** para criar e alterar itens do carrinho real, após confirmação humana específica. `submitOrder`, `setCartPayment` e processamento de pagamento continuam proibidos. Nenhuma produção foi alterada.

## Fluxo implementado

DATA-01/GRP-01 continuam sendo a fonte única de participantes, restrições, limites, propostas e carrinho escolhido. CART-01 não mantém outra carrinho nem outro rateio. Guarda somente plano técnico, confirmação, intenção e projeção sanitizada do carrinho remoto, no mesmo SQLite da RUN-01/DATA-01. DOM-01 calcula dinheiro e rateio.

Migração aditiva **v2 → v3**, em transação. O número da versão impede que um binário anterior ignore bloqueios CART-01. Rollback funcional desliga o opt-in; não rebaixa o banco nem apaga PENDING/RESULT_UNKNOWN. O ciclo da RUN-01 recupera intenções vencidas mesmo sem montar o serviço de carrinho: sem possível efeito vira FAILED; com efeito possível vira RESULT_UNKNOWN e continua bloqueado.

1. Organizador escolhe proposta atual na GRP-01. A integração do callback no Telegram pertence à BOT-03.
2. Adaptador autenticado solicita revisão, sem enviar preço, produto, restrição, participante ou consentimento no corpo.
3. Servidor valida compra ativa, carrinho CURRENT, cobertura completa, limites declarados, vínculo operacional e permissões de descoberta/leitura/escrita. Resolve endereço em `listAddresses`, relê disponibilidade e `getItem`, confere loja, produtos, opções, quantidade e elegibilidade por consumidor. Alergia sem evidência permanece bloqueada.
4. Se já houver cartId, relê `getCart` e calcula as mutações necessárias para a composição desejada. Não deduz `cartItemId` de `itemId`. Alterações de pagamento, entrega ou cupom não fazem parte deste incremento.
5. Revisa o contrato: schemas anunciados devem coincidir com o manifesto de evidência; respostas autenticadas observadas devem passar nos parsers instalados. `tools/list`, escopos e um arquivo com nomes não comprovam saída nem efeito.
6. Emite referência opaca de uso único, finalidade PREPARE_CART, hash, versão e expiração em cinco minutos. Exibe composição e soma dos preços observados. Custos desconhecidos não viram zero nem total confirmado.
7. Após clique humano, o adaptador chama a rota dedicada. A aplicação revalida catálogo, vínculo, domínio e carrinho; consome confirmação e grava intenção PENDING em transação BEGIN IMMEDIATE. A chamada MCP ocorre fora da transação.
8. Antes de cada escrita, persiste o marcador de possível efeito. Confirma cada resposta, salva cartId imediatamente e relê carrinho. Falha parcial interrompe a sequência. Nova alteração exige outra revisão/confirmacão, não retoma passos automaticamente.
9. Recalcula custos conhecidos com DOM-01. Composição, preço, taxas ou desconto incompatíveis impedem afirmar orçamento validado. Mesmo SUCCEEDED só comprova as operações de carrinho, nunca pedido ou pagamento.

## Contrato humano e fronteira com BUY-01

Prefixo `B = /api/bot/v1/conversations/:conversationId/cart-writes`.

| Método/rota | Contrato |
| --- | --- |
| `POST B/reviews` | JSON `{}`; compra/carrinho vêm da DATA-01. Resposta contém `confirmationRef`, finalidade, versão, hash, expiração, composição, operações e incerteza do total |
| `POST B/confirm` | `{purpose:"PREPARE_CART",source:"TELEGRAM_CALLBACK",confirmationRef,requestId,callbackId}`; schema estrito; referência/ID preservados no replay |
| `GET B/current` | Consulta o carrinho conhecido, custos e bloqueios. Não limpa resultado desconhecido |
| `GET B/operations/:operationId` | Recupera estado da mesma intenção, sem escrever novamente |
| `GET B/requests/:requestId` | Recupera a intenção pelo requestId persistido pelo adaptador, escopado ao mesmo principal. Não repete confirmação nem consulta MCP |

Exige Bearer do adaptador, `X-Telegram-User-Id` validado pela autenticação e `X-Telegram-Chat-Id` igual ao organizador/conversa privados. A lista `CONVERSATION_ORGANIZER_IDS` também restringe estas rotas e nunca amplia a autenticação. Callback humano é atestado pelo adaptador autenticado, como na conexão; não é uma prova criptográfica independente do Telegram. A integração BOT-03 precisa conferir remetente, chat e mensagem do callback. Proteger o token do adaptador do modelo e de outros clientes. Falhas MCP/SDK na nova fronteira recebem mensagem fixa, sem corpo/erro bruto do provedor.

O plano vincula finalidade, organizador/bot/conversa, compra, versão, hash do domínio, linkId, endereço, loja, composição, catálogo observado, estado remoto e prazo. A referência em claro só volta ao canal humano; SQLite guarda seu hash. Callback ID é guardado como hash e não pode ser usado para outra intenção. Nenhum booleano `userConsent`/`humanConfirmed` é aceito. O vocabulário/modelContext da IA não recebeu essas referências nem novas ações de aprovação.

BUY-01 futuro deve emitir **outra** autorização, finalidade SUBMIT_ORDER, após custo completo confirmado e revisão apta. Deve ligar responsável, conta, versão, composição, entrega, custos e prazo; consumir autorização junto da intenção de envio durável. PREPARE_CART não pode ser convertido ou reutilizado para isso. `/purchase-approvals`, rotas legadas `/approve`/`submit` e o gateway de pagamento continuam bloqueados.

## Persistência e falhas

| Estado | Significado e recuperação |
| --- | --- |
| PENDING | Confirmação consumida e intenção gravada; não se inicia outra escrita do organizador. Replay consulta, nunca retoma execução. Após interrupção e expiração do prazo técnico, possível efeito vira RESULT_UNKNOWN; prefixo reconhecido sem chamada em voo vira FAILED, com cartId preservado |
| SUCCEEDED | Todas as mutações foram reconhecidas e composição final relida; ainda é só carrinho |
| FAILED | Falha antes de possível efeito desconhecido ou sequência interrompida após efeitos já reconhecidos. Pode ter `completedOperations > 0`; consultar e preparar nova revisão |
| RESULT_UNKNOWN | Pode haver efeito remoto não comprovado. Bloqueia novas escritas, inclusive outro requestId ou reconexão. Intenção interrompida expira conservadoramente nesse estado |

`(scope,requestId)` é único; mesmo ID com conteúdo diferente conflita. Duas intenções diferentes podem ter valor igual. A confirmação e intenção são gravadas juntas. O domínio não faz commit durante PENDING/RESULT_UNKNOWN; expurgo D7 não apaga bloqueios pendentes. Após expurgo de compra concluída, conserva tombstones técnicos e limpa composição persistida.

Criação sem cartId e resultado desconhecido não têm recuperação confiável demonstrada. `getCart` parecido com o esperado não prova que uma escrita atrasada deixou de acontecer. A consulta registra observação, mas não remove o bloqueio. Não há botão/endpoint de forçar sucesso, nem retry automático de escrita ou após 401. Sem contrato confiável de reconciliação, permanece NO-GO para novas mutações daquela intenção.

Releitura antes da escrita detecta mudanças observadas; não torna a validação e mutação remotas atômicas. Sem ETag/revisão condicional no contrato, não se promete eliminar a corrida com outro cliente. A releitura posterior detecta divergência e interrompe a sequência. SQLite protege coordenação local, não execução única externa.

## Configuração de desenvolvimento e gate externo

Padrão: `IFOOD_CONFIRMED_CART_WRITES_ENABLED=false`. Quando explicitamente ativada em ambiente de teste, exige RUN-01/DATA-01 com banco persistente e `IFOOD_CART_CONTRACT_EVIDENCE_FILE` apontando para manifesto privado. Não exige AI-01, provedor/modelo ou sua conclusão. Quando Gemini também está montado, ambos compartilham a DATA-01 e a F7 permanece desligada; o serviço de vínculos anuncia somente CART_READ/CART_WRITE conforme escopos, sem liberar CART_PAYMENT. A F7 antiga permanece sem escrita operacional, mesmo com sua flag ativa.

Manifesto v1: endpoint `/marketplace`, `source:OBSERVED_AUTHENTICATED`, `businessToolsCalled:true`, `parserSha256` (arquivo contracts.ts normalizado para LF), e por ferramenta `name`, `inputSchemaSha256` (JSON canônico por contentHash), `observedAt`, `samplePath`, `sampleSha256` (JSON canônico). Necessita getCart e cada mutação realmente usada. Amostras sanitizadas devem preservar campos contratuais e não conter dados privados. O manifesto registra a origem declarada pelo operador, não substitui revisão humana da evidência. Não há manifesto operacional incluído porque não recebemos essas capturas.

Ferramentas iFood não estão registradas nesta sessão do agente. Não houve leitura de credenciais, login, chamada de negócio ou ensaio externo. A ausência de outputSchema não autoriza inventar resposta. Testes usam gateway e evidência **mockados**, sem declarar amostras sintéticas como observadas.

## Critérios antes de PR e ativação

- Auditoria independente do diff; corrigir riscos reproduzidos e acrescentar regressões.
- `npm test`, `npm run typecheck`, `npm run lint`, `npm run build` e `git diff --check` aprovados.
- Preservar implementação concorrente da CART-01 de Maylon e conferir branches/PRs antes de publicar, sem sobrescrever trabalho não publicado.
- Para ativação real: evidência de contrato, ambiente de teste e callback humano BOT-03 específicos, limites do comportamento remoto registrados. Este código/CI não comprova esses critérios.
- A entrega original foi mantida sem commit/push. A continuação e o estado do PR estão no relatório de integração; não habilitar o recurso, fazer merge/deploy ou chamar operações externas como parte desta validação offline.

O briefing original de fechamento continua pendente em BUY-01/BUY-02/QA-01. A aprovação deste novo escopo não o declara atendido.
