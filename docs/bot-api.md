# Contrato bot Telegram → api-backend (F3.5 — login iFood do organizador)

Status: **implementado no api-backend** (2026-10-17). Decisões aceitas: confirmação por **botão** (sem código digitado),
`BOT_API_TOKEN` + `X-Telegram-User-Id`, dinheiro em **centavos inteiros** no contrato do bot, demo com um organizador.
Base: `telegram-bot/docs/login-ifood.md`. Login **não** aprova compra; não há operação de compra no backend.

## 1. Autenticação bot → API

Toda chamada do bot leva:

| Cabeçalho | Valor |
|---|---|
| `Authorization` | `Bearer <BOT_API_TOKEN>` (≥ 32 caracteres; mesmo valor nos dois lados, só em variável de ambiente) |
| `X-Telegram-User-Id` | `from.id` do update/callback_query **já validado pelo adaptador** (conversa privada, organizador permitido) |
| `Content-Type` | `application/json` nas rotas com corpo |

- O backend confere o ID contra `ALLOWED_ORGANIZER_IDS`. Identidade no corpo/query/texto do usuário ou do LLM é ignorada
  ou rejeitada (corpos são `strict`).
- Erros: `401 BOT_AUTH_REQUIRED`, `400 ORGANIZER_REQUIRED`, `403 ORGANIZER_NOT_ALLOWED`, `503 BOT_API_NOT_CONFIGURED` (fail closed).
- Formato de erro: `{ "error": { "kind": "<CÓDIGO>", "message": "...", "state": <estado|null>, "reason": <motivo|null> } }`.

## 2. Estados

| state | significado | reason (exemplos) | bot mostra |
|---|---|---|---|
| `DISCONNECTED` | sem vínculo nem tentativa | `NEVER_CONNECTED`, `DISCONNECTED_BY_USER`, `ATTEMPT_EXPIRED`, `CONFIRMATION_EXPIRED`, `AUTHORIZATION_DENIED`, `CODE_EXCHANGE_FAILED`, `PROVIDER_UNAVAILABLE`, `ATTEMPT_SUPERSEDED` | botão **Conectar iFood** |
| `AWAITING_AUTHORIZATION` | link gerado; login no navegador não concluído | `RECONNECTING_FROM_<estado>` se já havia vínculo | botão-URL do link + **Verificar** |
| `AWAITING_CONFIRMATION` | iFood autorizou; falta o organizador confirmar | | identidade mascarada + **Confirmar conexão** / **Cancelar** |
| `CONNECTED` | vínculo confirmado | `null` (operacional), `VERIFICATION_PENDING`, `TOKEN_REFRESH_PENDING` | liberar fluxo **só se** `allowedOperations` não vazio |
| `RECONNECT_REQUIRED` | credencial comprovadamente inválida | `REFRESH_REJECTED`, `TOKEN_EXPIRED`, `TOKEN_REJECTED`, `ACCESS_FORBIDDEN`, `TOKENS_MISSING` | **Conectar iFood** de novo |
| `UNAVAILABLE` | iFood/AS/rede fora — **não é logout**; tokens mantidos | `PROVIDER_ERROR`, `AUTH_PROVIDER_UNAVAILABLE`, `MCP_UNAVAILABLE`, `NETWORK_ERROR` | "iFood indisponível" + **Verificar** |

Corpo de status (todas as rotas de vínculo devolvem este objeto; nunca há token, código OAuth, telefone, e-mail ou nome completo):

```json
{
  "state": "AWAITING_CONFIRMATION",
  "reason": null,
  "linkId": null,
  "connectedAt": null,
  "operational": false,
  "verification": { "status": "PENDING", "at": null, "reason": null },
  "token": null,
  "account": null,
  "attempt": {
    "attemptId": "opaco-24",
    "status": "PENDING_CONFIRMATION",
    "expiresAt": "2026-10-17T23:58:00.000Z",
    "confirmationId": "opaco-24",
    "accountIdentity": { "status": "VERIFIED", "displayName": "Maria S.", "emailMasked": "m***@example.com", "source": "getUser" },
    "browserClaimed": true
  },
  "allowedOperations": [],
  "scopeEvidence": null,
  "missingScopes": [],
  "purchaseAuthorized": false,
  "limitations": ["Login não aprova compra…", "O callback OAuth é http://localhost:8000…"],
  "nextActions": ["CONFIRM_CONNECTION", "CANCEL"]
}
```

