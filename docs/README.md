# Documentação da API

Esta branch reúne a implementação CART-01 do PR #46 sobre a main que já integrou #43/#44/#45. CART-01 continua separada da main; merge documental não comprova deploy ou validação do iFood.

[Estado remoto/local](estado-remoto-local.md): SHAs conferidos, merges e código CART-01 publicado no PR #46, ainda separado da main. A DEC-01 permite preparação real confirmada; documentação não habilita a operação.

[Acesso por senha no bot](acesso-bot-senha.md): opt-in para usuários admitidos pelo adaptador autenticado,
com vínculos isolados e sem ampliar a fronteira de compra da DEC-01.

1. [Plano e tasks](plano-conversacional.md): estado das branches, prioridades, gates e responsabilidades.
2. [Contrato do bot](bot-api.md): login existente e avaliação; [conversa v1](conversation-api-v1.md) e [runtime RUN-01](runtime-turnos.md) opt-in; [montagem AI-01 e ensaio](ai-01-montagem-ensaio.md) com candidato de provedor desabilitado por padrão.
3. [Revisão da branchBruna](reviews/branchBruna-8393615.md): achados e reproduções sobre o commit 8393615.
4. [Requisitos do incremento anterior](requirements.md): histórico do recorte de recomendação, com ressalvas de escopo atual.
5. [Auditoria de preço](pricing-audit.md): evidência e ambiguidades observadas no catálogo.
6. [Persistência dos vínculos (OPS-01)](ops-01-persistencia.md): volume, migração, backup, restauração e limitações.
7. [Auditoria INT-01](int-01-audit.md): matriz de contratos F7, bloqueio de resultados desconhecidos e limites da DEC-01; [inventário offline](int-01-tools-audit.json) e [consulta manual de metadados](int-01-console-command.sh), sem chamadas de negócio.
8. [DOM-01 — Centavos, limites e rateio](dom-01-centavos-limites.md): fronteira BRL do MCP, cálculo inteiro, limites locais e distinção entre subtotal e total desconhecido.
9. [Compra e participantes (DATA-01)](data-01-compra.md): modelo, operações, proveniência, exclusão D7 e guia para o processador.
10. [Agente conversacional (AI-02)](ai-02-agente.md): vocabulário fechado de ações, política do servidor, falhas e integração com AI-01.
11. [Propostas e composição para carrinho real (GRP-01)](grp-01-propostas.md): matriz por pessoa, custos DOM-01, tetos, corte em 4 e composição local a sincronizar pela CART-01.
12. [Montagem AI-01 e ensaio BOT-02](ai-01-montagem-ensaio.md): Gemini 3.8 Flash (seleção do #35), configuração explícita, limites, avaliações e pendências operacionais.

13. [Operação (OPS-02)](ops-02-operacao.md): logs sanitizados, métricas, orçamento do modelo, status operacional, rollout/rollback e ensaios pendentes.
14. [Carrinho com confirmação humana (CART-01)](cart-01-escrita-confirmada.md): revisão PREPARE_CART, intenção durável, bloqueio de resultado desconhecido e [integração/auditoria](cart-01-integracao.md). Desligado até INT-02 e callback BOT-03 validados.

O [plano revisado do telegram-bot](https://github.com/Modo-Escuro/telegram-bot/blob/main/docs/plano-conversacional.md) já foi integrado pelo #16. O incremento de callback CART-01 é código separado, ainda desligado. A [StRS preservada](https://github.com/Modo-Escuro/telegram-bot/blob/main/docs/baseline/stakeholder-requirements-specification.md) continua em validação.

F7 foi incorporada pelo [PR #4](https://github.com/Modo-Escuro/api-backend/pull/4) e seu caminho legado não pode escrever. A CART-01 acrescenta preparação de itens após confirmação humana específica conforme a [DEC-01 vigente](decisoes-conversacionais.md). Outputs provisórios e testes sintéticos não comprovam iFood; a validação externa está na [INT-02 #40](https://github.com/Modo-Escuro/api-backend/issues/40). PREPARE_CART não aprova compra nem habilita pagamento/envio.

A infraestrutura RUN-01 mantém os schemas da API-01; a montagem do modelo tem opt-in separado na AI-01.
[Validação histórica de API-01](api-01-validation.md) e testes SQLite são evidências offline; não comprovam operação implantada.
A DATA-01 já integra domínio e exclusão D7 ao runtime. Volume, recuperação e o ensaio operacional continuam exigindo verificação.
