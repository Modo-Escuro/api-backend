# Contrato de conversa HTTP/JSON v1.0 — API-01

Contrato conferido na reconciliação local de 20/10. HTTP continua v1.0, com schemas/pins preservados; o banco é [SQLite v6](armazenamento-v6.md). `conversation-runtime.ts` monta só o assistente, por opt-ins de runtime/modelo; sem processador, eventos novos recebem UNAVAILABLE. Estado/patches são DATA-01 e preparação usa CART-01/PREPARE_CART próprios. Envio/pagamento e `/purchase-approvals` continuam indisponíveis.

Issue: [API-01 #12](https://github.com/Modo-Escuro/api-backend/issues/12). Base de implementação: `main@686300d`. A [proposta v0 do bot](https://github.com/Modo-Escuro/telegram-bot/blob/codex/plano-conversacional/docs/contrato-conversa-proposto.md) é a origem; este documento fixa nomes e formatos para a v1.0. O [contrato de vínculo existente](bot-api.md) continua válido e independente. Nenhum OAuth novo foi criado.

## Artefatos normativos

- Fonte dos tipos e validação estrutural: [conversation.ts](../src/server/contracts/conversation.ts).
- Regras entre campos, escopo, versões e referências: [guards.ts](../src/server/contracts/guards.ts).
- Mensagens de erro fixas e status HTTP: [errors.ts](../src/server/contracts/errors.ts).
- [Schemas JSON Draft 2020-12](../contracts/conversation/v1/) e [exemplos sintéticos positivos/negativos](../contracts/conversation/v1/examples.json), compartilhados com Python.

O JSON Schema valida estrutura; as regras semânticas são parte obrigatória do contrato. Os handlers executam ambas, conferem escopo e persistem atomicamente pelo runtime; futuras integrações de compra também devem validar domínio/provedor. Um objeto que passa no schema não é autorização para executar uma ação. Os guards não consultam o iFood, não consomem autorização e não substituem BUY-01.

## Identidade e escopo

Reutilizar `Authorization: Bearer <BOT_API_TOKEN>` e `X-Telegram-User-Id` do [bot-api](bot-api.md). Para as novas rotas, acrescentar `X-Telegram-Chat-Id`, derivado pelo adaptador do update/callback autenticado. O adaptador confere conversa privada, `from.id`, `chat.id`, bot destinatário e allowlist; a API exige chat privado correspondente ao organizador no recorte atual. Esse header não vem de texto ou do modelo.

`AdapterPrincipal` é contexto confiável do middleware: organizador autenticado, bot cadastrado por `BOT_TELEGRAM_ID` e conversa privada validada. `source.botId` é conferido contra esse cadastro, nunca usado para escolher a própria identidade. O rollout `CONVERSATION_ORGANIZER_IDS` restringe os usuários já admitidos pela autenticação; não amplia acesso.

`conversationId` é o ID da conversa privada do Telegram como string decimal. Não é um `userId` do iFood e não é enviado ao MCP. O estado lógico da conversa pode conter compras sucessivas; identidade de compra/intenção será persistida por DATA-01, sem deduplicar compras pelo valor. Número de compras ativas continua decisão de DEC-01.

IDs de eventos e origem são metadados, não autorização. Operações, referências e snapshots só são acessíveis no escopo `(canal, bot, organizador, conversa)`. Outro organizador/conversa/recurso retorna 404 sem revelar existência; origem de outro bot/chat dentro da requisição autenticada retorna 400 `INVALID_SOURCE`. Referências de conta também são vinculadas ao `linkId` atual.

### Sessão do vínculo atual

`GET /conversations/{conversationId}/account-context` retorna `{enabled:true,sessionRef}` quando o runtime tem `sessionOf`, ou `{enabled:false}` caso contrário. Não usa o envelope de snapshot nem anuncia identidade estável iFood. `sessionRef` é uma referência hexadecimal de 64 caracteres derivada do bot/organizador/vínculo atual, inclusive do estado sem vínculo; muda quando esse vínculo muda.

O cliente captura a referência para cada evento novo e envia `X-Conversation-Session` em POST de evento/cancelamento e GET de operação/progresso/snapshot. Deve persistir a referência junto do comando, sem trocar pela sessão atual durante replay. Referência diferente da atual, operação associada a outra sessão ou replay incompatível retorna `409 LINK_CHANGED`. Sem associação correspondente, a consulta de snapshot retorna documento neutro na versão corrente. O runtime também revalida a sessão do trabalho associado antes/depois do processamento.

O cabeçalho é opcional por compatibilidade: ausente/vazio não associa o evento. API anterior pode devolver 404 em account-context, tratado pelo bot como extensão ausente. Não atribuir a garantia a eventos antigos nem interpretar a referência como consentimento ou identidade estável entre reconexões. [Migração v6](armazenamento-v6.md).

## Rotas v1 e disponibilidade

Prefixo `/api/bot/v1`. Todas exigem o canal autenticado e `Cache-Control: no-store`. Corpos JSON são estritos; não aceitar `organizerId`, `userId`, `userConsent`, preços ou autorização do modelo. Usar `Content-Type: application/json`. Erros de autenticação já existentes conservam o envelope de `bot-api.md`; depois da autenticação, os erros usam `error.schema.json`.

| Método e rota | Entrada / saída | Semântica |
| --- | --- | --- |
| `POST /conversations/{conversationId}/events` | `event.schema.json` → `operation.schema.json` | 202 somente após aceitação persistida; replay idêntico retorna 200 com a operação original e seu estado atual |
| `GET /conversations/{conversationId}/operations/{operationId}` | sem corpo → `operation.schema.json` | 200, sem efeitos; operação inexistente/de outro escopo → 404 |
| `GET /conversations/{conversationId}` | sem corpo → `snapshot.schema.json` | 200 com versão corrente e ações revalidadas; inexistente → 404 |
| `GET /conversations/{conversationId}/account-context` | sem corpo → `{enabled,sessionRef?}` | Referência atual da sessão; não cria evento nem autoriza compra |
| `GET /conversations/{conversationId}/memory` | sem corpo → diretório descrito abaixo | Personas salvas do vínculo atual, sem fatos |
| `GET /conversations/{conversationId}/operations/{operationId}/progress` | sem corpo → prévia descrita abaixo | Somente RAM da operação ativa; mesmos controles de escopo/sessão da consulta da operação |
| `GET /conversations/{conversationId}/addresses` | sem corpo → EMPTY/CHOICE_REQUIRED e opções opacas | Leitura autenticada, sem selecionar automaticamente o único endereço |
| `POST /conversations/{conversationId}/addresses/select` | `{source:"TELEGRAM_CALLBACK",choiceRef}` → SELECTED | Seleção humana revalidada e persistida; não escreve no MCP |
| `POST /conversations/{conversationId}/operations/{operationId}/cancel` | `cancel.schema.json` → `cancelResult.schema.json` | 202 `REQUESTED`; 200 `CANCELLED`/`ALREADY_TERMINAL`; replay recupera o resultado do mesmo comando; não garante cancelamento remoto |
| `POST /conversations/{conversationId}/purchase-approvals` | `approval.schema.json` → `operation.schema.json` | caminho humano dedicado; 202 após autorização/intenção durável; replay idêntico → 200; permanece indisponível até BUY-01/02 |

IDs no path e no corpo devem coincidir. A primeira aceitação cria a conversa com versão inicial 0 em transação, somente após autenticação/escopo. O bot não escolhe outro organizador ao criar conversa. Consultas não criam evento de conversa. Não há `/chat` ou `/approve` implementado. Novos eventos ACTION continuam `ACTION_UNAVAILABLE`; callbacks de administração são convertidos pelo bot nos textos fixos descritos no [assistente](assistente-conversacional.md#confirmações-digitadas-e-diretório-de-memória). Não presumir suporte a ações do intérprete retirado.

### Extensões implementadas do cliente

Estas respostas são validadas explicitamente no cliente atual; não foram acrescentadas retroativamente aos nove schemas JSON fixados do contrato base.

- **Memória:** `{contractVersion:"1.0",revision,recipients,enabled}`. `recipients` contém destinatários explicitamente salvos (`ref`, `kind:"RECIPIENT"`, `label`); o titular SELF não aparece nessa lista. Sem `linkId`, retorna `enabled:false`, revisão zero e lista vazia. `enabled:true` não atesta sessão operacional; a rota usa o vínculo conhecido, sem consultar catálogo. `revision` é inteiro não negativo. 404 numa API anterior habilita o fallback do bot para nomes do GROUP; lista vazia com extensão ativa não usa fallback. O caminho completo inclui o prefixo da conversa, não é `/memory` na raiz.
- **Progresso:** `{contractVersion:"1.0",enabled:true,operationId,eventId,text}`. `text` é `null` ou prévia de até 600 caracteres. É transitória: não fica em SQLite/logs e desaparece ao terminar/cancelar/reiniciar. O cliente verifica IDs e edita a mesma mensagem com o resultado final; 404 em API anterior desliga somente a extensão opcional. A prévia não comprova preço, carrinho ou pedido.
- **Endereços:** referências e expiração em [continuidade e endereços](continuidade-enderecos.md). Exigem vínculo operacional e não transportam `sessionRef` como autorização de seleção; têm validação própria de vínculo/lista/referência.
- **CART-01:** prefixo dedicado `/conversations/{conversationId}/cart-writes`; [revisão, confirmação e consultas](cart-01-escrita-confirmada.md#contrato-humano-e-fronteira-com-buy-01). Não usa `/purchase-approvals` nem os antigos endpoints F7.

## Evento, chave e origem

Exemplo sintético de alteração textual:

```json
{
  "contractVersion": "1.0",
  "eventId": "tg-update-500",
  "conversationId": "111111111",
  "expectedVersion": 0,
  "source": {
    "channel": "TELEGRAM",
    "botId": "900001",
    "conversationId": "111111111",
    "kind": "MESSAGE",
    "messageId": "30"
  },
  "input": { "kind": "TEXT", "text": "Agora temos R$150; manter a restrição da participante A." }
}
```

O adaptador deriva `eventId` do `update_id` e o conserva antes do primeiro envio. Retry após timeout/restart reutiliza **o mesmo corpo**, incluindo `expectedVersion` e origem; não gerar outro ID ou atualizar a versão daquele evento. Edição de mensagem entregue em outro update é outro evento. Mensagens com texto/valor igual e IDs diferentes são legítimas. A persistência da outbox do bot é BOT-01, não o mock Python deste incremento.

**Formato reservado do contrato base para botão:** `source.kind = CALLBACK`, `messageId` da mensagem do teclado, `callbackQueryId` autenticado e `input = { kind: ACTION, action: REQUEST_REVIEW | SELECT_PROPOSAL | EDIT_CONTEXT, actionRef }`. O schema descreve esse formato, mas a montagem atual recusa novos ACTION; não implementar a seleção atual com esse exemplo. Administração usa texto fixo e CART-01 tem rota de confirmação própria. Se um consumidor compatível usar ações em outro incremento, deve conservar referência↔mensagem autenticada; nenhuma ação geral aprova compra nem pode receber associação do modelo.

Cancelar e aprovar usam o mesmo envelope (`eventId`, `conversationId`, `expectedVersion`, `source`), porém com schemas e finalidades separados. Cancelar contém `operationId`; aprovar contém `reviewRef` e `approvalRef`. A chave de evento é compartilhada entre todas as rotas mutantes, não por endpoint: reutilizá-la para outra finalidade/conteúdo conflita.

### Ordem da aceitação e replay

1. Autenticar adaptador/organizador, validar schema, path e escopo de origem/recurso.
2. Buscar a chave única `(TELEGRAM, botId, organizerId, conversationId, eventId)`.
3. Se existe: comparar hash canônico do corpo completo. Mesmo conteúdo retorna operação existente; outro conteúdo retorna 409 `EVENT_CONFLICT`. Fazer isso **antes** de verificar a versão corrente ou consumo de referência, pois o primeiro processamento pode tê-los alterado.
4. Para evento novo: conferir `expectedVersion`, ações permitidas, pertencimento/validade/finalidade da referência e vínculo atual. Campo ausente não implica consentimento ou compatibilidade.
5. Persistir chave, hash, origem, tipo de evento e operação juntos. Somente então responder 202. Texto integral não é necessário no registro de proveniência; processamento pode precisar de payload temporário protegido conforme DA07.

`contentHash` ordena recursivamente chaves de objetos e preserva arrays e strings sem trim/normalização. Hash é calculado pela API após parse, não fornecido pelo bot/LLM. O consumidor reenvia os valores originais; não precisa reproduzir SHA-256 em Python. Rejeitar números fora do intervalo seguro de JSON/JavaScript. Não normalizar dois eventos diferentes em uma intenção por coincidência de total.

Se há crash antes da persistência, retry pode aceitar. Depois da persistência e antes da resposta, retry recupera. Locks em memória não bastam em produção: RUN-01/DATA-01 precisam de unicidade e transações. Retenção e tombstones dependem de DA07; nenhuma chave vinculada a efeito remoto pendente/desconhecido pode expirar e permitir nova execução.

## Versão, processamento e resultado parcial

`contractVersion: "1.0"` é independente da revisão inteira `version` da conversa. Toda mutação recebe `expectedVersion`; divergência → 409 `STALE_VERSION` sem aplicar patch. Na aceitação, guardar `baseVersion`. O worker repete o compare-and-swap no commit: resultado atrasado não pode sobrescrever revisão mais nova. O replay de evento já aceito continua recuperável mesmo com `expectedVersion` antigo.

Uma aplicação atômica de patch pode avançar a revisão; no-op não precisa avançá-la. `resultVersion` indica a revisão produzida, não a revisão atual de um GET posterior. Snapshot da operação é histórico e nunca deve substituir estado local mais novo no bot. A emissão atual deve remover referências vencidas/consumidas antes de publicar snapshot/ações; o conteúdo e a origem do resultado permanecem associados à revisão original. Consultar snapshot corrente para obter novos botões, sem replay de mutação.

| `status` | Significado | `pollAfterMs` |
| --- | --- | --- |
| `ACCEPTED` | recebido e persistido, aguardando worker | inteiro |
| `RUNNING` | processamento em curso | inteiro |
| `CANCEL_REQUESTED` | pedido de parada local persistido; execução pode estar em curso | inteiro |
| `SUCCEEDED` | resultado persistido; pode ser parcial | `null` |
| `FAILED` | falha conhecida, erro seguro obrigatório | `null` |
| `CANCELLED` | trabalho local interrompido antes de efeitos externos pendentes | `null` |
| `RESULT_UNKNOWN` | efeito remoto pode ter ocorrido; exige reconciliação | `null` |

`completeness` é `NONE`, `PARTIAL` ou `COMPLETE`. `SUCCEEDED` exige snapshot, versão resultante, ausência de erro e resultado parcial/completo. `PARTIAL` significa cobertura/busca limitada explicitada nas pendências; não significa grupo atendido ou autorização. Continuação exige novo evento explícito na versão corrente. Snapshot pode ser `null` enquanto não há resultado. Preços e estado do pedido vêm dos blocos estruturados validados, nunca do texto livre.

`createdAt` e `deadlineAt` são instantes UTC RFC 3339 com `Z`, preenchidos pela API; bot não escolhe prazo. `deadlineAt` é limite da operação, não da aprovação/cotação. Metas concretas, fila e orçamento de execução dependem de DEC-01/OPS-02; não há timeout de produto implicitamente aprovado aqui. A fixture de 60 segundos é sintética.

`pollAfterMs` entre 100 e 10000 é cadência de consulta, não meta de latência: respeitar a indicação, aumentar espera em falhas transitórias até 10 segundos e limitar espera interativa por `deadlineAt`. O limite de 10 segundos é protocolo de polling. Ao atingir o prazo local, o bot encerra espera ativa e permite consultar a mesma operação; não a declara fracassada nem a recria. A API decide falha conhecida ou resultado desconhecido conforme efeitos observados.

## Proveniência de alterações

`operation.changes[]` segue `change.schema.json`. Cada registro conserva `changeId`, `eventId`, `source` completo, `baseVersion`, `resultVersion`, campos afetados em `paths` e causa `USER`/`DERIVED`. DATA-01 associa o patch validado de domínio a `changeId`, na mesma transação da revisão, sem depender de histórico textual. Não aceitar JSON Patch arbitrário ou `source` inventada pelo modelo.

Alterar orçamento conserva a origem da restrição anterior. Correção posterior gera outro registro associado ao novo evento; não sobrescreve a cadeia histórica. Recalcular propostas por causa de mudança aponta para o evento causador com `DERIVED`; não fabrica mensagem humana. Replay não cria novo change/patch/versão. `eventId`, escopo da origem e versões do change devem corresponder à operação. DATA-01 deve ainda conferir bot/organizador e igualdade com a origem persistida na aceitação, não apenas conversa/versão.

Persistir após reinício é responsabilidade de DATA-01/RUN-01. O teste TypeScript recria o mock com o mesmo armazenamento em memória para conferir a semântica de replay, **sem alegar recuperação durável real**. Os testes Python validam os mesmos objetos de origem e referências, sem Telegram real.

## Apresentação, dinheiro e referências

Blocos: `TEXT`, `GROUP`, `PROPOSAL`, `REVIEW`, `OUTCOME`. `TEXT.source = MODEL` é explicação sem autoridade; só blocos estruturados montados/validados pela API informam preços, cobertura, validade e resultado. O renderer usa texto simples; se optar por HTML/Markdown no Telegram, precisa escapar todo conteúdo. Limite de 2000 caracteres Unicode (code points, incluindo emoji) por campo textual e 30 blocos por resposta; dividir blocos em mensagens e conservar ordem/associação dos teclados. Nunca truncar campos de revisão e aprovação para caber: renderizar em mensagens adicionais ou pedir snapshot atualizado.

Dinheiro é BRL em centavos inteiros seguros: `UNKNOWN` não contém valor, `ESTIMATE` contém `totalCents`, `RANGE` contém `minCents/maxCents` e `CONFIRMED` contém total, componentes e `expiresAt`. Desconto tem magnitude positiva subtraída da soma; não usar floats. Campo ausente, `null` e zero são distintos. Total confirmado deve ser igual à soma dos componentes e vir de carrinho validado, incluindo todos os custos suportados. Range invertido é inválido. Rateio, evidência alimentar e políticas de cobertura continuam DEC-01/DOM-01/GRP-01.

`allowedActions` contém somente ações permitidas, referências opacas, `expectedVersion` e expiração. Referências locais usam caracteres seguros e 16–64 caracteres no fio; produção deve gerá-las com entropia criptográfica e armazenar associação de finalidade, organizador, bot/conversa, vínculo, versão e conteúdo. Isso não define formato de IDs externos. O bot usa mapa local curto de callback (limite Telegram de 64 bytes), sem concatenar payload inteiro ou confiar em marcação produzida pelo modelo.

`OUTCOME` distingue `CART`, `ORDER` e `PAYMENT`. `CONFIRMED` exige referência a evidência confiável do provedor; `UNKNOWN` não vira sucesso. DA10 continua pendente em DEC-01: este enum não escolhe qual estágio fecha o evento.

## Revisão e aprovação humana

Conta conectada/confirmada é o contrato OAuth existente. Revisão é apresentação de carrinho, custos e bloqueios. Aprovação é callback humano específico em `/purchase-approvals`, com schema próprio, e só pode existir para revisão apta na fase `AWAITING_APPROVAL`, cobertura completa, total confirmado, sem bloqueios e dentro da validade. Aprovação não pode vencer depois da cotação.

`humanApproval` é reservado ao adaptador humano, nunca ao contexto do LLM. `toModelContext` continua como projeção do contrato base; não encaminhar snapshots/operações inteiras, referências de ação/aprovação, status de login, cabeçalhos, credenciais ou dados de pagamento ao modelo. O assistente atual usa seu protocolo próprio: roteador sem fatos, recuperação por pessoa/finalidade e contexto sanitizado de compras. `modelContext.schema.json` não é o prompt atual nem substitui o domínio. Ver [assistente](assistente-conversacional.md).

BUY-01 precisa conferir revisão, conta/link, fingerprint, total, versão, validade, callback e organizador atuais; reler o carrinho e consumir referência junto com intenção durável em transação. Dois cliques simultâneos não geram duas intenções. Texto “sim”, “pode pedir” ou booleano do modelo não autoriza. Mudança relevante exige nova revisão. Compra não é habilitada pela disponibilidade de schemas ou pela pré-validação `assertApproval`.

## Cancelamento, timeout e erros

Cancelar operação local não cancela pedido/pagamento no provedor. Se ainda enfileirada sem efeito, pode terminar `CANCELLED`; se em processamento, registrar `CANCEL_REQUESTED` até parada segura. Se já concluída, indicar que está terminal e conservar seu resultado. Se há efeito remoto desconhecido, rejeitar cancelamento que o mascararia com 409 `RESULT_UNKNOWN`, preservando reconciliação e bloqueio de novas escritas. Cancelar tentativa OAuth continua na rota de vínculo existente.

O resultado do comando usa `cancelResult.schema.json`: conserva o `eventId` do cancelamento e aponta para `targetOperationId`, sem substituir `operation.eventId` da operação original. `remoteCancellation` é sempre `NOT_REQUESTED`. O comando e sua origem são persistidos com sua própria chave de deduplicação; a API responde `ALREADY_TERMINAL` se a operação alvo já terminou, e o bot consulta a operação original para obter seu resultado. Não reatribuir patches anteriores à mensagem de cancelamento.

Timeout HTTP é ausência de resposta, não prova de falha. No POST de evento, consultar/reenviar **a mesma chave e corpo** para recuperar aceitação. No envio remoto, não repetir escrita por timeout, 401, erro inline ou payload inesperado: consultar/reconciliar conforme INT-01/BUY-02; sem contrato confiável, manter `RESULT_UNKNOWN`. Ajuda/status/consultas não esperam o modelo e não devem precisar de novo gasto.

Erros autenticados usam `error.schema.json`: código conhecido, mensagem fixa e orientação `FIX_REQUEST`, `READ_SNAPSHOT`, `POLL_OPERATION`, `RECONNECT`, `CONTACT_SUPPORT` ou `NONE`. Não há booleano `retryable` genérico que autorize replay de compra. `errors.ts` contém a tabela normativa de status 400/401/403/404/409/410/429/500/503. Não retornar exceção bruta, token, resposta privada ou catálogo dentro de `message`. Origem/IDs do canal não entram em logs. Retenção/expurgo seguem DA07, preservando reconciliação pendente.

## Compatibilidade

v1.0 fixa os schemas estritos e os enums. O consumidor não ignora campos/ações desconhecidos, nem promove estado desconhecido a sucesso: falha fechada e atualização de contrato. `contractVersion` não suportada gera 400 `UNSUPPORTED_VERSION`; nunca fazer downgrade silencioso. Alterações incompatíveis exigem novo major e novo prefixo; acréscimos de campos ou enum exigem schema/versionamento explícito e testes dos dois consumidores antes de publicação. A API deve conservar v1 enquanto o bot v1 estiver ativo, sem alterar significado de campos existentes. Nenhuma negociação automática com modelo.

## Reprodução e alcance da validação

Node >=22, dependências do `package-lock.json`:

```text
npm ci
npm run contract:generate
npm run typecheck
npm run lint
npm run test:contract
npm test
npm run build
```

Consumidor Python 3.12, no clone da API (Windows; em POSIX usar `.venv-contract/bin/python`):

```text
py -3.12 -m venv .venv-contract
.venv-contract/Scripts/python.exe -m pip install -r contracts/conversation/requirements-test.txt
.venv-contract/Scripts/python.exe -m unittest discover -s test/contracts -p "test_*.py" -v
```

Não versionar `.venv-contract`, caches ou relatórios temporários. O teste TypeScript compara schemas exportados com Zod para detectar drift; Python valida esses mesmos schemas e casos positivos/negativos. Mocks exercitam sucesso, replay, conflito de conteúdo/origem, versão antiga, identidade inválida, callbacks e timeout sem iniciar polling ou comprar. O mock TypeScript usa o middleware `botAuth` existente. Não é teste de rotas implantadas, persistência real, modelo ou provedor.

DEC-01 pode alterar políticas e metas; essas decisões devem gerar ajuste explícito e nova evidência no contrato quando afetarem o fio. Este incremento não aprova propostas de produto nem declara carrinho/envio entregues.