- `accountIdentity.status`: `VERIFIED` (nome/e-mail mascarados do `getUser`), `NOT_PROVIDED` (iFood respondeu sem esses
  campos) ou `UNAVAILABLE` (consulta falhou). Nos dois últimos, o bot deve dizer que a identidade não pôde ser verificada.
- Em `CONNECTED`: `account = { "identity": {…mascarada…}, "addressCount": <n|null> }`, `linkId` opaco, `attempt: null`.
- `linkId` muda a cada nova confirmação (reconexão/troca de conta). O bot deve invalidar sacola/aprovação associada a outro
  `linkId`. `confirm` também devolve `previousLinkId`.

## 3. Endpoints do bot

| Método e rota | Corpo | Sucesso | Erros |
|---|---|---|---|
| `GET /api/bot/ifood/status` | — | 200 status (sem chamada ao iFood) | — |
| `POST /api/bot/ifood/connect` | — | 201 status + `authorizationUrl`, `attemptExpiresAt` | 503 `IFOOD_CLIENT_NOT_CONFIGURED` |
| `POST /api/bot/ifood/confirm` | `{ "confirmationId": "<de attempt.confirmationId>" }` | 200 status + `previousLinkId` | 400 `VALIDATION`; 404 `CONFIRMATION_NOT_FOUND` (inexistente **ou de outro organizador**); 410 `CONFIRMATION_EXPIRED`, `ALREADY_CONFIRMED` (traz `state`), `CONFIRMATION_INVALID` (tentativa substituída/cancelada) |
| `POST /api/bot/ifood/verify` | — | 200 status (leitura autenticada real; renova token se preciso) | 409 `IFOOD_LINK_REQUIRED` |
| `POST /api/bot/ifood/cancel` | — | 200 status + `cancelled: true\|false` — cancela **só** a tentativa pendente (link/confirmação); vínculo confirmado continua; idempotente | — |
| `DELETE /api/bot/ifood/link` | — | 200 status + `removed: true\|false`, `providerRevocation: "NOT_ATTEMPTED"` — remove **só** o vínculo confirmado (tokens, sessão, cache); tentativa pendente continua; idempotente | — |

`connect`, `confirm`, `cancel` e `DELETE /link` do mesmo organizador são **serializados** no backend: uma confirmação em
andamento termina antes de um cancelamento/desconexão começar, e uma confirmação de tentativa já cancelada ou substituída
devolve 410 `CONFIRMATION_INVALID` sem instalar vínculo.

Operações de conta (mesma autenticação; exigem vínculo confirmado **e** operacional):

| Rota | Operação | Erros de vínculo |
|---|---|---|
| `GET /api/addresses` | `ADDRESSES_READ` | 409 `IFOOD_LINK_REQUIRED` · 409 `IFOOD_RECONNECT_REQUIRED` · 503 `IFOOD_UNAVAILABLE` · 403 `IFOOD_SCOPE_MISSING` |
| `POST /api/evaluate` | `OFFERS_EVALUATE` | idem; corpo/resposta em centavos (seção 6) |

## 4. Fluxo que o bot deve implementar

