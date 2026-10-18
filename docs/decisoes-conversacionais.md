# DEC-01 — Decisões técnicas da demo conversacional

Issue: [#5 DEC-01](https://github.com/Modo-Escuro/api-backend/issues/5) · Contrato relacionado: [conversation-api-v1](conversation-api-v1.md) · Requisitos anteriores: [requirements](requirements.md)

## Situação

As 10 decisões abaixo foram **adotadas em 18/10/2026 pelo solicitante** (E-RuiL-Vieira, responsável pela #5),
que relatou que o grupo delegou as decisões técnicas e confirmou a adoção. Este documento não registra votação
da equipe nem autorização da mentoria. A validação externa da demo está em [Riscos](#riscos), como risco
independente, não como bloqueio.

Escopo da demo: 1 organizador, participantes simulados, 1 loja, 1 endereço, 1 pagamento fictício, sacola
simulada, MCP do iFood somente leitura. Aprovar a sacola simulada não autoriza nenhuma transação.

Regras transversais mantidas: restrições obrigatórias antes do ranking, dinheiro em centavos inteiros,
aprovação humana antes de qualquer efeito, e o modelo nunca aprova a própria compra.

## Resumo das decisões

| # | Ref. StRS | Decisão adotada |
| --- | --- | --- |
| D1 | DA05 | Organizador único; participantes simulados, sem contas; dados declarados pelo organizador; aprovação humana só pelo organizador |
| D2 | DA06 | 1 compra simulada ativa, 1 loja, 1 endereço, 1 organizador, 1 pagador fictício |
| D3 | DA04 | Consumo individual; compartilhado em partes iguais; entrega e serviço só entre consumidores; desconto proporcional ao subtotal elegível; resíduos por `participantId`; sem negativos; taxa desconhecida não vira zero |
| D4 | DA04 | Tetos coletivo e individuais simultâneos; centavos inteiros; custo desconhecido impede aprovação |
| D5 | RS05 | Alergias, restrições obrigatórias e tetos máximos são rígidos; preferências são flexíveis; ambiguidade exige esclarecimento |
| D6 | DA03 | Elegibilidade alimentar exige evidência específica; UNKNOWN bloqueia; filtro não comprova ausência de alérgeno; nenhuma confirmação inventada |
| D7 | DA07 | Excluir dados ao encerrar; simulação expira após 24 h inativa; logs técnicos minimizados por até 7 dias; OAuth independente até desconexão, expiração ou revogação |
| D8 | DA10 | Sacola 100% simulada; aprovação humana presa à versão e ao hash; mudança invalida; "PEDIDO NÃO ENVIADO"; MCP só leitura |
| D9 | DA02 | Prioridade economia/rapidez declarada; ambiguidade exige pergunta; dado ausente segue desconhecido; restrições rígidas prevalecem |
| D10 | DA08 | p95 ponta a ponta ≤ 10 s; 100% dos testes de alergia e orçamento; 100% dos rateios exatos; 5 demos seguidas sem erro; 0 chamadas MCP de escrita |

Restrições: sem `createCart`, `addItemToCart`, `submitOrder` ou pagamento real; sem múltiplas lojas, endereços,
pagamentos ou contas de participantes; desconto limitado à elegibilidade; inconsistência financeira bloqueia
aprovação; sem segurança alimentar inferida por categoria; sem aprovação automática; sem dados sensíveis em logs.

## D1 e D2 — Papéis e escopo

- O organizador autenticado pelo adaptador Telegram é o único usuário real. Participantes são registros simulados
  criados por ele, sem conta, login ou vínculo OAuth próprio.
- Toda restrição, limite e consumo de participante tem origem "declarado pelo organizador".
- Uma compra simulada ativa por organizador, com uma loja (`merchantId`) e um endereço (`addressId`), ambos vindos
  de respostas do MCP. O pagador é fictício e único; nenhuma operação de pagamento existe.

## D3 — Rateio (informativo, centavos inteiros)

O rateio mostra quanto cabe a cada participante simulado; nada é cobrado.

```
split(total, pesos[]) -> partes[]
  ordem: participantId crescente (comparação de bytes)
  W = soma(pesos)
  base[i]  = floor(total * peso[i] / W)
  resto[i] = (total * peso[i]) mod W
  sobra    = total - soma(base)
  +1 centavo para os 'sobra' participantes de maior resto;
  empate de resto -> menor participantId primeiro
```

1. Consumidores C = participantes com pelo menos um item atribuído (individual ou compartilhado).
2. Itens: individual → 100% ao consumidor; compartilhado → `split(preço, 1 por participante que compartilha)`.
   Preço do item = (`promotionalUnitPrice ?? unitPrice` + Σ `additionalPrice` das opções) × quantidade.
3. Entrega: valor = `promotionalFee ?? fee`; `split(entrega, 1 por consumidor)`. Promoção de entrega é taxa reduzida, não desconto.
4. Serviço: mesma regra da entrega, só entre consumidores.
5. Taxa ausente na resposta do MCP ⇒ componente UNKNOWN, nunca 0; o plano mostra "taxa desconhecida" e a aprovação fica bloqueada (D4).
6. Desconto: e[i] = subtotal elegível de cada pessoa (só itens a que o desconto se aplica); valor aplicado = min(desconto, Σe);
   `split(valor aplicado, e)`. Vários descontos: ordem crescente de identificador, cada um limitado ao elegível restante.
   Elegibilidade desconhecida ⇒ desconto não aplicado e sinalizado. `promotionalUnitPrice` já é preço-base e não entra de novo como desconto.
7. Total por pessoa = itens + entrega + serviço − desconto.
8. Invariantes: cada componente fecha exatamente no seu total; nenhuma parte e nenhum total negativo; mesma entrada ⇒ mesma saída.
   Violação ⇒ plano INCONSISTENTE e aprovação bloqueada.
9. Preço em faixa (regra 6 do CLAUDE.md, semântica "a partir de"): rateio calculado no mínimo e no máximo; limites
   conferidos contra o máximo; aprovação bloqueada enquanto houver faixa.

Exemplo: pizza R$ 60,00 dividida por A, B e C; bebida R$ 8,00 de A; salada R$ 30,00 de D; entrega R$ 7,99;
cupom R$ 10,00 válido em todos os itens. Valores em centavos:

| Pessoa | Itens | Entrega | Desconto | Total |
| --- | --- | --- | --- | --- |
| A | 2000 + 800 = 2800 | 200 | −286 | 2714 |
| B | 2000 | 200 | −204 | 1996 |
| C | 2000 | 200 | −204 | 1996 |
| D | 3000 | 199 | −306 | 2893 |
| Soma | 9800 | 799 | −1000 | 9599 |

Entrega: 799 ÷ 4 = 199 de base, sobra 3, que vão para A, B e C (empate de resto, menor `participantId`).
Desconto: os pisos somam 999; o centavo restante vai para A, que tem o maior resto (0,714).

| Caso-limite | Regra |
| --- | --- |
| Participante sem consumo | Não paga entrega nem serviço |
| Pessoa com alergia e item compartilhado | Item só é compartilhado entre pessoas compatíveis (RN07) |
| Desconto maior que o subtotal elegível | Limitado ao elegível; ninguém fica negativo |
| Taxa ausente no MCP | UNKNOWN, nunca 0; aprovação bloqueada |
| Preço em faixa | Mínimo e máximo; limites contra o máximo; aprovação bloqueada |
| Pedido abaixo do mínimo da loja | Plano não validado; mostrar quanto falta |
| Participante entra ou sai | Recálculo completo; aprovação anterior invalidada (RN06, CA12) |

## D4 — Limites

1. Valores em centavos inteiros; conversão de decimal só na borda.
2. total[i] ≤ teto[i] para cada teto individual rígido; Σ total ≤ teto coletivo rígido. As duas condições valem juntas.
3. Componente UNKNOWN ou em faixa ⇒ limite "não verificável" ⇒ aprovação bloqueada.
4. Inconsistência financeira (soma que não fecha, valor negativo, desconto acima do elegível) ⇒ aprovação bloqueada com erro explícito.
5. Teto de preferência só afeta ranking e explicação; nunca bloqueia.

## D5 — Rígido × flexível

1. Rígidos (bloqueiam): alergias, restrições alimentares obrigatórias, tetos máximos e prazo máximo declarados como limite.
2. Flexíveis (só ranking e explicação): preferências de sabor, valores aproximados ("uns R$ 50"), rapidez desejada sem limite.
3. Alergia explícita nunca vira preferência por inferência, histórico, score ou texto do modelo (RN01, RN02).
4. Marcadores de limite rígido: "no máximo", "até", "não passa de", "não posso", "sou alérgico", "sou celíaco".
5. Ambiguidade exige esclarecimento. Até a resposta: ambiguidade alimentar ⇒ item bloqueado; ambiguidade financeira
   ou de prazo ⇒ limite não verificável e aprovação bloqueada.
6. Rebaixar rígido para flexível exige declaração explícita registrada do organizador; o modelo nunca rebaixa.
7. Contradição ("sou alérgico a camarão, mas como um pouco") ⇒ esclarecer e manter rígida.

## D6 — Evidência alimentar

1. A evidência vale para uma combinação: loja, item, opções escolhidas e restrição. Não se transfere para outro item, variante ou restrição (CA07).
2. Filtro `itemRestrictions` do `searchOffers` (ex.: VEGAN, VEGETARIAN) conta só para aquela dieta ética ou religiosa.
   Nunca comprova ausência de alérgeno, nem atende alergia, doença celíaca ou intolerância declarada como rígida.
3. Nome ou descrição que cita o ingrediente pode reprovar (FAIL); nunca aprova (PASS).
4. Categoria da loja ou do item nunca é evidência.
5. Não há canal de confirmação com o restaurante na demo. Texto do modelo ou do organizador sobre o restaurante não é confirmação.
6. Sem evidência ⇒ UNKNOWN ⇒ item bloqueado para o participante, com aviso "informação indisponível — verifique com a loja".
7. Alergia relevante = qualquer alergia declarada de um participante atribuído como consumidor do item, inclusive compartilhado.
8. Participante sem item elegível ⇒ informar insuficiência (RN05); nunca completar a lista com item incompatível.

## D7 — Retenção e exclusão

Encerrar = o organizador conclui ou cancela, ou a simulação fica 24 h sem evento aceito. A aprovação fictícia não encerra sozinha.

| Classe | Conteúdo | Retenção | Exclusão |
| --- | --- | --- | --- |
| Dados da compra simulada | Participantes simulados, restrições, limites, itens, revisões, aprovação fictícia, histórico curto | Até encerrar, ou 24 h sem evento aceito | Imediata na transição para encerrada ou expirada |
| Logs técnicos (exceção) | Só identificador opaco de correlação, rota, nome da ferramenta MCP, código de status ou erro, latência, contadores | Até 7 dias | Expurgo diário do que passou de 7 dias |
| Vínculo OAuth (exceção) | Tokens e metadados do vínculo | Independente da compra | Imediata na desconexão, revogação ou expiração sem refresh possível |

- Nunca em log: texto de mensagem, nomes, alergias e restrições, endereço, tokens, valores por participante.
- Backups do armazenamento (OPS-01): rotação de até 7 dias.
- Refresh recusado ⇒ RECONNECT_REQUIRED e tokens apagados; falha de rede ⇒ UNAVAILABLE, tokens mantidos (CLAUDE.md).
- Pedido de exclusão antes de encerrar equivale a cancelar.
- Relatórios de teste e medição (D10) usam só dados sintéticos ou fixtures sanitizadas.

## D8 — Sacola simulada e aprovação fictícia

1. O MCP só é usado para leitura: `listAddresses`, `searchOffers`, `browseOffers`, `getRecommendations`, `getItem`,
   `getMerchant` e `getUser` restrito. Sem `createCart`, `addItemToCart`, `submitOrder` ou pagamento.
2. Revisão = retrato canônico da compra: `purchaseId`, versão, `merchantId`, `addressId`, itens (`itemId`, `optionId`s,
   quantidade, consumidores), componentes de custo e rateio em centavos, limites e situação de cada restrição.
3. Hash = SHA-256 do JSON canônico da revisão (chaves ordenadas recursivamente, sem espaços, centavos inteiros),
   alinhado ao `contentHash` de [conversation-api-v1](conversation-api-v1.md).
4. Aprovação fictícia = clique do organizador, vindo do adaptador autenticado, com `purchaseId`, versão e hash. A API
   confere que são os atuais e registra uma única vez. Nunca gerada pelo modelo; nunca automática.
5. Qualquer mudança cria nova versão e invalida a aprovação anterior. Clique duplo devolve a mesma aprovação; botão de versão antiga é rejeitado.
6. Aprovação bloqueada quando houver: custo UNKNOWN ou em faixa, inconsistência financeira, restrição rígida UNKNOWN ou
   FAIL para algum consumidor, limite rígido violado ou não verificável.
7. Após aprovar, a interface exibe **"SACOLA SIMULADA APROVADA — PEDIDO NÃO ENVIADO"**.

## D9 — Ordenação

1. Antes de ordenar: filtros rígidos (D4, D5, D6), loja aberta (`isOpen`) e item detalhado por `getItem`.
2. Prioridade declarada: ECONOMIA ou RAPIDEZ. Sem prioridade ou ambígua ⇒ o agente pergunta antes de ordenar.
3. Chaves, em sequência:

| Prioridade | Chave 1 | Chave 2 | Chave 3 | Desempate final |
| --- | --- | --- | --- | --- |
| ECONOMIA | Custo total estimado (centavos, crescente) | `estimatedMinutes` (crescente) | Preferências flexíveis atendidas (decrescente) | `merchantId`, depois `itemId` (crescente) |
| RAPIDEZ | `estimatedMinutes` (crescente) | Custo total estimado (crescente) | Preferências flexíveis atendidas (decrescente) | `merchantId`, depois `itemId` (crescente) |

4. Valor desconhecido numa chave fica depois de todos os conhecidos naquela chave, marcado "desconhecido"; nunca vale 0.
5. Resultado: de 2 a 4 opções elegíveis (RN05); alternativa distinta mais rápida ou mais barata aparece com a troca explicada em valores observados (RS08).

## D10 — Metas e medição

A demo só é considerada pronta quando as 5 metas passam.

| Meta | Fórmula | Instrumento | Amostra | Critério |
| --- | --- | --- | --- | --- |
| Tempo ponta a ponta | p95 por posição: tempos em ordem crescente, valor na posição ⌈0,95 × n⌉. Tempo = do aceite do evento na API até a recomendação pronta | Timer monotônico no backend, em log técnico com correlação opaca | n = 40: 4 contextos fixos × 10 execuções, MCP real só leitura (p95 = 38ª posição) | ≤ 10 000 ms |
| Testes de alergia e orçamento | aprovados ÷ total | Vitest offline com fixtures reais sanitizadas; inclui os cenários abaixo | Todos os testes marcados alergia ou orçamento | 100%, sem teste ignorado |
| Rateio exato | casos válidos ÷ casos; válido = cada componente fecha, nenhuma parte negativa, saída idêntica em 2 execuções | Teste de propriedade com gerador de semente fixa | 1 000 casos aleatórios + exemplos deste documento | 100% |
| Demos seguidas | Execuções consecutivas sem erro; erro = exceção não tratada, estado errado, invariante violada ou chamada de escrita; uma falha zera o contador | Roteiro de demo Telegram → API → MCP | Até atingir 5 seguidas | 5 |
| Escrita no MCP | Chamadas a ferramentas fora da lista de leitura | Contador no gateway MCP + teste que tenta `createCart`, `addItemToCart` e `submitOrder` e espera rejeição | Todas as execuções de teste e de demo | 0 |

## Cenários de validação

1. Grupo de 4 pessoas, limites diferentes, frete e taxa comuns: a soma rateada fecha exatamente em centavos e cada pessoa cabe no próprio limite (CA10).
2. Participante com alergia e item sem informação de ingrediente: o item fica bloqueado para essa pessoa, com pendência visível (CA06).
3. Confirmação de outro item ou variante: não libera o item atual (CA07).
4. Teto do grupo muda de R$ 180 para R$ 150: restrições e participantes são preservados e o plano é reavaliado (CA12).
5. Nenhum plano completo cabe: o conflito é explicado e a cobertura parcial aparece sem excluir alguém em silêncio (CA11).
6. Participante sem consumo: não paga entrega, e a soma da entrega fecha entre quem consome (D3).
7. Teto declarado como "uns R$ 150": o agente pede esclarecimento antes de validar esse limite (D5).
8. Sacola simulada aprovada: a interface mostra "pedido não enviado" e nenhuma mutação é chamada no iFood (D8).
9. Organizador declara a alergia de um participante simulado: o item incompatível fica bloqueado só para esse participante, e o rateio informativo exclui o item dele (D1, D3).
10. Qualquer chamada a `createCart`, `addItemToCart`, `submitOrder` ou operação de pagamento é rejeitada no backend e não chega ao MCP (D8).
11. Taxa de serviço ausente na resposta do MCP: aparece como desconhecida, nunca 0, e a aprovação fica bloqueada (D3, D4).
12. Desconto maior que o subtotal elegível: aplicado só até o elegível, e ninguém fica com valor negativo (D3).
13. Item vindo do filtro VEGAN e participante com alergia a amendoim: o item continua UNKNOWN e bloqueado para ele (D6).
14. Simulação sem evento por 24 h: expira e os dados da compra são excluídos; o vínculo OAuth continua (D7).

## Riscos

| # | Risco | Efeito | Mitigação |
| --- | --- | --- | --- |
| R1 | A validação externa da demo simulada como estado final do evento não está registrada; não se presume autorização da mentoria | A banca pode esperar carrinho ou pedido real | Apresentar a fronteira explicitamente ("PEDIDO NÃO ENVIADO"); compra real exige nova decisão, não extensão desta |
| R2 | Sem canal com o restaurante, quase toda alergia fica UNKNOWN (D6) | Participante com alergia pode ficar sem item elegível | Mensagem de insuficiência (RN05) faz parte do roteiro da demo |
| R3 | p95 ≤ 10 s depende da latência real do MCP | Meta D10 pode falhar sem mudança de código | Detalhamento paralelo limitado, cache de `getItem` (requisitos atuais) e medição antes da demo |
| R4 | Escopo de #7, #18, #19 e #20 descreve carrinho e envio reais | Trabalho fora da demo | Seção Impacto abaixo; revisão do escopo das issues fica com a equipe |
| R5 | Contrato API-01 prevê aprovação só com total confirmado de carrinho e `OUTCOME` sem estágio simulado | Aprovação fictícia da D8 não cabe em `/purchase-approvals` | Ver Coerência; tratar como ajuste explícito do contrato, sem reutilizar a rota de compra |

## Coerência com CLAUDE.md e com o contrato API-01

- CLAUDE.md, regra 5 (sem `createCart`/`addItemToCart`/`submitOrder`): atendida por D8; MCP só leitura.
- Regra 6 (preço composto, faixa quando ambíguo): D3 usa o preço composto e trata faixa como bloqueio de aprovação.
- Regras 1–4 (IDs só do MCP, `getItem` antes de recomendar, ausente ≠ zero, restrição sem dado ⇒ não verificado): D2, D6, D9.
- Convenção de centavos inteiros na borda do bot: D3 e D4.
- Vínculo OAuth e estados `UNAVAILABLE`/`RECONNECT_REQUIRED`: D7 preserva o comportamento atual.
- [conversation-api-v1](conversation-api-v1.md): dinheiro `UNKNOWN`/`ESTIMATE`/`RANGE` corresponde a D3/D4; `contentHash`
  canônico corresponde ao hash da D8. Diferença: `/purchase-approvals` exige total `CONFIRMED` de carrinho validado e
  `OUTCOME` só tem `CART`/`ORDER`/`PAYMENT`. A aprovação fictícia não deve usar essa rota; o contrato precisa de ajuste
  explícito (ex.: ação de revisão simulada e resultado simulado), conforme a própria seção final do contrato prevê para decisões da DEC-01.

## Impacto nas issues

| Issue | O que esta decisão define | Dependências técnicas restantes |
| --- | --- | --- |
| [#7 INT-01](https://github.com/Modo-Escuro/api-backend/issues/7) | Auditar o F7, confirmar que fica desligado e garantir a lista de ferramentas só de leitura; critério "0 escrita" (D10) | — |
| [#10 DOM-01](https://github.com/Modo-Escuro/api-backend/issues/10) | Algoritmo de rateio (D3), limites (D4), rígido × flexível (D5) | — |
| [#11 RANK-03](https://github.com/Modo-Escuro/api-backend/issues/11) | Chaves de ordenação e tratamento de desconhecido (D9) | DOM-01, RANK-02 |
| [#13 DATA-01](https://github.com/Modo-Escuro/api-backend/issues/13) | Participantes simulados (D1), uma compra (D2), evidência por combinação (D6), retenção (D7) | OPS-01 |
| [#15 AI-01](https://github.com/Modo-Escuro/api-backend/issues/15) | Dados minimizados (D7); metas, fórmulas e amostras (D10) | — |

Fora do escopo da demo: [#18 CART-01](https://github.com/Modo-Escuro/api-backend/issues/18) e
[#20 BUY-02](https://github.com/Modo-Escuro/api-backend/issues/20), que dependem de carrinho e envio reais. De
[#19 BUY-01](https://github.com/Modo-Escuro/api-backend/issues/19), só a vinculação da aprovação à versão e ao hash (D8).
Este documento não altera essas issues.

## Alternativas consideradas (histórico)

| # | Alternativas avaliadas | Adotada |
| --- | --- | --- |
| D1 | Organizador único; cada participante no grupo; organizador + autoconfirmação | Organizador único, participantes simulados |
| D2 | 1 de cada; várias lojas; subgrupos; múltiplos endereços/pagamentos | 1 compra, 1 loja, 1 endereço, pagador fictício |
| D3 | Igual entre quem tem item; proporcional ao subtotal; sem rateio; misto | Misto (consumo, compartilhado igual, taxas entre consumidores, desconto proporcional) |
| D4 | Ambos valem; coletivo prevalece; individual prevalece | Ambos valem |
| D5 | Obrigatório só se explícito; todo valor é obrigatório; tudo é preferência | Rígido × flexível com marcadores; ambiguidade pergunta |
| D6 | Sem canal: bloquear; registro manual do organizador; canal integrado | Bloquear sem evidência específica |
| D7 | Apagar ao encerrar; manter entre compras; só memória do processo | Apagar ao encerrar, 24 h de expiração, logs 7 dias, OAuth independente |
| D8 | Sacola revisada; pedido enviado; pagamento concluído; carrinho real | Sacola 100% simulada |
| D9 | Ordenação estrita; score ponderado; híbrido | Ordenação estrita por prioridade declarada |
| D10 | Fixar metas agora; medir antes | Fixar agora, com fórmula e amostra |

Registro de trabalho com a análise completa de alternativas e riscos por opção: documento DEC-01 no claude.ai, privado ao solicitante.
