# Documentação iFood MCP para Agentes de IA

Este documento descreve o conjunto de ferramentas (Tools) e protocolos (MCPs) disponibilizados para integração de agentes de IA com o ecossistema do iFood. A arquitetura é dividida em quatro domínios principais: **User MCP**, **Offer Discovery MCP**, **Cart MCP** e **Order Tracking MCP**.

---

## Regras de Ouro (Transversais)
1. **Identidade Oculta:** O `userId` é **sempre** injetado pelo gateway via header HTTP. O agente **nunca** envia, recebe ou manipula o `userId` diretamente.
2. **Sem Invenção de IDs:** O agente **nunca** deve fabricar ou adivinhar IDs (`addressId`, `merchantId`, `itemId`, `cartId`, `orderId`, `taxonomyId`). Eles devem ser extraídos exatamente das respostas anteriores.
3. **Padrão de Nomenclatura:** Chaves JSON usam `lowerCamelCase`. Valores de enumeração usam `SCREAMING_SNAKE_CASE`. Identificadores são UUID v4 (exceto em casos específicos mencionados).
4. **Moeda:** Sempre em BRL formato decimal (ex: `32.90`).

---

## 1. User MCP
Gerencia identidade do usuário, perfil e endereços de entrega.

### Fluxo de Decisão (A regra do `listAddresses`)
**Sempre** chame `listAddresses` primeiro em qualquer fluxo.
1. **Retorno Vazio (0 endereços):** Peça o endereço -> Chame `createAddress(address)` -> Confirme com o usuário -> Salve.
2. **Retorno Único (1 endereço):** Avise o usuário e use o `addressId` retornado diretamente.
3. **Múltiplos Endereços:** Use dados comportamentais (`agentHints`) para inferir o correto ou apresente a lista (use o campo `alias` na UI).

### Tools Atômicas
*   **`getUser`**: Retorna nome, email, telefone e dados comportamentais. Usar no início da conversa.
*   **`listAddresses`**: Lista endereços salvos com análises de uso. Obrigatório antes de qualquer fluxo de entrega.
*   **`createAddress`**: Geocodifica e persiste um endereço.
    *   *Two-Step:* Manda string de endereço -> recebe `candidates` -> confirma -> manda `candidateId` -> recebe `addressId` permanente.
    *   *Single-Shot:* Manda endereço + complemento + alias -> cria direto (retorna `createdDirectly: true`).

---

## 2. Offer Discovery MCP
Lente do agente para o marketplace do iFood. Separação estrita entre `query` (termo de busca descritivo) e `refinements` (filtros como preço, distância).

### Tools Atômicas
1. **`searchOffers`**: Busca por texto. Requer `userLocation`. Retorna `MERCHANT` ou `ITEM`.
2. **`browseOffers`**: Navegação sem termo de busca. Requer `userLocation` e `merchantType` (ex: `RESTAURANT`, `GROCERIES`).
3. **`getRecommendations`**: Listas curadas (favoritos, repedidos, ofertas). Parâmetro chave: `contentMode`.
4. **`listItemTaxonomy`**: Retorna árvore de categorias global. **Não** recebe `userLocation` ou `userId`.
5. **`getMerchant`**: Detalhes operacionais completos (horários, entrega) após o usuário escolher a loja.
6. **`getItem`**: Detalhe completo de um item (preços promocionais, `optionGroups`) antes de adicionar ao carrinho. Obrigatório chamar após escolher o item.

### Tratamento de Erros e Dicas
*   **Erro Comum:** Enviar "pizza barata" em `query`. O correto é `query: "pizza"` e `refinements: { maxItemPrice: 30 }`.
*   O erro vem inline no corpo (`errors.message`, `errors.code`, `errors.retryable`).
*   Preços promocionais são campos escalares (`promotionalUnitPrice`, `promotionalFee`), não arrays.

---

## 3. Cart MCP
Gerencia a montagem e confirmação do pedido. Usa 13 tools atômicas (sem "operation enums").

### Fluxo de Checkout (Connection Journey)
1. `createCart` (Requer `merchantId`, `addressId` e itens do Discovery, ou apenas um `orderId` para reordenação).
2. `getCartDeliveryMethods` -> `setCartDelivery`
3. `listPaymentMethods` -> `setCartPayment`
4. (Opcional) `listVouchers` -> `setVoucher`
5. `getCart` (revisão final)
6. `submitOrder` (Requer `userConsent: true` e confirmação explícita. Opcional: CPF/CNPJ em `document`).

### Tools Atômicas
*   **`createCart`**: Cria carrinho novo e retorna `cartId`.
*   **`getCart`**: Retorna estado completo, totais e IDs atualizados.
*   **`addItemToCart` / `updateCartItem` / `removeItemFromCart`**: Mutam itens.
*   **`getCartDeliveryMethods` / `setCartDelivery`**: Gestão de métodos de entrega e agendamento.
*   **`listPaymentMethods` / `setCartPayment`**: Gestão de pagamentos.
*   **`listVouchers` / `setVoucher` / `removeVoucher`**: Gestão de descontos.
*   **`submitOrder`**: Envia pedido e retorna `orderId`.

### Conceitos e Cuidados Críticos
*   **`cartItemId` vs `itemId`**: `itemId` é o ID do catálogo (Offer Discovery). `cartItemId` é o ID do item *dentro do carrinho* (retornado por `addItemToCart` ou `getCart`). `updateCartItem` exige ambos.
*   **Array `options`**: Em `addItemToCart` e `updateCartItem`, o array `options` é **obrigatório**, mesmo que seja vazio `[]`.
*   **Erros**: A chave de erro é **singular** (`error` na raiz da resposta), divergindo do padrão MCP. Leia `error.code` e avalie `error.impact.canProceedToCheckout` para decidir sobre retries.
*   **Descobrir antes de aplicar**: Nunca aplique um método de pagamento, entrega ou voucher sem antes chamar a respectiva função de listagem (`listPaymentMethods`, `getCartDeliveryMethods`, `listVouchers`).

---

## 4. Order Tracking MCP
Consumo read-only da fase pós-checkout. Usa 2 tools apenas.

### Tools Atômicas
1. **`trackOrder`**: Rastreamento ao vivo. Requer `orderId`. Retorna status atual, histórico e cadência de polling.
2. **`getOrder`**: Detalhes estáticos do pedido (merchant, itens, pagamentos, endereço, código de verificação).

### Lógica de Polling e Erros
*   **Polling Controlado pelo Servidor:** O agente **nunca** usa intervalo fixo (ex: a cada 5s). Ele deve ler o campo `agentHints.retryMessage` (ex: "Please call again in 60 seconds") e aguardar esse tempo.
*   **Parada Absoluta:** Se `agentHints.pollingStop` for `true`, o pedido chegou a um estado terminal. Pare o polling imediatamente.
*   **Apresentação:** Leia `status.code` (ex: `DELIVERY_ARRIVED_AT_DESTINATION`) para a lógica do agente, mas apresente `status.description` na íntegra para o usuário final.
*   **Estrutura do Erro:** Os campos de erro (`errorType`, `code`, `message`, `retryable`, `suggestion`) vêm **diretamente na raiz da resposta**, sem encapsulamento em objetos "error" ou "errors".