# Contrato bot Telegram → api-backend (F3.5 — login iFood do organizador)

Status: **proposta implementada no api-backend** (2026-10-17), pendente de aceite do telegram-bot.
Baseado em `telegram-bot/docs/login-ifood.md` (commit 65a1d1d). Não há operação de compra; login não aprova pedido.

## 1. Autenticação bot → API

Toda chamada do bot leva:

| Cabeçalho | Valor | Observação |
|---|---|---|
| `Authorization` | `Bearer <BOT_API_TOKEN>` | segredo compartilhado (≥ 32 caracteres), só em variável de ambiente dos dois lados |
| `X-Telegram-User-Id` | ID numérico | `from.id` do update **já validado pelo adaptador** (conversa privada, organizador permitido) |

- O backend confere o ID contra `ALLOWED_ORGANIZER_IDS`. IDs em corpo, query ou texto do usuário/LLM são ignorados ou rejeitados (corpos são `strict`).
- Sem `BOT_API_TOKEN`/`ALLOWED_ORGANIZER_IDS` configurados ⇒ `503 BOT_API_NOT_CONFIGURED` (fail closed).
- Erros: `401 BOT_AUTH_REQUIRED`, `400 ORGANIZER_REQUIRED`, `403 ORGANIZER_NOT_ALLOWED`.
- O backend não registra IDs, query strings, tokens nem códigos em log.

## 2. Estados

`state` (+ `reason`) em todas as respostas de vínculo:

| state | significado | reason (exemplos) |
|---|---|---|
| `DISCONNECTED` | sem vínculo nem tentativa | `NEVER_CONNECTED`, `DISCONNECTED_BY_USER`, `ATTEMPT_EXPIRED`, `CONFIRMATION_EXPIRED`, `AUTHORIZATION_DENIED`, `TOO_MANY_CODE_FAILURES` |
| `AWAITING_AUTHORIZATION` | link gerado; login no navegador ainda não concluído | `RECONNECTING_FROM_<estado>` quando já havia vínculo |
| `AWAITING_CONFIRMATION` | iFood autorizou; falta o organizador confirmar no Telegram | |
| `CONNECTED` | vínculo confirmado | `null` (operacional), `VERIFICATION_PENDING`, `TOKEN_REFRESH_PENDING` |
| `RECONNECT_REQUIRED` | credencial comprovadamente inválida | `REFRESH_REJECTED`, `TOKEN_EXPIRED`, `TOKEN_REJECTED`, `ACCESS_FORBIDDEN`, `TOKENS_MISSING` |
| `UNAVAILABLE` | iFood/AS/rede indisponível — **não é logout**, tokens mantidos | `PROVIDER_ERROR`, `AUTH_PROVIDER_UNAVAILABLE`, `MCP_UNAVAILABLE`, `NETWORK_ERROR` |

**Liberar o fluxo de conta somente se `allowedOperations` não estiver vazio.** `CONNECTED` sozinho não basta:
`operational` só é `true` após uma leitura autenticada real (`listAddresses`) bem-sucedida e com token não vencido.

Corpo de status (sem tokens, sem códigos OAuth, sem dados da conta antes da confirmação):

```json
{
  "state": "CONNECTED", "reason": null,
  "linkId": "opaco", "connectedAt": "2026-10-17T23:30:00.000Z",
  "operational": true,
  "verification": { "status": "OK", "at": "…", "reason": null },
  "token": { "expiresAt": "…", "willRefresh": true },
  "account": { "addressCount": 1 },
  "attempt": null,
  "allowedOperations": ["ADDRESSES_READ", "OFFERS_EVALUATE"],
  "scopeEvidence": "TOKEN_SCOPES", "missingScopes": [],
  "purchaseAuthorized": false,
  "limitations": ["Login não aprova compra…", "O callback OAuth é http://localhost:8000…"],
  "nextActions": ["USE", "DISCONNECT"]
}
```

`linkId` muda a cada nova confirmação (troca de conta/reconexão). O bot deve invalidar sacola/aprovação associada a um
`linkId` diferente. `confirm` também devolve `previousLinkId`.

## 3. Endpoints do bot (exigem a autenticação da seção 1)

| Método e rota | Uso | Respostas |
|---|---|---|
| `GET /api/bot/ifood/status` | estado atual (sem chamada ao iFood) | 200 |
| `POST /api/bot/ifood/connect` | cria tentativa (substitui a anterior) | 201 + status + `authorizationUrl`, `attemptExpiresAt` |
| `POST /api/bot/ifood/confirm` | `{ "attemptId", "verificationCode" }` | 200 status + `previousLinkId`; 400 código errado; 404 tentativa inexistente/de outro organizador; 409 login ainda não concluído; 410 expirada/usada; 423 bloqueada (5 erros) |
| `POST /api/bot/ifood/verify` | leitura autenticada real; renova token se preciso | 200 status; 409 sem vínculo |
| `DELETE /api/bot/ifood/link` | desconecta: remove vínculo e tokens locais | 200 status + `providerRevocation: "NOT_ATTEMPTED"` |

