# Conversa guiada — incremento local de 18/10/2026

Base: continuação dos PRs API #49 e bot #20 já integrados. Esta alteração está na branch local `codex/conversation-guidance`; não comprova deploy nem comportamento no Telegram em execução.

## Implementado

- Guarda a intenção de busca enquanto coleta participantes, restrições, orçamento e prioridade. Quando a coleta fica completa, retoma a busca sem exigir que a pessoa repita o alimento.
- Oferece referências de escolha apenas para propostas exibidas. O bot apresenta Escolher opção N, Mudar busca, Ver outras e, com CART-01 habilitada e sacola atual, Revisar carrinho.
- Interpreta respostas exatas como “a segunda”, “mais barato” e “troca por pizza” usando o estado atual. “Essa” com várias opções pede esclarecimento; “somos só dois” pede os nomes de quem permanece, sem remover pessoas por adivinhação.
- Mostra quantidade, preço unitário observado, destinatários, entrega conhecida/desconhecida e cobertura das restrições. A soma observada não comprova total final ou teto do pedido.
- Esvaziar sacola preserva participantes, restrições e orçamento. Limpa a composição local e a busca associada; não altera o carrinho remoto.

O modelo continua propondo ações estruturadas; a API valida e monta a apresentação. Isso amplia a continuidade, mas não equivale a diálogo livre irrestrito. “Ver outras” consulta novamente e informa que opções podem se repetir.

## Contrato e armazenamento

`allowedActions` reutiliza o contrato v1, sem alterar schemas/fixtures históricas. Referências vinculam compra, vínculo atual, conversa e versão; expiram em cinco minutos. Aceite e processamento validam ação/versão, e o processamento revalida o vínculo. Replay conserva a identidade do callback. Navegação não emite aprovação humana nem autoriza escrita externa.

A compra ganha `searchQuery` opcional. O SQLite da API migra transacionalmente para **v4**, inclusive com o carrinho real desligado. A marca impede binários anteriores, cujo parser não aceita esse campo, de abrir o banco. Fazer backup consistente do diretório de estado, com os serviços parados e WAL/SHM preservados conforme o procedimento operacional. Rollback deve desligar funcionalidades usando binário compatível; não rebaixar `user_version` nem restaurar backup antigo sobre intenção de resultado desconhecido. No bot, desligar `TELEGRAM_CART_ENABLED` junto de `TELEGRAM_CONVERSATION_ENABLED` ao desabilitar a conversa.

## Próxima entrega: grupos por conta iFood

Solicitação confirmada: cadastro de grupos separado da compra; uma pessoa no Telegram pode alternar entre contas iFood. A identidade necessária ainda não foi validada.

A documentação MCP fornecida pelo usuário (página 1, “Identidade Oculta”) diz que `userId` é injetado pelo gateway e não é recebido/manipulado pelo agente; `getUser` descreve nome, e-mail, telefone e dados comportamentais. Esses campos e suas versões mascaradas não são chave estável. `linkId` também não serve: muda a cada vínculo.

Em 18/10 foi consultado o discovery público `https://id.ifood.com.br/.well-known/openid-configuration`: anuncia issuer `https://id.ifood.com.br/3p`, `userinfo_endpoint=https://id.ifood.com.br/userinfo` e `subject_types_supported=["public"]`. Isso é candidato para investigação no backend; não comprova que o token desta integração permita a consulta, que a resposta tenha `sub` válido, nem estabilidade observada entre logins. Nenhum token/endpoint privado foi consultado neste incremento.

Sequência pendente:

1. Confirmar com o contrato de autenticação e ensaio autorizado a identidade estável; manter identificação interna fora do modelo e do Telegram. Falha/ausência de identidade não pode juntar contas por nome/e-mail.
2. Criar cadastro de grupos independente de compra, por organizador autorizado e identidade da conta. Não atribuir automaticamente o grupo legado a uma conta desconhecida.
3. Fixar contexto de conta e geração de sessão no recebimento de mensagens/callbacks. Ao trocar de conta, isolar eventos ainda não enviados e revalidar eventos aceitos/em processamento; nunca reaplicar A em B.
4. Testar A → B → A, dois logins da mesma conta, reinício, troca durante processamento, fila antiga, reconexão e operação externa com resultado desconhecido. Esvaziar sacola deve preservar o cadastro do grupo.

Rótulos recomendados: Entrar no iFood, Sair da conta iFood e Cancelar login durante a tentativa. Sair da demo permanece separado. Logout deve usar a referência atual do vínculo, sem apagar grupos ou transferir mensagens pendentes. Esses rótulos e a separação por conta ainda não foram implementados neste incremento.

## Validação

Suíte API: 1.091 testes aprovados e 2 ignorados; inclui reinício, replay, expiração, versão, mudança de vínculo, intenção preservada e restrições. Typecheck, lint e build aprovados. Bot: 257 testes aprovados, incluindo mensagem/origem do callback, fila sem rebase, apresentação em partes e revisão sem preparação externa. Ensaio HTTP local `test_guidance_integration.py` usa esta API com OAuth/MCP/modelo sintéticos, sem polling real.
