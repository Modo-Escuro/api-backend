**Contrato atualizado em 18/10/2026:** o retorno OAuth no navegador conclui o vínculo sem segundo clique Telegram. Ver [retorno natural](login-retorno-natural.md). A confirmação manual permanece para compatibilidade e recuperação; login não autoriza compra.

# Contrato bot Telegram → api-backend (F3.5 — login iFood do organizador)

**Atualização de contexto — 18/10/2026:** este arquivo descreve o contrato existente. [Plano de execução](plano-conversacional.md) e [contrato proposto de conversa](https://github.com/Modo-Escuro/telegram-bot/blob/codex/plano-conversacional/docs/contrato-conversa-proposto.md) especificam o trabalho futuro. Login online foi ensaiado com PUBLIC_BASE_URL HTTPS e callback /callback; referências localhost nos exemplos são de desenvolvimento, não obrigação para o usuário do serviço online. Bot usa BACKEND_BASE_URL e BACKEND_API_TOKEN; API usa BOT_API_TOKEN. Não há aprovação de compra neste contrato.

Status: **implementado no api-backend**, com conclusão do vínculo no navegador (2026-10-18). Confirmação manual compatível por **botão** (sem código digitado),
`BOT_API_TOKEN` + `X-Telegram-User-Id`, dinheiro em **centavos inteiros** no contrato do bot, demo com um organizador.
Base do consumidor: `telegram-bot/docs/login-ifood.md`. Login não aprova compra e não há envio de pedidos. F7 retirada; CART-01 com opt-in próprio. Reconciliação local de 20/10: assistente único, sessão/memória/progresso e banco v6; não é conferência online.

Contrato de conversa versionado: [API-01 v1.0](conversation-api-v1.md), com schemas base e extensões de conta/memória/progresso. RUN-01 integra DATA-01 e o assistente pela montagem AI-01; aceitar turnos novos exige runtime/modelo explicitamente configurados. O bot conserva `X-Conversation-Session` para os eventos associados ao vínculo. As rotas de login deste documento permanecem independentes.

## 1. Autenticação bot → API

Toda chamada do bot leva:

| Cabeçalho | Valor |
|---|---|
| `Authorization` | `Bearer <BOT_API_TOKEN>` (≥ 32 caracteres; mesmo valor nos dois lados, só em variável de ambiente) |
| `X-Telegram-User-Id` | `from.id` do update/callback_query **já validado pelo adaptador** (conversa privada, organizador permitido) |
| `Content-Type` | `application/json` nas rotas com corpo |

- O backend confere o ID contra `ALLOWED_ORGANIZER_IDS`. Com `BOT_PASSWORD_ACCESS_ENABLED=true`, o adaptador autenticado também pode admitir IDs válidos enviando `X-Telegram-Access: PASSWORD`, após validar a senha no bot; ver [acesso por senha](acesso-bot-senha.md). Identidade no corpo/query/texto do usuário ou do LLM é ignorada
  ou rejeitada (corpos são `strict`).
- Erros: `401 BOT_AUTH_REQUIRED`, `400 ORGANIZER_REQUIRED`, `403 ORGANIZER_NOT_ALLOWED`, `503 BOT_API_NOT_CONFIGURED` (fail closed).
- Qualquer rota de vínculo: `503 LINK_STORAGE_UNAVAILABLE` quando o armazenamento de vínculos não pode ser lido (arquivo
  corrompido/ilegível); nada é alterado e a chamada seguinte tenta de novo. Ver [ops-01-persistencia](ops-01-persistencia.md).
- Formato de erro: `{ "error": { "kind": "<CÓDIGO>", "message": "...", "state": <estado|null>, "reason": <motivo|null> } }`.

## 2. Estados

| state | significado | reason (exemplos) | bot mostra |
|---|---|---|---|
| `DISCONNECTED` | sem vínculo nem tentativa | `NEVER_CONNECTED`, `DISCONNECTED_BY_USER`, `ATTEMPT_EXPIRED`, `CONFIRMATION_EXPIRED`, `AUTHORIZATION_DENIED`, `CODE_EXCHANGE_FAILED`, `PROVIDER_UNAVAILABLE`, `ATTEMPT_SUPERSEDED` | botão **Conectar iFood** |
| `AWAITING_AUTHORIZATION` | link gerado; login no navegador não concluído | `RECONNECTING_FROM_<estado>` se já havia vínculo | botão-URL do link + **Verificar** |
| `AWAITING_CONFIRMATION` | autorização recebida; instalação ainda pendente, compatibilidade ou recuperação | | identidade mascarada + **Confirmar conexão** / **Cancelar** quando a confirmação manual for necessária |
| `CONNECTED` | vínculo confirmado | `null` (operacional), `VERIFICATION_PENDING`, `TOKEN_REFRESH_PENDING` | liberar fluxo **só se** `allowedOperations` não vazio |
| `RECONNECT_REQUIRED` | credencial comprovadamente inválida | `REFRESH_REJECTED`, `TOKEN_EXPIRED`, `TOKEN_REJECTED`, `ACCESS_FORBIDDEN`, `TOKENS_MISSING` | **Conectar iFood** de novo |
| `UNAVAILABLE` | iFood/AS/rede fora — **não é logout**; tokens mantidos | `PROVIDER_ERROR`, `AUTH_PROVIDER_UNAVAILABLE`, `MCP_UNAVAILABLE`, `NETWORK_ERROR` | "iFood indisponível" + **Verificar** |

Exemplo de status de confirmação manual pendente (compatibilidade/recuperação). No fluxo normal, o callback instala o vínculo e o bot consulta o estado resultante; não precisa observar `AWAITING_CONFIRMATION`. As respostas nunca contêm token, código OAuth, telefone, e-mail ou nome completo:

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
  "limitations": ["Login não aprova compra…"],
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
| `POST /api/bot/ifood/connect` | — | 201 status + `authorizationUrl`, `attemptExpiresAt` | 503 `IFOOD_CLIENT_NOT_CONFIGURED`; 503 `LINK_STORAGE_NOT_DURABLE` (backend sem disco persistente) |
| `POST /api/bot/ifood/confirm` | `{ "confirmationId": "<de attempt.confirmationId>" }` | 200 status + `previousLinkId` | 400 `VALIDATION`; 404 `CONFIRMATION_NOT_FOUND` (inexistente **ou de outro organizador**); 410 `CONFIRMATION_EXPIRED`, `ALREADY_CONFIRMED` (traz `state`), `CONFIRMATION_INVALID` (tentativa substituída/cancelada); 503 `LINK_STORAGE_FAILED` (gravação falhou; mesmo `confirmationId` continua válido), `LINK_STORAGE_NOT_DURABLE` |
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
| `POST /api/evaluate` | `OFFERS_EVALUATE` | idem; corpo/resposta em centavos (seção 7); buckets e ranking (seção 8) |

## 4. Fluxo que o bot deve implementar

```
1. /start ou "Conectar":   POST /connect  → 201 { authorizationUrl, attempt.expiresAt }
   Mensagem com botão-URL "Abrir login do iFood" (authorizationUrl) + aviso:
   "Abra o link no navegador e volte ao Telegram. O link vale 10 min. Em desenvolvimento localhost, use o computador do backend."
2. Usuário faz login no navegador. O callback valida a tentativa e instala o vínculo. A página diz "Conta conectada" e orienta voltar ao Telegram, sem confirmar novamente. Se a verificação operacional falhar, orienta usar Verificar conexão.
3. Bot consulta GET /status (botão "Verificar" ou polling curto, ex.: a cada 5 s por até 10 min):
   - AWAITING_AUTHORIZATION → continuar aguardando ("ainda não concluído" — um "já entrei" não comprova nada)
   - CONNECTED e allowedOperations ≠ [] → retomar o fluxo; login não aprova compras.
   - UNAVAILABLE ou vínculo não operacional → oferecer Verificar; não iniciar operações de conta.
   - AWAITING_CONFIRMATION (compatibilidade/recuperação) → enviar mensagem:
       "Conectar esta conta iFood? Maria S. · m***@example.com
        Se não reconhece esta conta, toque em Cancelar."
       Inline keyboard: [Confirmar conexão] callback_data = "ifc:" + attempt.confirmationId   (≤ 64 bytes)
                        [Cancelar]          callback_data = "ifx"
     (se accountIdentity.status ≠ VERIFIED: "Não foi possível verificar a identidade da conta.")
4. Se houver confirmação manual pendente, callback_query "ifc:<id>": o adaptador valida from.id == organizador (como em qualquer update) e chama
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
- O callback OAuth conclui automaticamente o vínculo após a autorização humana no navegador. O bot não chama `/confirm` por polling; quando houver confirmação manual pendente, chama essa rota somente após o clique do organizador.
- Não guardar tokens (o bot nunca os recebe). `linkId` pode ser guardado para invalidar sacolas.

## 5. Proteção contra link encaminhado e garantias da tentativa

| Camada | Comportamento |
|---|---|
| Mesma máquina | Com `PUBLIC_BASE_URL` local (padrão), `/auth/ifood/start` e o callback (`/`) só aceitam conexões de loopback (127.0.0.1/::1). Outro computador recebe 403. |
| Mesmo navegador | O primeiro navegador que abre o link recebe cookie HttpOnly/SameSite=Lax e "reivindica" a tentativa. Outro navegador recebe 409; o callback em navegador sem o cookie é rejeitado (409) **sem consumir** a tentativa. |
| Autorização no navegador | O callback conclui o vínculo com a conta autorizada no navegador para o organizador derivado da tentativa no servidor. Não há segunda conferência de identidade no Telegram no fluxo normal. O link inicial é uma capacidade privada: quem o abrir primeiro reivindica a tentativa. Não compartilhar; cookie/PKCE não provam que os dispositivos pertencem à mesma pessoa. |
| Tentativa | `state` e PKCE S256 aleatórios; validade de 10 min para o login e mais 10 min para confirmar; `state` de uso único (callbacks concorrentes: só um troca o código); nova `connect` invalida a anterior; `confirmationId` só existe após callback válido e só vale uma vez. |
| Sessão | A instalação pelo callback ou confirmação manual executa uma leitura autenticada real (`listAddresses`) para definir `operational`. Falha remota pode deixar o vínculo salvo sem operações liberadas. Tokens, sessão MCP e cache são próprios de cada vínculo. |

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
- O domínio também usa centavos inteiros; BRL do MCP é convertido na normalização. `src/server/services/cents.ts` só projeta os nomes do contrato, sem multiplicar novamente. Ver DOM-01 na seção 13.

## 8. Recomendações ranqueadas (`/api/evaluate` — contrato 2.0, RANK-03)

Detalhe da implementação: [ranking](ranking.md). Migração, políticas e consumidores:
[rank-03-contrato-v2](rank-03-contrato-v2.md). Schema Zod: `src/server/contracts/evaluate.ts`.
Respostas de avaliação bem-sucedidas trazem `contractVersion: "2.0"` no topo e em `ranking`.
Esta versão é independente do contrato conversacional 1.0; os erros e a autenticação existentes não mudam.

- **Requisição**: além de `query`/`location`/`restrictions`/`budget`/`refinements`, existe
  `preferences: { foodTypes?, likedIngredients?, avoidedIngredients?, occasion?, priority? }` opcional, com
  `priority` em `ECONOMY | SPEED | PREFERENCES`. Preferência **nunca** vira filtro obrigatório no iFood e nunca
   muda a elegibilidade. DEC-01 D9 exige `ECONOMY` ou `SPEED` para ordenar; ausência ou `PREFERENCES`
   legado retorna HTTP 200 com `ranking.status: "PRIORITY_REQUIRED"`, `clarification` e `recommendations: []`.
   O cliente pergunta qual das duas prioridades e envia nova avaliação; os buckets de diagnóstico continuam presentes.
- **Três buckets mutuamente exclusivos** (a restrição obrigatória decide *antes* de qualquer pontuação):
   - `recommendations` — só candidatos **ELIGIBLE**, no máx. 4, em ordem estrita D9;
   - `eligible` — todos os elegíveis na ordem de coleta; consultar `recommendations` para a ordem ranqueada;
  - `blocked` — incompatibilidade identificada (`RESTRICTION_FAIL`, `OVER_ITEM_BUDGET`, `MERCHANT_CLOSED`,
     `NO_VALID_CONFIGURATION`…). O bot mostra o motivo e **não** oferece o item;
  - `needsVerification` — falta de informação (`NOT_DETAILED`, `ALLERGY_UNVERIFIED`, `PRICE_UNAVAILABLE`…).
    Não é "seguro": o bot pede confirmação/explique a lacuna, **nunca** recomenda.
   - `summary = { candidates, eligible, blocked, needsVerification, recommendations, blockerCounts }`, com
     `eligible + blocked + needsVerification === candidates` e `recommendations ≤ 4`.
- Cada candidato tem `category: ELIGIBLE | BLOCKED | NEEDS_VERIFICATION`. Todos os motivos originais
  permanecem em `blockers`, inclusive em casos mistos. Incompatibilidade confirmada ou código desconhecido
  prevalece sobre pendência conhecida; desconhecido usa `BLOCKED` como fallback conservador, não comprovação.
  `PRICE_UNVERIFIED`, `CONFIG_UNVERIFIED`, `AVAILABILITY_UNKNOWN` e limites DOM-01 não verificáveis são pendências.
- **Ordem D9**: ECONOMY compara total completo estimado, prazo e preferências atendidas; SPEED compara
  prazo, total e preferências atendidas. Custo crescente, prazo crescente, preferências decrescentes; desconhecidos
  depois dos conhecidos em cada chave; empate por `merchantId`, depois `itemId`. Score não decide a ordem.
- **`ranking` em cada recomendação**: `rank` (1-based), `score` (0–1 ou `null`), `criteria[]`
  (`PREFERENCES 35% · CONTEXT 25% · PRICE 20% · DELIVERY 10% · RATING 10%`; com `priority` o critério escolhido
  dobra e os pesos entram no `ranking.weights` do topo), `reasons[]` (por que pontuou assim) e
  `dataLimitations[]` (o que faltou). Critério sem dado vem `status: "NO_DATA"`, `score: null`,
  `effectiveWeight: 0`, `contribution: null` — o peso é redistribuído entre os avaliados e **nenhuma nota é
   inventada**; `score: null` só quando nenhum critério pôde ser avaliado. O score é **diagnóstico relativo à
   consulta**, não percentual de satisfação, probabilidade de segurança alimentar ou garantia de qualidade.
   A redistribuição não influencia a ordem. PRICE usa total completo, DELIVERY usa apenas prazo (sem frete).
   CONTEXT recebe `softLimits`, enquanto `refinements` obrigatórios já foram validados na elegibilidade.
- **`coverage` por recomendação**: critérios com/sem dado, contagens, peso configurado, peso observado e
  `weightedFraction = scoredWeight / configuredWeight`; descreve cobertura de critérios, não confiança.
  **`orderingKeys`**: `estimatedTotalCents`, `estimatedMinutes` (máximo observado), `preferencesSatisfied`;
  valor desconhecido é `null`, nunca zero. Limitações de observação parcial ficam em `dataLimitations`.
- O `ranking` do topo traz `weights`, `priority`, `maxRecommendations`, `eligibleConsidered`, `eligibleScored` e
   `notes`, além de `contractVersion`, `status`, `clarification`, `orderingPolicy: "DEC_01_D9"`,
   `scoreInterpretation: "RELATIVE_DIAGNOSTIC_NOT_PROBABILITY"` e
   `missingDataPolicy: "UNKNOWN_LAST_SCORE_DIAGNOSTIC_ONLY"`.
- Preferência opcional não exclui uma configuração obrigatoriamente viável: a configuração preferida só é
  adotada com configuração válida e `PASS` em todos os tetos informados. Caso contrário, mantém-se o mínimo
  obrigatório e informa-se `PREFERENCE_NOT_MET`. Quando adotada, `configuration.source` é `PREFERENCE` e
  `pricing.selected` traz seu preço; `minimumConfigurable` preserva o menor preço sob condições obrigatórias.
  Seleções explícitas do usuário são preservadas. Valores monetários da API continuam em centavos inteiros.
- Sugestões alternativas do domínio mantêm a quantidade original e reavaliam entrega + orçamento; `FAIL`
  ou `UNKNOWN` em qualquer teto impede a sugestão validada. Sem teto, preço aberto continua explicitamente
  incerto. Detalhes e regressões: `docs/ranking.md`, seção 10.
- Garantias: restrição obrigatória vence qualquer pontuação; zero/uma opção não é completada com não elegíveis.
  `orderingKeys.estimatedTotalCents` já está em centavos e não é reconvertido. Textos apresentam reais formatados.

Exemplo **histórico**, anterior à RANK-03 (não usar como contrato 2.0). O exemplo atual e a tabela antes/depois
estão no [guia de migração](rank-03-contrato-v2.md#contrato-http-antesdepois):

```json
{
  "summary": { "candidates": 17, "eligible": 4, "blocked": 0, "needsVerification": 13, "recommendations": 4,
    "blockerCounts": { "NOT_DETAILED": 13 } },
  "ranking": { "weights": { "PREFERENCES": 0.35, "CONTEXT": 0.25, "PRICE": 0.4, "DELIVERY": 0.1, "RATING": 0.1 },
    "priority": "ECONOMY", "maxRecommendations": 4, "eligibleConsidered": 4, "eligibleScored": 4,
    "notes": ["Pesos do ranking: preferências 35%, contexto 25%, preço 20%, entrega 10%, avaliação 10%; prioridade ECONOMY dobra o peso de PRICE."] },
  "recommendations": [
    { "itemId": "c29bfc17-0c56-4925-9298-93c946c39075", "eligible": true,
      "item": { "name": "Maria salada Veg" },
      "listingPrice": { "unitPriceCents": 2990, "promotionalUnitPriceCents": 2990, "definitive": false },
      "ranking": {
        "rank": 1, "score": 0.9124,
        "criteria": [
          { "criterion": "PREFERENCES", "weight": 0.35, "effectiveWeight": 0.3684, "status": "SCORED",
            "score": 1, "contribution": 0.3684, "basis": "Média de 1 sinal(is) de preferência (…).",
            "reasons": ["combina com o tipo de comida pedido: \"vegano\""], "dataLimitations": ["Preferências avaliadas por similaridade de texto (…)"] },
          { "criterion": "CONTEXT", "weight": 0.25, "effectiveWeight": 0, "status": "NO_DATA",
            "score": null, "contribution": null, "basis": "Nenhum limite de contexto (…) informado na requisição.",
            "reasons": [], "dataLimitations": [] },
          { "criterion": "PRICE", "weight": 0.4, "effectiveWeight": 0.4211, "status": "SCORED",
            "score": 1, "contribution": 0.4211, "basis": "Preço por unidade normalizado (min–max) entre 4 opção(ões) elegível(eis).",
            "reasons": ["preço estimado R$ 29.90 por unidade", "menor preço entre as opções elegíveis"], "dataLimitations": [] },
          { "criterion": "DELIVERY", "weight": 0.1, "effectiveWeight": 0.1053, "status": "SCORED",
            "score": 0.5, "contribution": 0.0527, "basis": "Tempo e taxa de entrega normalizado (…) entre 4 elegível(eis); média de 2 de 2 subcritérios.",
            "reasons": ["entrega estimada 30–40 min", "taxa de entrega R$ 6.99"], "dataLimitations": [] },
          { "criterion": "RATING", "weight": 0.1, "effectiveWeight": 0.1053, "status": "SCORED",
            "score": 0.6667, "contribution": 0.0702, "basis": "Avaliação do estabelecimento normalizada (min–max) entre os candidatos elegíveis.",
            "reasons": ["avaliação 4.9 ★ (258 avaliações)"], "dataLimitations": [] }
        ],
        "reasons": ["combina com o tipo de comida pedido: \"vegano\"", "preço estimado R$ 29.90 por unidade",
          "menor preço entre as opções elegíveis", "entrega estimada 30–40 min", "taxa de entrega R$ 6.99",
          "avaliação 4.9 ★ (258 avaliações)"],
        "dataLimitations": ["critério CONTEXT sem dado (NO_DATA): peso redistribuído entre os demais — sem nota calculada",
          "Preferências avaliadas por similaridade de texto (nome/descrição/opções): ausência do termo não prova ausência do ingrediente — usado só para preferência, nunca para segurança"]
      } }
  ],
  "eligible": ["…"], "blocked": [], "needsVerification": ["…"]
}
```

## 9. Callback por ambiente

No desenvolvimento, `http://localhost:8000` exige cadastro exato e navegador no computador do backend.
No serviço online, o ensaio usou `https://api-backend-production-9c4c.up.railway.app/callback`, com cadastro aprovado segundo o usuário e conexão operacional observada. PUBLIC_BASE_URL e IFOOD_REDIRECT_URI devem coincidir com o ambiente/cadastro; não substituir o HTTPS por defaults locais.
Com origem pública, a proteção de loopback não se aplica; permanecem tentativa com state/PKCE, prazo e navegador vinculado por cookie. A autorização humana ocorre no navegador, sem segundo clique Telegram. Consulte o estado observado no bot; esta documentação não verifica continuamente o deploy.

## 10. Recorte da demo (não é isolamento multiusuário completo)

- Um organizador em `ALLOWED_ORGANIZER_IDS`, uma conta iFood dedicada de teste.
- Vínculos OAuth usam arquivos modo 600 em `IFOOD_LINKS_DIR`, fora do Git, sem criptografia dos tokens em repouso ou revogação no provedor. Tentativas pendentes ficam em memória. RUN-01/DATA-01/CART-01 usam SQLite separado; logs e métricas sanitizados seguem OPS-02. Operar com um único processo; não há rate limiting HTTP geral.
- Vínculos confirmados sobrevivem a reinício e redeploy **somente** se `IFOOD_LINKS_DIR` estiver num volume persistente
  (OPS-01, [ops-01-persistencia](ops-01-persistencia.md)). Tentativas pendentes continuam voláteis.
- Sessão global antiga (`/api/auth/*`) desligada por padrão e nunca importada como vínculo.

## 11. Configuração

```bash
# api-backend (.env)
BOT_API_TOKEN=<segredo ≥ 32 chars>       # node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
ALLOWED_ORGANIZER_IDS=<ID numérico do organizador>
PUBLIC_BASE_URL=http://localhost:8000
IFOOD_LINKS_DIR=.ifood-links             # deploy: dentro do volume persistente (ex.: /data/ifood-links)

# telegram-bot (sugestão de nomes; decisão do bot)
BACKEND_BASE_URL=http://localhost:8000
BACKEND_API_TOKEN=<o mesmo segredo BOT_API_TOKEN da API>
TELEGRAM_ALLOWED_USER_ID=<mesmo ID de ALLOWED_ORGANIZER_IDS>   # enviado como X-Telegram-User-Id
```

## 12. Carrinho — legado F7 e preparação CART-01

Na árvore local de 20/10/2026, a F7 e todas as rotas `/api/bot/cart` foram retiradas (404 após autenticação). Remova `IFOOD_CART_ENABLED` do ambiente; `true` é recusado na inicialização. A [DEC-01 vigente](decisoes-conversacionais.md) permite carrinho real confirmado somente pelo caminho CART-01. PREPARE_CART não usa `/purchase-approvals`; pedido/pagamento continuam proibidos.

O contrato de endpoints em [f7-cart-checkout.md](f7-cart-checkout.md#endpoints-do-telegram) é histórico e não descreve rotas disponíveis na árvore atual.

Leitura de catálogo permanece no executor do assistente. Não inventar referências nem obter IDs da LLM. A retirada também elimina `/api/auth/*` e `/api/diagnostics/search`; OAuth continua exclusivamente por vínculo Telegram. Ver [migração](retirada-legado.md).

A implementação local da [CART-01](cart-01-escrita-confirmada.md) usa rotas próprias em `/api/bot/v1/conversations/:conversationId/cart-writes`, compra/sacola DATA-01/GRP-01 e confirmação humana PREPARE_CART. O adaptador preserva `requestId`, `callbackId` e referência da confirmação; replay consulta a intenção persistida e não repete escrita. `RESULT_UNKNOWN` bloqueia novas mutações, inclusive com outro requestId. O opt-in novo permanece desligado por padrão e exige manifesto de evidência externa; ativação depende de INT-02 e BOT-03. Preparar itens não autoriza enviar pedido nem selecionar/processar pagamento.

## 13. DOM-01 — Limites locais e total parcial

O domínio agora também calcula em centavos; campos HTTP `*Cents` mantêm a unidade, sem reconversão. `refinements` de prazo, distância, frete, nota e promoção são condições obrigatórias também verificadas localmente. O campo aditivo `softLimits` aceita os mesmos alvos, sem `sort`, como preferências: não filtra MCP e não bloqueia elegibilidade. Cada candidato expõe resultados em `limits`; campos de frete usam `*Cents`.

Taxa de serviço não observada no catálogo é `service:{feeCents:null,status:UNKNOWN}`. `itemsAndDeliverySubtotalCents` contém apenas itens + entrega conhecidos. **Mudança semântica:** `estimatedTotalCents` não afirma mais esse subtotal como total completo; fica `null`, com limite superior desconhecido em `estimatedTotalRange`. Orçamento total só passa com todos os componentes relevantes conhecidos; mínimo acima do teto ainda reprova. Não reconstruir total com `null ?? 0` no cliente. Exemplos anteriores de total fechado sem taxa de serviço são históricos e substituídos por esta regra.

Conversão BRL, precisão, faixas, rateio e limites de integração: [dom-01-centavos-limites.md](dom-01-centavos-limites.md).
