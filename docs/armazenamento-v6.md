# Armazenamento unificado — SQLite v6

Reconciliação local em 20/10/2026, baseada em `origin/main@f6ef20e`. Nenhum banco implantado foi aberto/migrado nesta etapa. `SCHEMA_VERSION = 6` em `turns/store.ts`; contrato HTTP continua `1.0`.

## Por que existe v6

A versão v5 publicada e a v5 do checkout local usavam estruturas diferentes. O número sozinho não autorizava instalar uma sobre a outra:

| Origem v5 | Estruturas próprias |
| --- | --- |
| Publicada em main | `account_groups`, `conversation_accounts`, `operation_accounts`; v4 reservada à navegação |
| Local anterior | `assistant_memory_*`, `account_bindings`, `retired_purchase_states`, colunas `operations.account_session/account_link_id`; memória introduzida em v4 |

v6 instala as capacidades canônicas faltantes de forma aditiva/transacional em ambas. Conserva conversas, domínio, eventos/replay, intenções e estados desconhecidos. Não copia grupos antigos para SELF, não infere identidade estável por nome/e-mail e não converte retrospectivamente referências de sessão antigas em novas.

## Forma canônica e compatibilidade

O assistente usa memória por `(escopo Telegram, hash do vínculo OAuth)` e associação por `X-Conversation-Session`, capturada em `/account-context`. Preserva a referência por evento, inclusive em replay/consulta; troca de vínculo não transfere o evento. Sem cabeçalho permanece compatibilidade sem associação por evento.

Tabelas de grupos da variante publicada são preservadas como dados anteriores, sem ativar o intérprete retirado ou CRUD de grupo por conta. `CONVERSATION_ACCOUNT_GROUPS_ENABLED=true` é recusado, em vez de aparentar que essa funcionalidade segue ativa. O expurgo D7 permitido também remove os grupos/associações antigos do escopo; bloqueios CART-01 desconhecidos continuam impedindo expurgo.

O construtor confere as colunas canônicas dentro da transação. Forma incompatível aborta a migração e não marca sucesso de v6. Uma versão futura não suportada é recusada. Binários v5 e anteriores recusam v6: rollback funcional desliga opt-ins, preserva banco/WAL/SHM e restaura binário compatível; nunca rebaixa user_version ou restaura cópia antiga sobre efeito desconhecido.

## Evidência local

`test/turns/migration6.test.ts` monta as duas variantes v5 em SQLite real, conserva domínio/eventos/memória ou grupos antigos e RESULT_UNKNOWN, e cobre rollback da migração diante de forma incompatível. Não é prova de migração de volume online. Os testes CART-01 preservam suas verificações próprias de replay/intenções.

Guia anterior: [variantes v5](armazenamento-v5.md). [Contrato HTTP](conversation-api-v1.md#sessão-do-vínculo-atual), [RUN-01](runtime-turnos.md) e [CART-01](cart-01-escrita-confirmada.md) descrevem as fronteiras operacionais.