Operações de conta (mesma autenticação; exigem vínculo confirmado e operacional):

| Rota | Operação | Sem vínculo/indisponível |
|---|---|---|
| `GET /api/addresses` | `ADDRESSES_READ` | `409 IFOOD_LINK_REQUIRED` / `409 IFOOD_RECONNECT_REQUIRED` / `503 IFOOD_UNAVAILABLE` / `403 IFOOD_SCOPE_MISSING` |
| `POST /api/evaluate` | `OFFERS_EVALUATE` (contrato do corpo em `src/server/routes/evaluate.ts`) | idem |

Se o token vencer, a operação renova sozinha; renovação recusada ⇒ `RECONNECT_REQUIRED`; falha de rede ⇒ `UNAVAILABLE`.
Antes da primeira operação após reinício do backend, uma verificação é feita automaticamente.

## 4. Fluxo

```
Bot                         API                                   Navegador (mesma máquina do backend)   iFood
 | POST connect  ─────────▶ cria tentativa (state, PKCE, 10 min)
 | ◀── authorizationUrl = http://localhost:8000/auth/ifood/start?a=…&t=…
 | mostra botão "Conectar iFood" ───────────────────────────────▶ abre o link
 |                          GET /auth/ifood/start ◀──────────────
 |                          PAR (state, S256) ───────────────────────────────────────────────────────────▶
 |                          302 ───────────────────────────────▶ login no iFood ────────────────────────▶
 |                          GET /?state&code ◀──────────────────────────────────────────── redirect registrado
 |                          valida state/validade/uso único, troca o code (tokens só no backend)
 |                          página: "envie o código ABC-123 no Telegram" ─▶ (URL limpa, no-store)
 | organizador digita o código
 | POST confirm {attemptId, verificationCode} ─▶ cria vínculo, verifica com listAddresses
 | ◀── CONNECTED + allowedOperations
```

- Tentativa: expira em 10 min (autorização) e mais 10 min (confirmação); uso único; presa ao organizador que a criou;
  nova `connect` invalida a anterior; 5 códigos errados bloqueiam.
- O código de verificação **não é credencial do iFood**. Só é aceito na API autenticada do bot e para o organizador dono da
  tentativa; serve para provar que quem concluiu o login no navegador é quem está no Telegram (protege contra link encaminhado).
- "Já entrei" ou clique sem código **não** confirma nada: `confirm` antes do callback devolve 409.

## 5. Callback localhost

O redirect registrado no client OAuth é **`http://localhost:8000`** (exato). O link do bot e o callback só funcionam num
navegador **na mesma máquina do backend**. Abrir no Telegram do celular não funciona. Para a demo: Telegram Desktop e navegador
no computador do backend. Acesso pelo celular exige outro redirect cadastrado no iFood e `PUBLIC_BASE_URL` alcançável.
Nunca pedir senha, código OAuth, token ou URL de retorno no chat.

## 6. Recorte da demo (não é isolamento multiusuário completo)

- Um organizador em `ALLOWED_ORGANIZER_IDS` e uma conta iFood dedicada de teste.
- O backend já mantém por vínculo: arquivo de tokens, `IfoodAuth`, sessão MCP e cache próprios; testes cobrem dois organizadores.
- Não há: banco de dados, criptografia dos tokens em repouso (arquivos modo 600 em `IFOOD_LINKS_DIR`, fora do Git),
  rate limiting, revogação no provedor, auditoria, nem multi-processo (estado de tentativas em memória).
- A sessão global antiga (`.tokens.json`, `/api/auth/*`) fica desligada (`DEV_GLOBAL_SESSION=false`) e nunca é importada como vínculo.

## 7. Configuração

```bash
BOT_API_TOKEN=<segredo ≥ 32 chars, o mesmo no bot>
ALLOWED_ORGANIZER_IDS=<ID numérico do organizador>
PUBLIC_BASE_URL=http://localhost:8000
IFOOD_LINKS_DIR=.ifood-links
```

## 8. Decisões abertas para o telegram-bot

1. **Código de verificação digitado no Telegram** (proposto e implementado). Alternativa sem digitação: comparar códigos
   exibidos nos dois lados (mais fraca). Precisa de aceite.
2. Nomes de variáveis no bot (`BACKEND_URL`, `BOT_API_TOKEN`) e reutilização de `TELEGRAM_ALLOWED_USER_ID` como `X-Telegram-User-Id`.
3. Valores em centavos: `/api/evaluate` ainda devolve BRL decimal (regra do CLAUDE.md); o AGENTS.md do bot pede centavos inteiros.
