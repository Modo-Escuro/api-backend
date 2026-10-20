# GRP-01 — Propostas coletivas e composição para carrinho real

> Atualização local de 20/10/2026: `domain/group.ts` continua sendo a composição pura. Seu consumidor conversacional atual é `assistant/bag.ts`, com candidatos detalhados do executor; o antigo `services/group.ts`/processador `agent/` foi [retirado](retirada-legado.md). Trechos de montagem/testes do agente abaixo são históricos.

Issue de origem: [#17 GRP-01](https://github.com/Modo-Escuro/api-backend/issues/17) · Base: [DATA-01](data-01-compra.md), [DOM-01](dom-01-centavos-limites.md), [ranking](ranking.md), [assistente](assistente-conversacional.md), [DEC-01](decisoes-conversacionais.md)

Gera até 4 propostas de compra para o grupo, com cobertura **por pessoa** e custo agregado, a partir de leituras
MCP (`searchOffers`/`getItem`). A proposta escolhida vira uma **composição local versionada** gravada na compra, fonte única para preparar o carrinho real pela CART-01. A GRP-01 ainda não sincroniza essa composição com o iFood: não chama `createCart`/`addItemToCart`. Essa é uma lacuna de integração, não o escopo final. A escrita exige confirmação PREPARE_CART e INT-02; envio e pagamento seguem proibidos.

## Fluxo

```
Pedido natural → roteador sem fatos → perfis selecionados → IA de compras
  → AssistantTools: consultas por vínculo/endereço confirmado; getItem dos candidatos
  → assistant/bag.ts: prévia da sincronização de participantes e restrições
  → composeProposals: matriz pessoa × item → planos por loja → custos (DOM-01) → validação → ranking → corte em 4
  → SET_PROPOSALS + sincronização no mesmo commit DATA-01 → cartões TEXT numerados
"Confirmo: escolher a opção 2." → SELECT_PROPOSAL (sem IA) → sacola local + texto de confirmação
```

## Regras

| Tema | Comportamento |
| --- | --- |
| Matriz | Cada pessoa avaliada com as **próprias** restrições (`evaluateCandidate`); nunca a união do grupo |
| Dado insuficiente | Restrição não informada, ambígua ou pergunta pendente ⇒ `NEEDS_VERIFICATION`; alergia sem evidência nunca é compatível |
| Restrição mudou | A cobertura guarda a assinatura das restrições usadas; mudou (ou ficou desconhecida) ⇒ quem consome vira `NEEDS_VERIFICATION` (`RESTRICTIONS_CHANGED`) e o plano/sacola fica inválido |
| Planos | Uma loja por plano (D2); uma linha por pessoa atendida, quantidade 1 (porções não são inventadas) |
| Cobertura | Toda pessoa aparece como `COVERED`, `BLOCKED` ou `NEEDS_VERIFICATION`, com motivo; ninguém é excluído em silêncio |
| Custos | `allocateCosts` da DOM-01: frete uma vez, rateio exato em centavos |
| Total | A taxa de serviço nunca aparece no catálogo ⇒ total exato desconhecido (preço `UNKNOWN`); usamos a **soma observada** (itens pelo mínimo da faixa, entrega observada ou 0 se ausente, serviço 0) |
| Soma observada **não é piso garantido** | Ignora cupons, descontos e frete de assinatura não visíveis. É exibida como "Soma dos preços observados — não é o total", nunca como "pelo menos". Exclusões por teto são qualificadas ("pelos preços observados") e a explicação avisa que quem ficou de fora pode caber |
| Teto individual rígido | Item compatível mais barato acima do teto ⇒ pessoa fora (`LIMIT_EXCEEDED`). Só a parte da entrega estoura ⇒ `OWN_CAP_WITH_SHARES`. O resto do grupo continua |
| Teto coletivo rígido | Reparo guloso (sai a pessoa mais cara, `GROUP_LIMIT`). Como retirar alguém aumenta a parte da entrega dos demais, se o guloso retirar 2+ pessoas ou esvaziar o plano, procura-se por nível (retirar 1, depois 2…) a combinação válida com menos retiradas (`CAP_COMBINATION`), com orçamento de 64 avaliações por combinação. Não é ótimo garantido e a explicação diz isso |
| Pedido mínimo | Inalcançável até pelo preço máximo ⇒ plano inválido; incerto ⇒ bloqueia aprovação |
| Estouro é provisório | Teto passado pela soma observada vira `OVER_OBSERVED` (nunca `FAIL`): tira a pessoa **desta sugestão**, com motivo qualificado; nada é gravado na pessoa e a próxima sugestão recalcula |
| Teto ambíguo | `UNVERIFIABLE`; bloqueia aprovação |
| Preferência | Estourada ⇒ aviso; não invalida |
| Preço ausente | Item não entra; nunca vira zero |
| Ranking | Interface `PlanRanker` (contrato com RANK-03); provisório `interimPlanRanker`: mais pessoas atendidas → valores comparáveis antes de incompletos (entrega desconhecida **nunca vale zero**) → economia ou rapidez → menos avisos → desempate estável. Opções de cada pessoa ordenadas por `rankCandidates` (RANK-01/02/03) sem eliminar as demais |
| Dados do MCP | Candidatos ordenados e sem duplicatas (resultado independe da ordem da resposta); detalhe de outro item/loja é descartado e contado na explicação. Taxas divergentes da mesma loja ⇒ entrega desconhecida (`DELIVERY_FEE_DIVERGENT`), soma usa a menor; mínimos divergentes ⇒ menor, com `MINIMUM_ORDER_DIVERGENT` |
| Busca | Lojas em ordem de potencial (pessoas atendíveis, menor preço), não por ID; cortes de opções/combinações aparecem na explicação |
| Corte | Até 4 **depois** de compor; quem só é atendido por um plano mais abaixo é resgatado; se impossível, aparece em `lostByCut` e na explicação ("há opção válida fora das 4") |
| Explicação | Aviso de busca limitada **sempre primeiro**; pessoas sem atendimento agrupadas por motivo (até 10 nomes por linha); cita filtro de loja quando houver; nunca afirma impossibilidade global |

## Composição local versionada (DATA-01)

- Campos opcionais em `PurchaseState`: `proposals` (até 4) e `bag` (proposta escolhida + `status` + origem).
  Cada proposta guarda a cobertura por pessoa com motivo.
- Operações: `SET_PROPOSALS`, `SELECT_PROPOSAL`, `CLEAR_BAG`.
- Proposta guarda cobertura com assinatura de restrições e incertezas do MCP; `addressId` é opcional no tipo. O executor revalida a seleção autorizada para consultar catálogo; CART-01 resolve e revalida o endereço antes de escrever. Não presumir que toda proposta persistida recebeu SET_ADDRESS.
- **Revalidação no commit:** `SET_PROPOSALS` recusa proposta sem cobertura de todos, com consumidor cuja assinatura
  não bate com as restrições atuais (ou desconhecidas), ou com endereço diferente do declarado — não confia só no processador.
- Qualquer outra alteração apaga as propostas (valem só para o estado em que foram geradas).
- Mudar participantes, restrições, tetos, perguntas ou endereço ⇒ sacola `NEEDS_REVALIDATION` (bloqueia aprovação).
- Remover alguém tira o consumo dele; linha sem consumidor some; sacola vazia é apagada.
- Trocar de loja ou de conta apaga sacola e propostas.
- `CLEAR_BAG` desfaz a loja quando ela foi fixada **só pela escolha** (`merchantSetBySelection`); loja declarada pelo usuário é preservada.
- Loja fixada só pela escolha: escolher proposta de outra loja troca loja e sacola. `SET_MERCHANT` torna a loja explícita (desliga a marca).
- O executor confere o vínculo antes de publicar resultados. A escolha digitada é reconhecida somente pelo texto fixo; pedido misturado de busca/escolha não executa seleção por JSON do modelo. O número corresponde à última lista de propostas gravada no escopo.

A sincronização dos perfis só é commitada junto de composição válida. Restrição desconhecida deixa a pessoa sem atendimento verificado; não vira ausência de restrição. Sem consumidor coberto não há proposta nem criação de participante por essa ponte. A lista de propostas pode sobreviver a turnos sem alterações de domínio; outra operação de domínio a invalida.

## Bloqueios de avaliação e preparação

`TOTAL_UNKNOWN` (sempre, por causa da taxa de serviço), `DELIVERY_FEE_UNKNOWN`, `PRICE_RANGE`, `LIMIT_UNVERIFIABLE`,
`MINIMUM_ORDER_UNVERIFIED`, `PARTIAL_COVERAGE`, `RESTRICTIONS_UNVERIFIED`, `BAG_NEEDS_REVALIDATION`, mais o aviso de
que aprovação de pedido não existe nesta etapa. O assistente não emite os antigos blocos REVIEW/PROPOSAL nem ações de aprovação; cartões são TEXT e `humanApproval` continua `null`. A revisão completa para PREPARE_CART usa o serviço separado CART-01, não a apresentação social da IA.

## Tamanho da resposta

O runtime limita o resultado persistido a 64 KiB e valida snapshot/operação antes de gravar. O antigo `renderSnapshot` e seu orçamento específico foram retirados; suas garantias de degradação de GROUP/REVIEW não se aplicam ao assistente atual. Cartões são montados em `assistant/bag.ts`; a revisão CART-01 tem seus próprios limites de apresentação e não pode ser truncada para obter confirmação.

O padrão do runtime é 20 participantes; o domínio suporta limites maiores quando configurado internamente, mas teste puro com 100 pessoas não comprova apresentação/compra de um grupo desse tamanho no Telegram.

## Contrato de preparação real (CART-01 / BOT-03)

A GRP-01 fornece a composição local; a CART-01 deve sincronizá-la com o carrinho real somente após confirmação humana PREPARE_CART. Não há aprovação alternativa ou sucesso de preparação baseado apenas na composição local.

1. A revisão explicita itens, opções, quantidades, consumidores, restrições, tetos, valores conhecidos e custos ainda desconhecidos. Taxa UNKNOWN nunca vale zero, não valida orçamento completo e continua impedindo aprovação de pedido.
2. A confirmação de uso único e com expiração vincula organizador/conversa, conta/link, compra, versão/hash, loja/endereço, composição e incertezas. Não entra no modelo nem é inferida de login ou texto livre.
3. Antes da escrita, revalidar endereço, produtos/getItem, opções, quantidades, elegibilidade por consumidor e limites verificáveis. Dado alimentar obrigatório insuficiente bloqueia o item para a pessoa; custo já conhecido acima de teto rígido não é ignorado.
4. Consumir confirmação e persistir intenção atomicamente antes da rede. Timeout ou resultado desconhecido bloqueia repetição até reconciliação confiável; mudança relevante exige nova revisão/confirmação.
5. Consultar e reconciliar o carrinho real antes de apresentar “CARRINHO PREPARADO — PEDIDO NÃO ENVIADO”. INT-02 #40 precisa validar outputs reais por operação antes da ativação.

O contrato é distinto de `/purchase-approvals` e da futura SUBMIT_ORDER. A implementação CART-01 está presente na árvore local, desligada por padrão. A ligação da nova experiência de cartões/sacola à revisão humana do bot ainda exige verificação própria. Envio/pagamento permanecem proibidos; não inferir merge/deploy do código local.

## Arquivos

| Arquivo | Papel |
| --- | --- |
| `src/server/domain/group.ts` | Matriz, composição, custos, validação, `PlanRanker`, corte, explicação, avaliação de sacola |
| `src/server/assistant/tools.ts` | Leitura MCP, candidatos detalhados e endereço realmente observado/autorizado |
| `src/server/services/group-search.ts` / `group.ts` | Exploração progressiva e composição pura preservadas da main; sem wrapper do agente antigo |
| `src/server/domain/purchase.ts` | Propostas, sacola, operações e invalidações |
| `src/server/assistant/bag.ts` | Ponte memória↔participantes, composição e cartões numerados |
| `src/server/assistant/processor.ts` | Ciclo de IA, SET_PROPOSALS e seleção digitada sem modelo |
| `src/server/cart/write-service.ts` | Revisão e preparação real confirmada, com gate de evidência |

## Limitações

- Taxa de serviço desconhecida ⇒ nenhum teto pode ser comprovado como atendido; validação do orçamento e aprovação de pedido bloqueadas. A confirmação PREPARE_CART segue as regras específicas da DEC-01, sem declarar total conhecido.
- Busca k-best limitada (8 opções por pessoa, 60 combinações por loja, 240 no total); planos válidos fora dela não são vistos (dito na explicação).
- Teto coletivo: guloso com busca limitada por menos retiradas; não garante o subconjunto ótimo.
- Propostas não têm prazo de validade: preço e loja aberta podem mudar até a escolha (qualquer alteração da compra já as apaga).
- Itens compartilhados só existem se escolhidos explicitamente (o gerador não supõe que uma unidade serve várias pessoas).
- Alergias quase sempre ficam em verificação: o MCP não traz alérgenos (D6).
- Ranking de planos provisório até a RANK-03 expor um ranqueador de planos.
- Confirmação PREPARE_CART por botão depende de BOT-03 e contrato CART-01 integrado; aprovação futura de pedido pertence à BUY-01 e nunca reutiliza essa confirmação.
