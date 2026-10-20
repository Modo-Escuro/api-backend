# Reconciliação para GitHub — 20/10/2026

## Bases e preservação

GitHub consultado nesta etapa: API main `f6ef20e`, bot main `43105ba`; API #46 já mergeado. PR documental #50 continua separado e precisa conciliar README/índice/entregáveis com seu autor. Esses fatos identificam código remoto, não deploy/configuração/volume.

As branches de integração estão em worktrees isolados, baseados nessas mains; checkouts e índices originais foram preservados. `opencode.json`, `tash` e configurações pessoais não são transportados. A preparação foi local; em seguida o usuário autorizou criar commits, publicar branches e abrir dois PRs draft. Não autoriza merge, deploy ou operação iFood.

O commit funcional da API é `853adf20805185b3fd6f0b8ef0a2cf1b406eb7d3`; o commit documental seguinte consolida estes guias. A integração do bot será fixada no SHA publicado dessa API, preservando os pins históricos. O andamento de PRs/CI fica no GitHub e não é atualização automática deste relatório.

## Decisões da reconciliação

- Usuário confirmou manter a regra desta conversa: **UNKNOWN obrigatório bloqueia por pessoa; preferência não vira obrigação**. Isso substitui explicitamente a liberação com aviso do PR #52. Conflito de alérgeno na descrição continua bloqueado; filtro dietético não comprova alergia.
- Migração [v6](armazenamento-v6.md) unifica as variantes v5 sem apagar dados/intenções. Não associar retroativamente eventos nem importar grupos antigos como perfil SELF.
- Parsers, tratamento de endereço/benefícios e capturas INT-02 da main foram preservados. O manifesto declara origem OBSERVED_AUTHENTICATED; isso não dispensa conferir hashes, escopo e adequação de cada operação. Preparação/desconhecido/pagamento/envio têm limites próprios.
- A correção #57 (teto individual nunca perguntado não bloqueia revisão; ambíguo continua bloqueando) é preservada.
- #56 foi adaptada ao assistente: pergunta canônica persiste o valor; resposta máximo/referência resolve o teto sem nova inferência, inclusive após reinício. Não resolve pergunta de outra pessoa ou texto não canônico.
- Exploração progressiva #49 e diagnósticos puros permanecem em `services/group-search.ts`/`services/group.ts`, sem o wrapper antigo linkedProposalProvider. O assistente continua com seu executor/ciclo limitado; a existência desses helpers não promete que todas as estratégias antigas sejam executadas a cada pedido natural.
- Propostas do assistente carregam o endereço realmente observado/autorizado para alimentar a revisão. Restrição nova de consumidor já existente invalida a sacola mesmo sem nova busca; gravar memória continua sem criar participante genérico.
- Busca nova sem composição invalida os números antigos. A composição não inclui silenciosamente pessoas de contexto anterior ausentes dos perfis selecionados para o pedido atual.

## Verificação/publicação

Verificação local: API com typecheck/lint/build aprovados e **995 testes aprovados, 2 ignorados, 60 arquivos**; bot com **290 testes executados, 17 ignorados (273 aprovados)** e Ruff check aprovado, com ASSISTANT_API_ROOT para esta API. Novo caso HTTP executado e repetido após os últimos ajustes, não skip. CI remota/Docker não executados nesta preparação.

Novo teste HTTP do bot (`test_assistant_integration.py`, `ASSISTANT_API_ROOT`) usa assistente/SQLite/rotas CART-01 reais e todas as integrações externas sintéticas. Percorre contexto, endereço, memória, proposta numerada, escolha sem IA, revisão PREPARE_CART sem escrita e invalidação após declaração de alergia. Gate injetado é exclusivamente sintético, não evidência real. Pins históricos de CI são preservados.

Antes de publicar: executar checks da base reconciliada e revisar o diff contra main. Publicar API em draft, obter seu SHA e acrescentar/pinar o novo job de integração do bot nesse SHA; então publicar bot em draft dependente. API antes do bot no merge; implantação exige decisão/ensaio separados. Resultados históricos de 953 testes não substituem a nova suíte. A revisão documental do PR #50 deve preservar os entregáveis do autor.
