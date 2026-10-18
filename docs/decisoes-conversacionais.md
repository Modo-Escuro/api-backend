# DEC-01 — Decisões técnicas vigentes

Revisão de 18/10/2026 autorizada pelo usuário, que confirmou a aprovação da equipe para carrinho real. [Estado remoto/local](estado-remoto-local.md) · [DEC-01 #5](https://github.com/Modo-Escuro/api-backend/issues/5) · [Decisão anterior preservada](https://github.com/Modo-Escuro/api-backend/blob/f3b8b5561acc0c0ae5e9efe12b52acc2f29bf218/docs/decisoes-conversacionais.md).

O único escopo de carrinho vigente é preparar/modificar o carrinho real após confirmação humana específica. Composição local e testes com mocks são etapas técnicas, não uma entrega alternativa. Não altera o baseline StRS nem declara validação da mentoria, integração real entregue ou autorização de pedido/pagamento. A main conferida ainda executa propostas/composição local ainda não sincronizada com o iFood; o código CART-01 auditado permanece local e separado desta revisão documental.

## Resumo vigente

| Decisão | Regra |
| --- | --- |
| D1 — Papéis | Um organizador por compra, participantes declarados por ele. Acesso por senha permite organizadores distintos com vínculos/conversas/filas isolados; não é compra compartilhada entre contas |
| D2 — Recorte | Uma compra ativa por organizador, uma loja e um endereço. Carrinho real só pelo fluxo confirmado. Nenhum pagamento ou envio permitido neste incremento |
| D3 — Rateio | Consumo individual, compartilhado igual, taxas entre consumidores e desconto pela elegibilidade. DOM-01 é fonte única, centavos inteiros e resíduos determinísticos |
| D4 — Limites | Tetos individuais e coletivo simultâneos. Total desconhecido não valida orçamento nem aprova pedido; PREPARE_CART explicita a incerteza e autoriza apenas preparar a composição |
| D5 — Obrigatório × preferência | Alergia, restrição obrigatória e teto rígido prevalecem; preferência não elimina candidato; ambiguidade exige esclarecimento |
| D6 — Evidência alimentar | UNKNOWN obrigatório bloqueia o item para a pessoa. Filtro dietético não comprova alergia nem substitui confirmação rastreável do restaurante |
| D7 — Dados | Domínio expira após 24 h inativo; logs minimizados por até 7 dias; OAuth independente. Intenção remota desconhecida não é apagada para liberar replay |
| D8 — Carrinho confirmado | PREPARE_CART de uso único, escopado à revisão; preparar carrinho não aprova pedido. Pagamento e envio proibidos |
| D9 — Ordenação | Prioridade declarada e restrições antes do ranking; dado ausente não vale zero; limites de busca explícitos |
| D10 — Medição | Zero escrita sem confirmação válida; zero pagamento/envio; testes automatizados sem escrita externa. Medir latência, segurança, rateio e ensaio autorizado separadamente |

## D1 e D2 — Papéis, remoto e local

Cada organizador autenticado organiza sua própria compra. O acesso por senha integrado em API #39 e bot #13/#14 não compartilha conta iFood, domínio ou aprovação entre usuários. Participantes não possuem contas neste recorte. Dados declarados conservam origem no organizador.

A direção de produto permite carrinho real; os contratos e a implementação determinística precisam estar integrados e validados antes de ativar. Manter F7 legada desligada: sua flag não instala confirmação humana nem durabilidade. Não alterar flags, volumes ou produção por esta revisão documental.

## Confirmação de preparação e aprovação de pedido

PREPARE_CART confirma uma composição e suas mutações, com valores conhecidos e incertezas explícitas. Não declara que o pedido cabe no orçamento completo antes de conhecer taxas relevantes. Alergia ou restrição obrigatória insuficientemente verificada bloqueia já a preparação; não há confirmação humana genérica para ignorá-la.

BUY-01 futuro deve usar outra autorização para SUBMIT_ORDER, com responsável, conta, versão/hash, itens/opções, entrega, custo completo e validade. Custo UNKNOWN, faixa ou divergência bloqueiam aprovação de pedido. Nenhuma autorização futura está habilitada por esta decisão.

## D3 — Rateio (informativo, centavos inteiros)

O rateio mostra quanto cabe a cada participante declarado pelo organizador; nada é cobrado.

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
5. Taxa ausente na resposta do MCP ⇒ componente UNKNOWN, nunca 0; o plano mostra "taxa desconhecida" e a aprovação de pedido/validação do orçamento ficam bloqueadas (D4). PREPARE_CART só autoriza preparar a composição com essa incerteza explícita, observados os bloqueios alimentares e os limites já verificáveis.
6. Desconto: e[i] = subtotal elegível de cada pessoa (só itens a que o desconto se aplica); valor aplicado = min(desconto, Σe);
   `split(valor aplicado, e)`. Vários descontos: ordem crescente de identificador, cada um limitado ao elegível restante.
   Elegibilidade desconhecida ⇒ desconto não aplicado e sinalizado. `promotionalUnitPrice` já é preço-base e não entra de novo como desconto.
7. Total por pessoa = itens + entrega + serviço − desconto.
8. Invariantes: cada componente fecha exatamente no seu total; nenhuma parte e nenhum total negativo; mesma entrada ⇒ mesma saída.
   Violação ⇒ plano INCONSISTENTE e aprovação de pedido bloqueada.
9. Preço em faixa (regra 6 do CLAUDE.md, semântica "a partir de"): rateio calculado no mínimo e no máximo; limites
   conferidos contra o máximo; aprovação de pedido bloqueada enquanto houver faixa.

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
| Taxa ausente no MCP | UNKNOWN, nunca 0; aprovação de pedido bloqueada |
| Preço em faixa | Mínimo e máximo; limites contra o máximo; aprovação de pedido bloqueada |
| Pedido abaixo do mínimo da loja | Plano não validado; mostrar quanto falta |
| Participante entra ou sai | Recálculo completo; aprovação anterior invalidada (RN06, CA12) |

## D4 — Limites

1. Valores em centavos inteiros; conversão de decimal só na borda.
2. total[i] ≤ teto[i] para cada teto individual rígido; Σ total ≤ teto coletivo rígido. As duas condições valem juntas.
3. Componente UNKNOWN ou em faixa ⇒ limite "não verificável" ⇒ aprovação de pedido bloqueada.
4. Inconsistência financeira (soma que não fecha, valor negativo, desconto acima do elegível) ⇒ aprovação de pedido bloqueada com erro explícito.
5. Teto de preferência só afeta ranking e explicação; nunca bloqueia.

## D5 — Rígido × flexível

1. Rígidos (bloqueiam): alergias, restrições alimentares obrigatórias, tetos máximos e prazo máximo declarados como limite.
2. Flexíveis (só ranking e explicação): preferências de sabor, valores aproximados ("uns R$ 50"), rapidez desejada sem limite.
3. Alergia explícita nunca vira preferência por inferência, histórico, score ou texto do modelo (RN01, RN02).
4. Marcadores de limite rígido: "no máximo", "até", "não passa de", "não posso", "sou alérgico", "sou celíaco".
5. Ambiguidade exige esclarecimento. Até a resposta: ambiguidade alimentar ⇒ item bloqueado; ambiguidade financeira
   ou de prazo ⇒ limite não verificável e aprovação de pedido bloqueada.
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

Encerrar = o organizador conclui ou cancela, ou a compra fica 24 h sem evento aceito. Confirmar preparação do carrinho não encerra a compra. Encerrar o domínio local não cancela um efeito remoto já iniciado.

| Classe | Conteúdo | Retenção | Exclusão |
| --- | --- | --- | --- |
| Dados de domínio da compra | Participantes, restrições, limites, itens, revisões e histórico curto | Até encerrar, ou 24 h sem evento aceito | Excluir na transição para encerrada ou expirada, preservando somente os registros técnicos mínimos abaixo |
| Intenção remota e deduplicação | Referência opaca, finalidade, versão/hash, estado, correlação e evidência mínima de reconciliação; sem payload bruto, endereço, alergias ou tokens | Enquanto houver PENDING/RESULT_UNKNOWN ou risco de replay/efeito tardio; definir descarte após reconciliação segundo garantias verificadas do provedor | Nunca apagar para liberar nova tentativa. Sem garantia de descarte seguro, manter bloqueio/tombstone mínimo e registrar a pendência operacional |
| Logs técnicos | Só correlação opaca, rota, nome de ferramenta, código, latência e contadores | Até 7 dias | Expurgo diário do que passou de 7 dias |
| Vínculo OAuth | Tokens e metadados do vínculo | Independente da compra | Excluir na desconexão, revogação ou expiração sem refresh possível |

- A política de intenção remota é requisito da CART-01 local; não atribui essas garantias à F7 legada em memória nem declara integração na main.
- Exclusão/cancelamento bloqueia novas escritas; não equivale a reconciliar operação em voo. Não reter todo o domínio para preservar uma trava técnica.
- Nunca em log: texto de mensagem, nomes, alergias e restrições, endereço, tokens, valores por participante.
- Backups do armazenamento (OPS-01): rotação de até 7 dias. Restaurar backup não pode reabrir intenção desconhecida para escrita.
- Refresh recusado ⇒ RECONNECT_REQUIRED e tokens apagados; falha de rede ⇒ UNAVAILABLE, tokens mantidos (CLAUDE.md).
- Relatórios de teste e medição (D10) usam só dados sintéticos ou fixtures sanitizadas.

## D8 — Preparação confirmada do carrinho real

1. Fonte única: participantes/restrições/limites/sacola da DATA-01/GRP-01; custos e rateio DOM-01. Não duplicar o domínio no bot ou na CART-01.
2. Validar vínculo operacional e permissões, listAddresses/endereço, loja, getItem/produtos/opções/quantidades, cobertura por consumidor e versão antes de escrever. IDs do provedor; nunca enviar userId nem confundir itemId/cartItemId.
3. Revisão humana explicita composição desejada, mudanças no carrinho existente, preços observados e custos desconhecidos. Vincular finalidade PREPARE_CART, organizador/bot/conversa privados, conta/link, compra, versão/hash, conteúdo e expiração.
4. Aceitar somente callback humano do adaptador autenticado, referência opaca de uso único fora do contexto do modelo. Login, senha, texto “sim” e userConsent fornecido pela IA não confirmam escrita.
5. Consumir confirmação e persistir intenção antes da rede em uma transação. Persistir reconhecimento e cartId juntos. A chamada externa fica fora da transação; não prometer atomicidade com o iFood.
6. Mesma intenção não repete efeito; chave reutilizada com conteúdo diferente conflita. Timeout/401/resultado desconhecido bloqueiam novas escritas. Só reconciliar por fonte confiável; leitura parecida não basta.
7. Revalidar antes de cada passo e conferir composição, preço, subtotal e taxas depois dele. Mudança relevante interrompe os próximos passos e exige nova revisão/confirmação. Sem revisão/ETag remota não se elimina a corrida com outro cliente.
8. Exibir resultado como “CARRINHO PREPARADO” somente com evidência correspondente; sempre distinguir “PEDIDO NÃO ENVIADO”. Não produzir sucesso apenas do texto do modelo.
9. Validar schemas/outputs reais por operação na INT-02 antes de ativar; metadados, fixtures sintéticas e flags não suprem evidência. Não executar escritas reais em testes automatizados.
10. `submitOrder`, `setCartPayment` e processamento de pagamento continuam proibidos. Entrega/cupom só podem ter mutação futura com listagem prévia e confirmação específica; não estão implementados no incremento local de itens.

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


## D10 — Metas e evidências

| Meta | Amostra/critério |
| --- | --- |
| Latência da recomendação | p95 ≤ 10 s; 40 execuções (4 contextos × 10), tempo do aceite até recomendação pronta, posição 38 em ordem crescente. Inferência isolada não é ponta a ponta |
| Alergia/orçamento | 100% dos cenários relevantes; UNKNOWN não autoriza; ausência de evidência é bloqueio correto |
| Rateio | 1 000 casos determinísticos e exemplos: soma exata, sem partes negativas, mesma entrada/saída |
| Ensaio da demo | 5 execuções consecutivas sem exceção/invariante violada; separar conversa, carrinho observado e fechamento ainda pendente |
| Efeitos externos | Zero escrita em testes automatizados; no ensaio autorizado, 100% das escritas de carrinho com confirmação específica válida; zero envio/pagamento |

Testes mockados não comprovam essas metas no provedor. Ensaio exige ambiente de teste disponibilizado e revisão humana específica. Não manipular produção para validar a demo.

## Impacto, dependências e pendências

| Task | Alcance atual |
| --- | --- |
| INT-01 #7 | Auditoria/metadados entregues; issue fechada com limites explícitos |
| [INT-02 #40](https://github.com/Modo-Escuro/api-backend/issues/40) | Outputs reais, permissões/comportamento e reconciliação pendentes; gate de ativação por operação |
| [CART-01 #18](https://github.com/Modo-Escuro/api-backend/issues/18) | Carrinho real confirmado no escopo; código auditado local, ainda não integrado/validado externamente |
| [BUY-01 #19](https://github.com/Modo-Escuro/api-backend/issues/19) / [BUY-02 #20](https://github.com/Modo-Escuro/api-backend/issues/20) | Aprovação de pedido e envio/reconciliação futuros; não habilitados nesta revisão |
| [BOT-03](https://github.com/Modo-Escuro/telegram-bot/issues/3) | Apresentação de grupo/propostas pode avançar; callback de carrinho separado da futura aprovação de pedido |
| [QA-01](https://github.com/Modo-Escuro/telegram-bot/issues/4) | Provar cada marco com evidência e registrar lacunas; definir fechamento DA10 com o evento |

Riscos remanescentes: sem outputs observados não há ativação; sem canal alimentar verificado alergias ficam bloqueadas; sem recuperação confiável de criação sem cartId ou envio sem orderId não há retry; sem versão condicional remota há corrida externa. O briefing de fechamento continua como objetivo pendente. Carrinho preparado não comprova pedido nem pagamento.
