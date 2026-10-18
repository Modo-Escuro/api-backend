# CART-01 — Entrega local e auditoria

**Registro histórico da implementação original.** A continuação sobre a main com Gemini/OPS-02, os novos checks e o estado de publicação estão em [integração CART-01](cart-01-integracao.md). Os SHAs e resultados abaixo não são evidência da integração posterior.

Data: 18/10/2026. Base: `api-backend@8191a0f427ac07a361d389a0b03f530ad8eaec83`. Branch local isolada: `codex/cart-01-confirmed-writes`. Sem commit, push, merge, PR ou deploy. AI-01/OPS-02 não foram modificadas. O usuário confirmou que ainda não existe branch CART-01 de Maylon; seu trabalho não publicado foi preservado.

## Entrega e rastreabilidade

- [Incoerências identificadas](incoerencias-escopo-cart01.md) e [fluxo/contrato BUY-01](cart-01-escrita-confirmada.md) documentados; D8/D10 revisadas para permitir somente escrita de itens confirmada pelo organizador.
- [INT-02 #40](https://github.com/Modo-Escuro/api-backend/issues/40) criada para outputs reais/reconciliação pendentes. [CART-01 #18](https://github.com/Modo-Escuro/api-backend/issues/18) atualizada e aberta. INT-01 #7 e BUY-01 #19/BUY-02 #20 ganharam notas de escopo e dependências.
- DATA-01/GRP-01 permanecem fonte única de pessoas, restrições e sacola; DOM-01 calcula custos. CART-01 registra apenas confirmação, intenção, plano técnico e projeção do carrinho remoto.
- Referência humana de uso único vinculada à finalidade PREPARE_CART, identidade, vínculo, compra, versão/hash, composição, catálogo, estado remoto e expiração. Nenhuma referência foi acrescentada ao vocabulário/modelContext da IA.
- Criação, inclusão, atualização e remoção de itens com consulta/reconciliação conservadora. Confirmação/intenção e reconhecimento/cartId são atômicos no SQLite; a rede fica fora da transação.
- Gateway e rotas legados não podem escrever na sessão real. Pagamento e envio continuam proibidos. Alteração de entrega/cupom e interface de callback Telegram não foram implementadas neste incremento.
- Gate de evidência confere hashes dos parsers/amostras/schemas e valida os argumentos pelo JSON Schema anunciado. Sem evidência de saídas observadas, não emite confirmação operacional nem escreve.

## Auditoria independente e correções

Subagente de auditoria inspecionou fontes/diff e executou reproduções sem editar arquivos, usar credenciais ou chamar MCP.

| Achado reproduzido | Correção e regressão |
| --- | --- |
| P1: outro produto de mesmo preço recebia rateio antigo | Exigir composição canônica, opções, quantidade, notas, atualidade/assinaturas e preços unitários remotos antes do rateio |
| P2: consulta com feature desligada gerava 500 | Validar identidade/disponibilidade antes do acesso ao serviço; teste exige 503 |
| P1: crash após reconhecer criação, antes de salvar associação, podia permitir outra criação | Salvar reconhecimento/cartId/head em uma transação; testes de reinício e fault injection de rollback |
| P1: preço/subtotal divergente no primeiro passo não parava os próximos | Conferir composição, preço unitário, subtotal, total, taxas e descontos após cada passo; interromper antes do seguinte |
| Consulta após expiração dificultava reconciliação | Permitir leitura técnica de head conhecido sem renovar confirmação nem validar orçamento; expurgo preserva desconhecidos |

Reauditoria: **GO técnico para preparar PR com funcionalidade desligada**, sem novos bloqueadores encontrados no recorte auditado. Auditor executou **34/34 testes específicos** e `git diff --check`. Dois testes finais adicionais cobrem rollback da confirmação/intenção e bloqueio de commit concorrente do domínio. Turno sem efeito bloqueado pela CART retorna FAILED/UNAVAILABLE, sem inventar resultado externo desconhecido para uma leitura.

## Verificações finais realmente executadas

Windows, Node 24.13.0. Lockfile instalado com `npm ci --ignore-scripts --no-audit --no-fund`. A instalação inicial no sandbox ficou incompleta; foi preservada temporariamente e substituída por instalação íntegra em diretório temporário, vinculada à cópia local. Dependências/lockfile não foram alterados.

| Check | Resultado final |
| --- | --- |
| `npm test` | 46 arquivos aprovados; **799 testes aprovados, 2 omitidos no Windows, 801 no total**, incluindo 36 CART-01 |
| `npm run typecheck` | Passou |
| `npm run lint` | Passou |
| `npm run build` | Passou |
| `git diff --check` | Passou |

Os checks finais foram executados após as correções. Falhas intermediárias não foram contadas como sucesso. SQLite é real; gateways, pessoas, OAuth e respostas são sintéticos. Não houve modelo pago, polling, credenciais pessoais ou chamada de negócio real. A suíte do protótipo Python não foi executada, pois seus fontes não mudaram.

## GO/NO-GO e limitações

**GO técnico para preparar PR**, sujeito à revisão humana do diff e coordenação com Maylon. Código não publicado; patch local disponível para transportar a alteração sem sobrescrever trabalho concorrente.

**NO-GO para ativação real/produção.** O usuário confirmou ausência de capturas reais e de ambiente autenticado disponibilizado. Faltam INT-02, outputs realmente observados, ensaio remoto e integração do callback humano BOT-03. Testes mockados não comprovam iFood. Navegador não foi automatizado.

**Envio de pedido e pagamento proibidos.** PREPARE_CART não vale para BUY-01/BUY-02. O briefing de fechamento permanece pendente mesmo com um carrinho preparado.

Sem mecanismo demonstrado para reconciliar criação sem cartId ou escrita desconhecida, manter bloqueio. Leitura semelhante não autoriza retry. Sem versão condicional remota, releitura não elimina corrida externa. SQLite não garante execução única no provedor. Head associado a outra compra não é descartado para criar outro carrinho; requer reconciliação operacional. Evidência alimentar insuficiente permanece bloqueada. Estes limites não podem ser contornados por flags.