```
1. /start ou "Conectar":   POST /connect  → 201 { authorizationUrl, attempt.expiresAt }
   Mensagem com botão-URL "Abrir login do iFood" (authorizationUrl) + aviso:
   "Abra no navegador DESTE computador (o mesmo do backend). O link vale 10 min."
2. Usuário faz login no navegador. A página final diz "volte ao Telegram e toque em Confirmar conexão".
3. Bot consulta GET /status (botão "Verificar" ou polling curto, ex.: a cada 5 s por até 10 min):
   - AWAITING_AUTHORIZATION → continuar aguardando ("ainda não concluído" — um "já entrei" não comprova nada)
   - AWAITING_CONFIRMATION  → enviar mensagem:
       "Conectar esta conta iFood? Maria S. · m***@example.com
        Se não reconhece esta conta, toque em Cancelar."
       Inline keyboard: [Confirmar conexão] callback_data = "ifc:" + attempt.confirmationId   (≤ 64 bytes)
                        [Cancelar]          callback_data = "ifx"
     (se accountIdentity.status ≠ VERIFIED: "Não foi possível verificar a identidade da conta.")
4. callback_query "ifc:<id>": o adaptador valida from.id == organizador (como em qualquer update) e chama
   POST /confirm { confirmationId: <id> } com X-Telegram-User-Id = from.id.
   - 200 CONNECTED e allowedOperations ≠ [] → "Conta conectada". Login não aprova compras.
   - 200 com state UNAVAILABLE → "iFood indisponível, tente Verificar depois" (vínculo existe, operações bloqueadas).
   - 410 ALREADY_CONFIRMED (clique duplicado) → apenas mostrar o status atual; NÃO tratar como nova conexão.
   - 410 CONFIRMATION_EXPIRED / CONFIRMATION_INVALID, 404 → "Confirmação inválida/expirada; gere um novo link".
   Responder answerCallbackQuery sempre; remover o teclado da mensagem após uso.
5. "ifx" (Cancelar) → POST /cancel. Cancela só a tentativa; um vínculo já confirmado (reconexão) continua ativo.
   "Desconectar" (comando/botão separado) → DELETE /link. Para sair de tudo: POST /cancel e DELETE /link.
6. Antes de qualquer operação de conta: status.allowedOperations deve conter a operação; se a rota devolver
   409/503, mostrar a ação correspondente (Conectar / Verificar).
```

Regras para o bot:
- Nunca pedir senha, código OAuth, token, URL de retorno ou qualquer código no chat.
- Nunca construir `confirmationId`/`attemptId`; usar apenas os valores do status mais recente.
- Não confirmar automaticamente: a confirmação é sempre um clique humano do organizador.
- Não guardar tokens (o bot nunca os recebe). `linkId` pode ser guardado para invalidar sacolas.

## 5. Proteção contra link encaminhado e garantias da tentativa

| Camada | Comportamento |
|---|---|
| Mesma máquina | Com `PUBLIC_BASE_URL` local (padrão), `/auth/ifood/start` e o callback (`/`) só aceitam conexões de loopback (127.0.0.1/::1). Outro computador recebe 403. |
| Mesmo navegador | O primeiro navegador que abre o link recebe cookie HttpOnly/SameSite=Lax e "reivindica" a tentativa. Outro navegador recebe 409; o callback em navegador sem o cookie é rejeitado (409) **sem consumir** a tentativa. |
| Confirmação consciente | Após o callback o vínculo fica `AWAITING_CONFIRMATION`; o bot mostra a identidade mascarada da conta e só o organizador que criou a tentativa consegue confirmar (outro ⇒ 404). |
| Tentativa | `state` e PKCE S256 aleatórios; validade de 10 min para o login e mais 10 min para confirmar; `state` de uso único (callbacks concorrentes: só um troca o código); nova `connect` invalida a anterior; `confirmationId` só existe após callback válido e só vale uma vez. |
| Sessão | Após confirmar, uma leitura autenticada real (`listAddresses`) define `operational`. Tokens, sessão MCP e cache são próprios de cada vínculo. |

Identidade da conta: `getUser` com `includeProfileData=false` (contrato observado 2026-10-17: `{ success, data: { fullName, email, phone } }`,
`readOnlyHint=true`, escopo `mcp.user.basic.read`). Só saem do backend nome mascarado ("Maria S.") e e-mail mascarado
("m***@example.com"); telefone nunca. Falha do `getUser` não bloqueia, mas é explicitada.

