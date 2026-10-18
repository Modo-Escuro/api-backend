# Conexão concluída no navegador

Decisão do usuário em 18/10/2026: a autorização iFood no navegador deve concluir o vínculo sem exigir outro clique no Telegram. Substitui a etapa obrigatória de confirmação Telegram do contrato anterior, apenas para login. A autorização de compra permanece independente; DEC-01 continua com carrinho simulado e MCP somente leitura.

O callback HTTP usa `completeBrowserAuthorization`: valida state, PKCE, prazo e cookie do navegador, troca o código uma vez e instala o vínculo pelo mesmo caminho transacional da confirmação anterior. Organizador e confirmationId são derivados da tentativa no servidor, nunca de parâmetros do navegador. Consulta de status continua somente leitura. Cancelamento, substituição, replay e falha de persistência não autorizam um novo vínculo indevidamente. A verificação operacional continua separada da presença de tokens.

A página informa que a conta foi conectada e orienta voltar ao Telegram. Se a verificação remota falhar, informa que o acesso ainda precisa ser verificado. O acompanhamento já existente do bot recupera o grupo quando o vínculo fica operacional. Tentativas antigas ou falha de armazenamento podem usar a confirmação manual compatível, apresentada pelo botão Minha conexão.

O link inicial é uma capacidade privada de uso único: o primeiro navegador que o abre reivindica a tentativa. Sem o segundo clique Telegram, deixa de existir a conferência adicional de identidade naquele canal. Não compartilhar o link; a conta autorizada no navegador será vinculada ao Telegram que o solicitou. Cookie e PKCE não demonstram que dois dispositivos pertencem à mesma pessoa. Essa mudança não permite aprovação de compra por OAuth, modelo ou consulta de status.

Validação: testes HTTP com OAuth/MCP sintéticos cobrem conexão sem segundo clique, vínculo persistido após reinício, isolamento entre organizadores, callback repetido, cookie ausente e acesso negado. A suíte existente cobre rollback de armazenamento e concorrência da instalação. Testes não consomem conta real nem modelo pago. Ensaio visual online do novo retorno ainda depende do usuário.
