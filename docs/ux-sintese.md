# Síntese, resposta curta e carrinho simulado

Pedido de 18/10/2026: evitar repetir o grupo inteiro, aproveitar respostas como “Não”, reduzir o menu do bot e oferecer botão para esvaziar o carrinho. As imagens mostram estados repetidos com notas diferentes; não comprovam duplicação do transporte nem a versão online.

O contexto enviado ao modelo passa a incluir também as perguntas rotineiras pendentes, anteriormente ausentes. Uma resposta exata “Não”, “Nao” ou “nenhuma” pode responder à primeira pergunta de restrições mostrada pelo bot, sem nova inferência. Exige compra ativa, fase COLLECTING, pergunta atual idêntica às pendências calculadas pelo servidor, identidade presente no GROUP e participante em NOT_ASKED. Notas de endereço/recusa, esclarecimento aberto, snapshot divergente, contexto ausente ou restrição já declarada impedem essa interpretação. Não há remoção de alergia, liberação de UNKNOWN do catálogo ou confirmação humana fabricada. Uma resposta ambígua continua no caminho normal de esclarecimento.

O comando exato “Esvaziar carrinho simulado”, emitido pelo botão do bot, aplica somente CLEAR_BAG no domínio local. Não chama o modelo nem qualquer mutação MCP; preserva pessoas, restrições, orçamento e endereço. Carrinho vazio recebe mensagem específica. Não é autorização PREPARE_CART, SUBMIT_ORDER ou cancelamento de pedido iFood.

Foto é opcional: a primeira proposta com cobertura de todos pode carregar um link para a imagem observada no getItem do item escolhido. Somente HTTPS no host CDN observado nas fixtures, sem credencial, query, fragmento ou porta alternativa. Imagem ausente, URL inválida ou candidato bloqueado mantêm resposta textual. O Telegram pode apresentar a prévia do link; não foi criado envio separado de mídia, download local ou novo contrato de foto. Não há garantia de renderização online.

Regressões sintéticas cobrem Bruna/Bia, R$100, respostas curtas, contexto ausente/divergente, alergia preservada, comando exato de esvaziar, carrinho preenchida e reinício sem escrita remota. A implementação do bot reduz a apresentação; o snapshot completo, seus schemas e pins históricos permanecem.

Sem deploy, merge na main, alteração de flags ou ensaio externo. A correção de código não comprova correção da instância das imagens.
