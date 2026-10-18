# Documentação da API

1. [Plano e tasks](plano-conversacional.md): estado das branches, prioridades, gates e responsabilidades.
2. [Contrato do bot](bot-api.md): login existente e avaliação; [conversa v1](conversation-api-v1.md) e [runtime RUN-01](runtime-turnos.md) opt-in, ainda sem processador DATA/IA instalado.
3. [Revisão da branchBruna](reviews/branchBruna-8393615.md): achados e reproduções sobre o commit 8393615.
4. [Requisitos do incremento anterior](requirements.md): histórico do recorte de recomendação, com ressalvas de escopo atual.
5. [Auditoria de preço](pricing-audit.md): evidência e ambiguidades observadas no catálogo.
6. [Persistência dos vínculos (OPS-01)](ops-01-persistencia.md): volume, migração, backup, restauração e limitações.
7. [Auditoria INT-01](int-01-audit.md): matriz de contratos F7, bloqueio de resultados desconhecidos e limites da DEC-01; [inventário offline](int-01-tools-audit.json) e [consulta manual de metadados](int-01-console-command.sh), sem chamadas de negócio.
8. [DOM-01 — Centavos, limites e rateio](dom-01-centavos-limites.md): fronteira BRL do MCP, cálculo inteiro, limites locais e distinção entre subtotal e total desconhecido.
9. [Compra e participantes (DATA-01)](data-01-compra.md): modelo, operações, proveniência, exclusão D7 e guia para o processador.

Plano completo e contrato futuro estão no [telegram-bot](https://github.com/Modo-Escuro/telegram-bot/blob/codex/plano-conversacional/docs/plano-conversacional.md). A [StRS preservada](https://github.com/Modo-Escuro/telegram-bot/blob/main/docs/baseline/stakeholder-requirements-specification.md) continua em validação.

F7 foi incorporada pelo [PR #4](https://github.com/Modo-Escuro/api-backend/pull/4) e permanece desabilitada por padrão. Outputs provisórios e testes simulados não comprovam carrinho real. A [DEC-01](decisoes-conversacionais.md) define demo com sacola simulada e MCP somente leitura; aprovação fictícia não pode usar a rota de compra da API-01.

A RUN-01 não altera schemas nem instala modelo. [Validação histórica de API-01](api-01-validation.md) e testes SQLite da RUN-01 são evidências offline; não comprovam operação implantada. Retenção/exclusão da D7 e o processador de domínio precisam de DATA-01 antes da ativação operacional.
