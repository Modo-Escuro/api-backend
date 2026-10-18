# Documentação da API

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
11. [Propostas coletivas e sacola simulada (GRP-01)](grp-01-propostas.md): matriz por pessoa, custos DOM-01, tetos, corte em 4 e sacola simulada.
12. [Montagem AI-01 e ensaio BOT-02](ai-01-montagem-ensaio.md): configuração explícita, candidato OpenAI, avaliação sintética e pendências operacionais.

Plano completo e contrato futuro estão no [telegram-bot](https://github.com/Modo-Escuro/telegram-bot/blob/codex/plano-conversacional/docs/plano-conversacional.md). A [StRS preservada](https://github.com/Modo-Escuro/telegram-bot/blob/main/docs/baseline/stakeholder-requirements-specification.md) continua em validação.

F7 foi incorporada pelo [PR #4](https://github.com/Modo-Escuro/api-backend/pull/4) e permanece desabilitada por padrão. Outputs provisórios e testes simulados não comprovam carrinho real. A [DEC-01](decisoes-conversacionais.md) define demo com sacola simulada e MCP somente leitura; aprovação fictícia não pode usar a rota de compra da API-01.

A infraestrutura RUN-01 mantém os schemas da API-01; a montagem do modelo tem opt-in separado na AI-01.
[Validação histórica de API-01](api-01-validation.md) e testes SQLite são evidências offline; não comprovam operação implantada.
A DATA-01 já integra domínio e exclusão D7 ao runtime. Volume, recuperação e o ensaio operacional continuam exigindo verificação.
