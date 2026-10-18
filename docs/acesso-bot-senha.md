# Usuários admitidos por senha no bot

Em 18/10/2026 o usuário solicitou acesso compartilhado à demo com senha, ampliando o recorte anterior de um
organizador. A senha fica no ambiente secreto do bot, não nesta API. Cada pessoa tem seu próprio organizador,
vínculo, conversa, restrições e orçamento. DEC-01 permanece: sacola simulada, MCP somente leitura, sem envio real.

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

Implantação coordenada com a mudança `codex/acesso-senha` do telegram-bot no projeto Railway informado pelo
usuário: `d2af9e6b-0bda-4725-bcc8-9092dc2b5a2e` / `production`. Preservar `/data/ifood-links`, banco RUN-01 e
volume do bot. Testes usam OAuth/MCP falsos, duas contas e reinício; ensaio humano/modelo são evidências separadas.
