# Documentação da API

[Retirada local do legado (20/10)](retirada-legado.md): montagem única do assistente, remoção de F7/painel/sessão global, migração de configuração e alcance das verificações. Documentos AI-02/F7 e relatórios de ensaio anteriores continuam como registros históricos.

[Assistente conversacional implementado localmente](assistente-conversacional.md): intenção → audiência sem fatos → memória seletiva → IA/consultas → cartões e propostas persistidas → escolha digitada da sacola. Envio/pagamento não implementados.

A memória seletiva distingue titular/destinatários e recupera fatos por finalidade. O [SQLite reconciliado é v6](armazenamento-v6.md), unificando as duas variantes v5 sem inventar identidade estável entre relogins. [Reconciliação para GitHub](sincronizacao-github.md).

[Conclusão offline da integração CART-01](cart-01-conclusao-offline.md): ordem de integração, contrato humano completo, ensaio HTTP do bot, avanço da OPS-02 e gates externos remanescentes.

[Continuidade e endereço iFood](continuidade-enderecos.md): correção da entrega automática no bot, confirmação humana de endereço e sequência coordenada de deploy, ainda sem ativação operacional.

Base reconciliada: origin/main@f6ef20e, consultada no GitHub em 20/10. Commit funcional `853adf2` em branch/worktree separado; publicação de dois PRs draft autorizada, sem autorização de merge/deploy. #46 já mergeado e capturas INT-02/parsers preservados; quadros de 18/10 continuam históricos.

Fonte corrente de versão/evidência: [reconciliação GitHub](sincronizacao-github.md). Referências ao guia v5 em páginas históricas descrevem a variante anterior, não a numeração corrente v6.

[Estado remoto/local](estado-remoto-local.md): separa árvore local, retratos remotos datados e operação online não reconfirmada. A DEC-01 permite preparação confirmada; documentação não habilita operação.

[Acesso por senha no bot](acesso-bot-senha.md): opt-in para usuários admitidos pelo adaptador autenticado,
com vínculos isolados e sem ampliar a fronteira de compra da DEC-01.

1. [Plano e tasks](plano-conversacional.md): estado das branches, prioridades, gates e responsabilidades.
2. [Contrato do bot](bot-api.md), [conversa v1](conversation-api-v1.md), [RUN-01](runtime-turnos.md) e [armazenamento v6](armazenamento-v6.md): login, conta/memória/progresso/endereço e limites de compatibilidade.
3. [Revisão da branchBruna](reviews/branchBruna-8393615.md): achados e reproduções sobre o commit 8393615.
4. [Requisitos do incremento anterior](requirements.md): histórico do recorte de recomendação, com ressalvas de escopo atual.
5. [Auditoria de preço](pricing-audit.md): evidência e ambiguidades observadas no catálogo.
6. [Persistência dos vínculos (OPS-01)](ops-01-persistencia.md): volume, migração, backup, restauração e limitações.
7. [Auditoria INT-01](int-01-audit.md): matriz de contratos F7, bloqueio de resultados desconhecidos e limites da DEC-01; [inventário offline](int-01-tools-audit.json) e [consulta manual de metadados](int-01-console-command.sh), sem chamadas de negócio.
8. [DOM-01 — Centavos, limites e rateio](dom-01-centavos-limites.md): fronteira BRL do MCP, cálculo inteiro, limites locais e distinção entre subtotal e total desconhecido.
9. [Compra e participantes (DATA-01)](data-01-compra.md): modelo, operações, proveniência, exclusão D7 e guia para o processador.
10. [Agente conversacional (AI-02), histórico](ai-02-agente.md): vocabulário fechado retirado; implementação atual em [assistente](assistente-conversacional.md).
11. [Propostas e composição para carrinho real (GRP-01)](grp-01-propostas.md): matriz por pessoa, custos DOM-01, tetos, corte em 4 e composição local a sincronizar pela CART-01.
12. [Montagem AI-01 e ensaios](ai-01-montagem-ensaio.md): aponta a montagem atual e conserva ensaios antigos; configuração corrente em [assistente](assistente-conversacional.md#configuração) e `.env.example`.

13. [Operação (OPS-02)](ops-02-operacao.md): logs sanitizados, métricas, orçamento do modelo, status operacional, rollout/rollback e ensaios pendentes.
14. [Carrinho com confirmação humana (CART-01)](cart-01-escrita-confirmada.md): revisão PREPARE_CART, intenção durável, bloqueio de resultado desconhecido e [integração/auditoria](cart-01-integracao.md). Desligado até INT-02 e callback BOT-03 validados.

O consumidor local coordenado está em `telegram-bot/docs/assistente-conversacional.md`, com menu de memória e referências de sessão. Histórico remoto: [plano do bot](https://github.com/Modo-Escuro/telegram-bot/blob/main/docs/plano-conversacional.md). A [StRS preservada](https://github.com/Modo-Escuro/telegram-bot/blob/main/docs/baseline/stakeholder-requirements-specification.md) não é regravada para atualizar implementação; callback CART-01 mantém opt-in separado.

F7 foi incorporada pelo [PR #4](https://github.com/Modo-Escuro/api-backend/pull/4) e foi retirada da árvore local. A CART-01 acrescenta preparação de itens após confirmação humana específica conforme a [DEC-01 vigente](decisoes-conversacionais.md). Outputs provisórios e testes sintéticos não comprovam iFood; a validação externa está na [INT-02 #40](https://github.com/Modo-Escuro/api-backend/issues/40). PREPARE_CART não aprova compra nem habilita pagamento/envio.

A infraestrutura RUN-01 mantém os schemas da API-01; a montagem do modelo tem opt-in separado na AI-01.
[Validação histórica de API-01](api-01-validation.md) e testes SQLite são evidências offline; não comprovam operação implantada.
A DATA-01 já integra domínio e exclusão D7 ao runtime. Volume, recuperação e o ensaio operacional continuam exigindo verificação.

## Registros históricos e fontes preservadas

- AI-01: [pré-seleção](ai-01-model-options.md), [comparação](ai-01-evaluation.md), [resultado](ai-01-result.md), [revisão de texto](ai-01-text-review.md) e evidências em `docs/evidence/`. Scripts removidos citados nesses ensaios não são comandos atuais.
- [AI-02](ai-02-agente.md), [F7](f7-cart-checkout.md), [validação F7](f7-validation.md), [API-01](api-01-validation.md) e [revisão de branch](reviews/branchBruna-8393615.md) descrevem versões identificadas, não capacidades implantadas hoje.
- [Auditoria CART-01](cart-01-auditoria.md), [integração](cart-01-integracao.md), [conclusão offline](cart-01-conclusao-offline.md) e [INT-02](int-02-progresso.md) preservam SHAs/hashes/resultados da origem; guia corrente em [escrita confirmada](cart-01-escrita-confirmada.md).
- `documenta_o_oficial_ifood_mcp.md` é material externo versionado, não contrato de execução do aplicativo. Fixtures/schemas/pins, baseline e amostras históricas mantêm sua proveniência; descrição de ferramenta não autoriza chamada nem prova output.
