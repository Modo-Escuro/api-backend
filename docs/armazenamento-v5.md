# Armazenamento v5 — registro da variante local anterior

**Histórico:** este guia descreve a variante v5 local anterior à reconciliação. A main também usou v5 para outras tabelas, sem memória seletiva. A fonte atual é [SQLite v6](armazenamento-v6.md), que migra ambas; não usar a numeração v5 isoladamente como prova de compatibilidade. O contrato HTTP continua `1.0`.

## Migrações implementadas

| Versão | Incremento |
| --- | --- |
| v1 | Fila de eventos/operações, snapshots, leases, cancelamento e deduplicação RUN-01 |
| v2 | Domínio DATA-01, alterações com proveniência e atividade para expurgo |
| v3 | Revisões, intenções e estado técnico CART-01 |
| v4 | Memória seletiva: contas por vínculo, pessoas e fatos compactos |
| v5 — variante local anterior | `operations.account_session`, `operations.account_link_id`, tabelas `account_bindings` e `retired_purchase_states` |

A abertura instala as migrações faltantes em transação; runtime aberto com modelo/escrita desligados também migra o banco. Versão acima da suportada é recusada, sem substituir por banco vazio. Binários v4 e anteriores devem recusar v5. Registros antigos sem sessão permanecem sem associação: não se inventa identidade retrospectiva.

## Associação conta ↔ fila

O adaptador consulta `GET /api/bot/v1/conversations/:conversationId/account-context`. Quando `enabled: true`, captura `sessionRef` e conserva essa referência com a mensagem na outbox e no cabeçalho `X-Conversation-Session`, inclusive em consultas/replay. É referência técnica do vínculo atual, não `userId` iFood e não autorização de compra.

- Referência obsoleta é recusada com `LINK_CHANGED`; não se recaptura outra sessão para transferir um evento antigo à conta nova.
- O runtime confere a sessão antes e depois do processador. Operações aceitas com sessão ficam associadas a ela.
- Consulta de snapshot por uma sessão ainda não associada devolve documento neutro com a versão corrente; não revela o snapshot de outra conta.
- Ao gravar domínio sob outro vínculo em turno associado, o estado anterior pode ser conservado em `retired_purchase_states`; ele não é recuperado como memória/perfil da conta nova.
- **Compatibilidade:** sem cabeçalho, `authorizeSession()` não cria associação. Clientes antigos continuam no caminho anterior, sem a garantia adicional de associação por evento. Consultar o endpoint não vincula retroativamente suas operações.

Contrato detalhado: [conversa v1](conversation-api-v1.md#sessão-do-vínculo-atual).

## Dados, exclusão e rollback

Memória é particionada por escopo Telegram autenticado e hash do vínculo OAuth; não associa reconexões por nome/e-mail. `account_bindings` e estados retirados não demonstram identidade estável iFood. Os vínculos OAuth/tokens continuam em armazenamento separado, `IFOOD_LINKS_DIR`.

O expurgo D7 remove memória do escopo, associações e estados retirados, além do domínio/conteúdo já coberto pela DATA-01. Intenções CART-01 PENDING/RESULT_UNKNOWN impedem expurgo. Permanecem tombstones técnicos de deduplicação; apagar dados não autoriza reenvio.

Rollback funcional desliga runtime/modelo/CART-01, preservando banco, WAL/SHM e vínculos. Não rebaixar `user_version`, apagar intenções ou restaurar backup antigo sobre efeito desconhecido. Para backup/restauração usar [RUN-01](runtime-turnos.md#configuração-e-operação) e [OPS-01](ops-01-persistencia.md).

## Evidência

Migração e isolamento são exercitados localmente por `test/turns/account.test.ts`, `test/turns/data01.test.ts`, testes de memória e CART-01. Isso não confirma migração de um volume implantado nem funcionamento online. As menções a v3/v4 em relatórios datados são versões históricas, não a versão corrente.