## 6. Alergias (política do backend)

- Alergia (`kind: "ALLERGY"`) é sempre obrigatória e **nunca resulta PASS**: o iFood não fornece ingredientes/alérgenos
  e a classificação do catálogo (ex.: `GLUTEN_FREE`) não informa contaminação cruzada nem cobre opções.
- `ALLERGY:GLUTEN` envia `GLUTEN_FREE` ao iFood **só para estreitar a busca**; cada item volta com
  `status: "UNKNOWN"`, `source: "SERVER_FILTER_INSUFFICIENT"`, `eligible: false`, bloqueio `ALLERGY_UNVERIFIED`.
- Termo do alérgeno no nome do item ⇒ `FAIL` (heurística). Em todos os casos, o bot deve explicar que é preciso
  confirmação da loja. Restrições alimentares (`kind: "DIETARY"`, ex.: `GLUTEN_FREE` como dieta) continuam aceitando o filtro.

## 7. Dinheiro em centavos (`/api/evaluate` no contrato do bot)

- Entrada: `budget.maxItemPriceCents`, `budget.maxOrderTotalCents`, `refinements.maxDeliveryFeeCents` — inteiros.
  Campos decimais antigos (`maxItemPrice` etc.) são rejeitados com 400.
- Saída: `money: { "currency": "BRL", "unit": "CENTS" }` e **todo** campo monetário termina em `Cents` (inteiro) ou é uma
  faixa `{ minCents, maxCents }`: `listingPrice.unitPriceCents`, `pricing.minimumConfigurable.unitTotalCents`,
  `unitTotalRange`, `estimatedTotalCents`, `estimatedTotalRange`, `delivery.feeCents`, `minimumOrder.amountCents`,
  `options.mandatory[].totalCents`, `confirmedTotalCents` (sempre `null`), etc.
- Quando o preço é ambíguo (`status: "UNCERTAIN"`), `unitTotalCents`/`estimatedTotalCents` vêm `null` e só as faixas valem.
- Mensagens (`blockers[].message`, `notes`) continuam em texto "R$ x.yz" para leitura humana.
- Internamente o domínio usa BRL decimal; a conversão é feita só na borda (`src/server/services/cents.ts`).

## 8. Callback localhost

Redirect registrado: **`http://localhost:8000`** (exato). Para a demo: Telegram Desktop e navegador **no computador do backend**.
Abrir pelo celular não funciona (e é bloqueado). Para uso pelo celular seria preciso outro redirect cadastrado no iFood e
`PUBLIC_BASE_URL` público — e então a proteção "mesma máquina" deixa de existir (restam navegador vinculado + confirmação).

## 9. Recorte da demo (não é isolamento multiusuário completo)

- Um organizador em `ALLOWED_ORGANIZER_IDS`, uma conta iFood dedicada de teste.
- Sem banco de dados, sem criptografia dos tokens em repouso (arquivos modo 600 em `IFOOD_LINKS_DIR`, fora do Git), sem rate
  limiting, sem auditoria, sem revogação no provedor, um único processo (tentativas pendentes ficam em memória).
- Sessão global antiga (`/api/auth/*`) desligada por padrão e nunca importada como vínculo.

## 10. Configuração

```bash
# api-backend (.env)
BOT_API_TOKEN=<segredo ≥ 32 chars>       # node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
ALLOWED_ORGANIZER_IDS=<ID numérico do organizador>
PUBLIC_BASE_URL=http://localhost:8000
IFOOD_LINKS_DIR=.ifood-links

# telegram-bot (sugestão de nomes; decisão do bot)
BACKEND_URL=http://localhost:8000
BOT_API_TOKEN=<o mesmo segredo>
TELEGRAM_ALLOWED_USER_ID=<mesmo ID de ALLOWED_ORGANIZER_IDS>   # enviado como X-Telegram-User-Id
```
