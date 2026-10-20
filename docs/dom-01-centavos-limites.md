# DOM-01 — Centavos, limites locais e rateio

Issue: [#10](https://github.com/Modo-Escuro/api-backend/issues/10). Base: `main@9de678b`, após RUN-01 e INT-01. Regras adotadas: [DEC-01 D3–D6 e D8](decisoes-conversacionais.md).

## Unidades e fronteiras

- No domínio, **todos** os valores monetários são centavos inteiros não negativos, até `Number.MAX_SAFE_INTEGER`. Os nomes internos preservados de `normalize.ts`/`pricing.ts`, como `basePrice`, `additionalPrice` e `fee`, agora significam centavos. Não misturar modelos normalizados com payloads crus do MCP.
- `money.ts` converte BRL do MCP uma única vez, por representação decimal e intermediários `BigInt`, antes dos cálculos. A conversão aceita `32.9 → 3290`, `0.29 → 29` e `1e-2 → 1`. **Não há arredondamento silencioso:** negativo, NaN/infinito, subcentavo (`1.005`, `0.001`) e overflow são rejeitados. Isso substitui a antiga política de arredondar o domínio a duas casas.
- Campos inválidos na normalização ficam `INVALID`; não viram zero ou preço de fallback. Ausente e `null` continuam estados distintos. Soma, quantidade, desconto e rateio operam sobre inteiros; overflow bloqueia o candidato, sem aprovar um valor arredondado.
- O corpo e a resposta de `/api/evaluate` continuam usando `*Cents`. O adaptador de resposta só renomeia/valida centavos, **não multiplica por 100 novamente**. Filtros monetários do `searchOffers` são convertidos para BRL exclusivamente na chamada MCP.
- O parser compartilhado `cart/contracts.ts` converte totais BRL na entrada, antes de conferir componentes. Ele permanece na CART-01, embora o serviço/rotas F7 tenham sido retirados. Outputs sintéticos não comprovam contrato externo; conversão monetária não habilita escrita.

Percentuais, minutos, quilômetros e notas não são dinheiro. Nota arredondada é só apresentação: o limite usa o valor observado sem arredondamento. Distância não é arredondada antes da comparação.

## Limites obrigatórios e flexíveis

`refinements.maxDeliveryTimeMinutes`, `maxDistanceKm`, `maxDeliveryFeeCents`, `minRating` e `onlyWithPromotion:true` representam condições obrigatórias. Além do filtro upstream, o backend confere a resposta localmente antes de tornar o candidato elegível. A promoção é conferida no detalhe, quando disponível; não basta a promessa da listagem. `sort` apenas solicita uma ordenação upstream, sem impor prazo/preço.

O campo aditivo `softLimits` aceita os mesmos alvos, sem `sort`. Ele não é enviado como filtro ao MCP e só gera avisos/resultados `PREFERENCE`; não altera elegibilidade nem implementa o ranking RANK-03. Pode coexistir com um teto obrigatório diferente.

```json
{
  "query": "jantar",
  "quantity": 2,
  "budget": { "maxOrderTotalCents": 8000 },
  "refinements": { "maxDeliveryTimeMinutes": 60, "maxDeliveryFeeCents": 500 },
  "softLimits": { "maxDeliveryTimeMinutes": 30 }
}
```

Cada candidato expõe `limits` com condição, limite, observado, requisito e `PASS/FAIL/UNKNOWN`. No frete, a projeção usa `metric:maxDeliveryFeeCents`, `limitCents` e `observed:{minCents,maxCents}`. Não se exporta `raw` de campo inválido.

- Prazo 55–60 min contra teto 30 ⇒ FAIL; faixa 20–40 contra 30 ⇒ UNKNOWN; máximo conhecido 30 contra teto 30 ⇒ PASS.
- Condição obrigatória FAIL ou UNKNOWN bloqueia. Alvo flexível FAIL ou UNKNOWN só gera aviso.
- Dado ausente, inválido, negativo ou faixa incoerente nunca equivale a zero ou cumprimento. Loja sem `isOpen:true` e configuração obrigatória UNKNOWN também bloqueiam.
- Orçamento por unidade usa a configuração precificada. Orçamento do pedido inclui quantidade e custos suportados. Faixa cruzando o teto ou limite superior desconhecido não recebe PASS; limite inferior acima do teto recebe FAIL.

## Subtotal conhecido não é total completo

As respostas de catálogo observadas não fornecem taxa de serviço. Por isso:

- `service:{feeCents:null,status:UNKNOWN}` registra a lacuna;
- `itemsAndDeliverySubtotalCents` apresenta apenas itens + entrega quando há valor único verificável para esses componentes;
- `estimatedTotalCents` permanece `null` e `estimatedTotalRange.maxCents` permanece desconhecido. O mínimo conhecido é preservado para detectar excesso de orçamento;
- um teto de pedido maior que o subtotal conhecido continua UNKNOWN, não PASS. Preço ambíguo ou opção sem preço não gera subtotal parcial de valor único;
- promoções de item/entrega já entram no componente correspondente. Não aplicar desconto promocional duas vezes nem inventar desconto/cupom ou taxa zero.

O catálogo continua produzindo estimativas/faixas, nunca cotação CONFIRMED. O contrato conversacional mantém UNKNOWN, ESTIMATE, RANGE e CONFIRMED distintos; a auditoria F7 não é prova de total remoto confirmado. `/purchase-approvals` não é autorização PREPARE_CART; preparação exige seu contrato próprio e aprovação futura de pedido exige custo completo confirmado.

**Limitação prática:** enquanto faltar um custo relevante, a validação do orçamento completo e a aprovação de pedido ficam bloqueadas. PREPARE_CART explicita a incerteza e não autoriza ignorar limites já verificáveis ou evidência alimentar insuficiente. Um modelo não pode preencher a lacuna por suposição. Obter os componentes verificáveis é trabalho de integração; não habilitar F7 para contornar essa ausência.

## Rateio informativo

`purchase-costs.ts` calcula uma atribuição já fornecida, sem escolher planos (GRP-01), persistir estado (DATA-01) ou aprovar (BUY-01):

1. Preço unitário × quantidade; consumo individual integral, compartilhado dividido igualmente entre os consumidores indicados.
2. Entrega e serviço divididos somente entre quem consome. Participante sem consumo recebe zero nesses componentes.
3. Descontos em ordem de identificador, proporcionais ao subtotal elegível restante, limitados a ele. Elegibilidade desconhecida não aplica desconto e gera aviso. Um mesmo centavo não é descontado novamente.
4. Maiores restos em cada rateio; empate por bytes de identificador. Soma exata e nenhum componente negativo. Quantidades, identificadores e centavos inválidos são rejeitados.
5. Tetos coletivo e individuais são conferidos simultaneamente, sem compensação entre pessoas. Custo comum desconhecido produz total/budget UNKNOWN para os consumidores afetados; mínimo da loja informado é conferido sobre o subtotal.

Esse helper recebe preços de item de valor único e componentes explícitos; não aceita uma faixa como se fosse um valor. Faixas permanecem no domínio de preço e seus limites são verificados por `checkCap`; eventual rateio dos extremos exige duas entradas de custo distintas, sem promover qualquer extremo a cotação única/aprovação. Integração com propostas, evidência alimentar por consumidor e revisão/confirmação PREPARE_CART pertence à CART-01; o helper não implementa esse contrato nem realiza escritas.

O campo `budgetsSatisfied` só resume as condições financeiras informadas: não é autorização nem prova de elegibilidade alimentar, validade de revisão ou clique humano. Não conectar JSON bruto do modelo a esse helper sem validação de domínio/servidor; o assistente atual usa protocolo próprio, sem repassar operações arbitrárias.

## Validação

Regressões offline em `test/domain/dom01.test.ts`: fronteira monetária, overflow, limites locais apesar do resultado upstream, preferência sem filtro, preservação do contrato em centavos e serviço desconhecido. O rateio reproduz o exemplo D3 (9599 centavos; A=2714, B=1996, C=1996, D=2893) e verifica 1000 casos com semente fixa, fechamento de cada componente, não negatividade e invariância à reordenação.

Testes existentes de normalização/preço foram migrados de unidade; fixtures MCP preservam o BRL original. Testes HTTP continuam esperando centavos, permitindo detectar conversão dupla. Suíte completa, typecheck, lint e build são necessários antes do merge. Os resultados finais ficam na descrição da PR; testes offline não comprovam comportamento do provedor.
