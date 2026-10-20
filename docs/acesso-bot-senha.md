# Usuários admitidos por senha no bot

Em 18/10/2026 o usuário solicitou acesso compartilhado à demo com senha, ampliando o recorte anterior de um
organizador. A senha fica no ambiente secreto do bot, não nesta API. Cada pessoa tem seu próprio organizador,
vínculo, conversa, restrições e orçamento. A DEC-01 permite preparar carrinho real após confirmação específica; senha não é confirmação. Envio/pagamento continuam proibidos. CART-01 está na árvore local opt-in e exige evidência INT-02/canal humano validado, sem inferir ativação remota.

O consumo iFood exige conta de teste autorizada e OAuth iniciado pelo bot. A autorização no navegador conclui o vínculo; confirmação Telegram adicional é só compatibilidade/recuperação. A senha compartilhada não substitui essas credenciais. O modelo usa credencial própria, só na API. Memória é separada por vínculo/pessoa/finalidade; fila conserva a sessão capturada quando usa `X-Conversation-Session`, sem alegar identidade estável entre relogins.

`BOT_PASSWORD_ACCESS_ENABLED=false` por padrão conserva a allowlist. Quando `true`, o middleware permite um
ID Telegram novo somente com token de serviço válido **e** `X-Telegram-Access: PASSWORD`, marcador reservado
ao adaptador que verificou a sessão. Não há autenticação anônima, wildcard público nem senha em corpo/query.
Somente posse da senha de usuário não permite chamar a API: ela não substitui `BOT_API_TOKEN`.

O bot extrai o ID de updates Telegram privados validados, jamais de texto/modelo; o token prova essa fronteira
de confiança. A API continua usando `organizerOf` para pertencer a recursos e rejeitar acesso a outra conversa.
Os vínculos de IDs fora da lista passam a ser recarregados do disco neste modo; desligá-lo preserva os arquivos,
mas volta a carregar somente a lista. Nenhuma migração destrutiva ou importação da sessão global é feita.

Essa flag não habilita modelo, rotas RUN-01 nem carrinho. A montagem/provedor pertencem à AI-01 da equipe;
limites de gasto e eventual rollout da OPS-02 devem ser conciliados antes de ampliar o uso. Não passa senha,
marcador ou token ao modelo. Autorização da demo e login não aprovam compra.

A implantação citada no incremento de origem é histórica. Conferir serviço/ambiente/volumes antes de alteração autorizada. Preservar vínculos, banco API v6 e estado do bot, sem confundir seus schemas. Testes falsos não comprovam ensaio humano/modelo online.
