# Conversa guiada — incremento local de 18/10/2026

Base: continuação dos PRs API #49 e bot #20 já integrados. Esta alteração está na branch local `codex/conversation-guidance`; não comprova deploy nem comportamento no Telegram em execução.

## Implementado

- Guarda a intenção de busca enquanto coleta participantes, restrições, orçamento e prioridade. Quando a coleta fica completa, retoma a busca sem exigir que a pessoa repita o alimento.
- Oferece referências de escolha apenas para propostas exibidas. O bot apresenta Escolher opção N, Mudar busca, Ver outras, Não tenho restrições e, com CART-01 habilitada e sacola atual, Revisar carrinho.
- Interpreta respostas exatas como “a segunda”, “mais barato” e “troca por pizza” usando o estado atual. “Essa” com várias opções pede esclarecimento; “somos só dois” pede os nomes de quem permanece, sem remover pessoas por adivinhação.
- Mostra quantidade, preço unitário observado, destinatários, entrega conhecida/desconhecida e cobertura das restrições. A soma observada não comprova total final ou teto do pedido.
- Esvaziar sacola preserva participantes, restrições e orçamento. Limpa a composição local e a busca associada; não altera o carrinho remoto.

O modelo continua propondo ações estruturadas; a API valida e monta a apresentação. Isso amplia a continuidade, mas não equivale a diálogo livre irrestrito. “Ver outras” consulta novamente e informa que opções podem se repetir.

## Contrato e armazenamento

`allowedActions` reutiliza o contrato v1, sem alterar schemas/fixtures históricas. Referências vinculam compra, vínculo atual, conversa e versão; expiram em cinco minutos. Aceite e processamento validam ação/versão, e o processamento revalida o vínculo. Replay conserva a identidade do callback. Navegação não emite aprovação humana nem autoriza escrita externa.

A compra ganha `searchQuery` opcional. O SQLite da API migra transacionalmente para **v5**, inclusive com o carrinho real desligado. A marca impede binários anteriores, cujo parser não aceita esse campo, de abrir o banco. Fazer backup consistente do diretório de estado, com os serviços parados e WAL/SHM preservados conforme o procedimento operacional. Rollback deve desligar funcionalidades usando binário compatível; não rebaixar `user_version` nem restaurar backup antigo sobre intenção de resultado desconhecido. No bot, desligar `TELEGRAM_CART_ENABLED` junto de `TELEGRAM_CONVERSATION_ENABLED` ao desabilitar a conversa.

## Grupos por conta iFood (opt-in)

Implementado com `CONVERSATION_ACCOUNT_GROUPS_ENABLED=false` por padrão. Habilitar somente depois de validar UserInfo com a integração iFood real. O discovery anuncia UserInfo e sujeito público; a aceitação do token e a estabilidade entre logins ainda não foram comprovadas em produção. Nome, e-mail e `linkId` não são usados para identificar a mesma conta.

A chave interna deriva de issuer, client e sub autenticado. Não entra no modelo nem no Telegram. Falha de identidade bloqueia a operação; grupos legados não são atribuídos automaticamente a uma conta. O cadastro separado guarda participantes, restrições, orçamento e prioridade; não guarda endereço, itens, propostas ou aprovação. Rotas autenticadas GET/POST/DELETE `/api/bot/v1/conversations/:id/group` usam versão própria; mutações exigem `source=TELEGRAM_CALLBACK` e `X-Conversation-Session` atual, obtido em `/account-context`. São rotas do adaptador, não ferramentas do modelo.

Mensagens recebem a referência da sessão ao entrar na fila. Trocar A por B ou relogar A invalida mensagens antigas; o lock de vínculo mantém a sessão durante o commit. A → B → A recupera somente o cadastro correspondente, inclusive após reinício. Esvaziar carrinho preserva o grupo. Limpar perfil explicitamente apaga também o cadastro da conta; encerrar/expirar a compra normalmente preserva esse cadastro independente. Para excluir o cadastro sem reutilizar a compra, usar DELETE `/group` com versão e sessão atuais.

O schema agora é **v5**, com tabelas de grupos e associação de operações à sessão. Rollback deve conservar binário compatível; não rebaixar o schema. Desativar o opt-in não executa mensagens antigas vinculadas a uma sessão. Publicar a API antes do bot e habilitar a flag somente após ensaio autenticado.

## Correção do ciclo de restrições e navegação

“Não”, “não tenho” e “não tenho restrições” respondem à primeira pergunta canônica de restrições desconhecidas, inclusive quando uma recusa anterior deixou a confirmação pendente. Não removem alergias/dietas declaradas nem resolvem outras ambiguidades. O servidor oferece “Não tenho restrições” como ação com versão, prazo e vínculo. A suíte reproduz o estado da imagem, reinício e clique, sem nova chamada ao modelo.

No bot, botões contextuais ficam na mensagem. O teclado persistente contém apenas Menu; abrir Menu não reinicia a pergunta individual/grupo. Entrar no iFood, Cancelar login e Sair da conta iFood usam o estado atual; logout e cancelamento transportam a referência de origem ao backend. Limpar/remover perfil conservam os controles dos PRs #53/#23, com versão e sessão da confirmação, validade de cinco minutos e sem atualizar silenciosamente uma confirmação antiga.

## Validação e limites

Testes offline cobrem a fila, callbacks, reinício, isolamento A/B, CRUD de grupo e lock de logout. Testes HTTP bot/API usam OAuth, MCP e modelo sintéticos. Resultados finais estão no PR deste incremento; testes não comprovam deploy ou validação do UserInfo real.

Esta entrega não resolve toda ambiguidade de compra individual com grupo preexistente, nem garante correspondência semântica entre o alimento pedido e cada resultado do catálogo. Não afirmar que todo o fluxo das imagens está corrigido.
