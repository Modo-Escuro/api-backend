# RUN-01 — processamento durável de turnos

[Issue #14](https://github.com/Modo-Escuro/api-backend/issues/14) · [Contrato v1.0](conversation-api-v1.md) · [Vínculo Telegram](bot-api.md)

## Entrega e disponibilidade

Implementada a infraestrutura de aceite, fila, execução limitada, consulta, cancelamento local e recuperação em SQLite real. As rotas v1 estão registradas no aplicativo. A ativação é explícita e permanece **desligada por padrão**. Nenhum schema da API-01 foi alterado.

`index.ts` ainda não instala processador de domínio/IA. Mesmo ao ativar a infraestrutura, novos eventos retornam **503 UNAVAILABLE** até que DATA-01 e AI-01 forneçam um `TurnProcessor` confiável no servidor. Replays e consultas de operações existentes continuam possíveis. Não existe resposta fictícia de sucesso, chamada de LLM/MCP ou compra neste incremento.

DATA-01 permanece responsável por representar participantes/restrições/origem, validar patches e conservar o acordo da compra. OPS-01 permanece responsável pelo volume e preservação dos vínculos existentes. O armazenamento de snapshots da RUN-01 não substitui esse domínio nem comprova que a migração operacional foi feita. A integração real com o bot também precisa da outbox/acompanhamento restantes da BOT-01.

A base foi atualizada para `main@cd22b9f`, que inclui a [DEC-01](decisoes-conversacionais.md): demo com sacola simulada, MCP somente leitura e política D7 de exclusão. Aprovação fictícia não autoriza transação real. O ajuste de contrato para revisão simulada permanece separado; RUN-01 não reutiliza `/purchase-approvals` para esse fim.

## Código e fluxo

| Arquivo | Responsabilidade |
| --- | --- |
| `src/server/turns/store.ts` | Transações, unicidade, snapshots/resultados, compare-and-swap, leases, marcador de efeito externo e recuperação |
| `src/server/turns/runtime.ts` | Worker no processo da API, concorrência limitada, heartbeat, abort e encerramento |
| `src/server/routes/conversation.ts` | Validação HTTP/identidade, limites de corpo, rotas e erros fixos |
| `test/turns/` | SQLite em disco, falhas transacionais, morte de processo, worker e rotas reais com processadores sintéticos |

1. O middleware autentica o adaptador e o organizador. A rota confere chat privado correspondente, path e bot cadastrado por configuração; identidade não vem do texto/modelo.
2. Uma transação `BEGIN IMMEDIATE` busca a chave escopada do evento antes de conferir a versão atual. Replay idêntico recupera a operação original; conteúdo divergente retorna `EVENT_CONFLICT`.
3. Para evento novo, conferir versão e limites e gravar conversa inicial, evento/hash/origem e operação juntos. **202 só é emitido depois de COMMIT.** O resultado não depende de terminar o modelo na requisição HTTP.
4. O worker adquire uma operação em ordem de aceite, com token criptográfico e lease persistidos. O processador recebe cópias do evento e snapshot e um `AbortSignal`.
5. O commit confere token, lease, cancelamento e versão corrente dentro da transação. Snapshot, versão, proveniência e resultado são gravados juntos. Resultado atrasado não sobrescreve uma revisão mais nova.
6. GET/replay devolvem o resultado persistido, sem executar novamente. O payload textual temporário da fila é removido logicamente ao terminar; evento/hash/origem e resultado permanecem.

As transições são serializadas pelo SQLite; trabalhos de leitura podem executar concorrentemente. Dois eventos aceitos na mesma versão podem competir: o primeiro commit válido avança a revisão, e o outro termina `FAILED/STALE_VERSION`. Esse erro exige consultar o estado corrente e uma nova correção explícita; não alterar silenciosamente o corpo de um evento aceito. Este mecanismo não interpreta nem concilia restrições por conta própria.

Um `TurnProcessor` é código interno confiável, não uma ferramenta exposta ao modelo. Deve usar os validadores de domínio de DATA-01 e produzir `TurnResult` com snapshot validado, versão base + 1, completude e campos afetados. Não instalar um repasse do JSON do LLM como processador. O commit cria a referência de alteração ligada ao evento e à mensagem de origem. Neste incremento, referências de ação/aprovação não são emitidas; eventos gerais de ação e a rota de aprovação retornam `ACTION_UNAVAILABLE` até suas integrações específicas.

## Recuperação, cancelamento e efeito desconhecido

| Situação | Comportamento |
| --- | --- |
| Queda antes do commit de aceite | Nada parcialmente aceito; o mesmo evento pode ser enviado novamente |
| Queda depois do commit e antes da resposta | Replay recupera a mesma operação |
| Lease perdido sem marcador de escrita | A mesma operação de leitura pode ser retomada, dentro do prazo e limite de tentativas |
| Worker antigo termina depois de retomada | Token antigo não renova lease nem publica resultado |
| Resultado já gravado antes da queda | GET/replay recuperam o resultado; worker não o executa novamente |
| Cancelamento enfileirado | `CANCELLED`; nenhum cancelamento remoto foi solicitado |
| Cancelamento durante execução | Persistir `CANCEL_REQUESTED`, abortar cooperativamente e confirmar parada segura depois |
| Prazo esgotado sem efeito externo | `FAILED/DEADLINE_EXCEEDED` |
| Queda, timeout ou falha depois do marcador de escrita | `RESULT_UNKNOWN`; não reenfileirar escrita nem mascarar o estado com cancelamento |

O cancelamento tem evento e registro próprios no mesmo namespace de deduplicação. Não altera a origem da operação alvo. Sua resposta sempre contém `remoteCancellation: NOT_REQUESTED`. Replay do cancelamento recupera o resultado daquele comando; consultar a operação alvo para seu estado posterior.

`beforeExternalWrite()` é uma barreira interna que **sempre rejeita escrita na demo**, conforme D8. Nenhuma flag, processador ou aprovação fictícia a libera. O armazenamento possui primitivas defensivas para marcador anterior ao efeito e resultado desconhecido, exercitadas somente em testes sintéticos. Não há executor de compra instalado. Uma evolução fora da demo exigiria nova decisão e aprovação/intenção consumidas na mesma transação do marcador, com reconciliação; não basta instalar um hook.

Depois do marcador, uma falha é conservadoramente desconhecida mesmo se o processo caiu antes de alcançar o provedor. Operação desconhecida bloqueia outra barreira de escrita na conversa e não expira automaticamente. Resultado conhecido exige bloco estruturado com referência de evidência; texto do modelo não resolve incerteza. Não há endpoint de reconciliação neste incremento: ele pertence a BUY-02/INT-01. Não prometer execução única no provedor.

O abort é cooperativo. Processador que ignora o sinal não libera slots para criar execuções ilimitadas; após a tolerância técnica, o runtime fecha a admissão com `UNAVAILABLE`. A manutenção de prazos continua; resultados tardios são rejeitados. O operador deve corrigir/reiniciar esse processador. `stop()` aborta e fecha o banco sem esperar indefinidamente; o próximo processo respeita o lease persistido antes de retomar.

## Limites técnicos iniciais

São proteções configuráveis por `TurnLimits`/`RuntimeOptions`, não metas de experiência ou políticas de produto aprovadas em DEC-01/OPS-02.

| Limite | Padrão |
| --- | --- |
| Corpo HTTP | 16 KiB; leitura por até 10 s |
| Resultado persistido | 64 KiB, além dos limites estruturais da API-01 |
| Prazo de uma operação | 120 s a partir do aceite |
| Lease / tick | 15 s / 500 ms |
| Concorrência no processo | 2; configurável entre 1 e 4 |
| Pendências totais / por conversa | 100 / 10 |
| Tentativas após perda de lease sem escrita | Até 3 |
| Registros de eventos | 10.000; reserva limitada para cancelamento |
| Tolerância a abort não atendido | 2 s antes de fechar admissão |

Replay é consultado antes dos limites, para não perder acesso ao processamento já aceito com fila cheia. Ao atingir o limite de registros, não apagar chaves automaticamente: retornar `LIMIT_EXCEEDED` para novo trabalho. A D7 já definiu exclusão ao encerrar/24 h inativas, logs até 7 dias e backups até 7 dias. Sua implementação transacional e a conciliação com replay/tombstones v1 continuam em DATA-01/OPS-01; **este armazenamento não implementa expurgo automático e não deve ser ativado com dados reais antes dessa integração**. Efeitos desconhecidos nunca devem ser liberados por expiração de chave. Limites de tokens/ferramentas/custo do modelo ficam em AI-01/OPS-02; o prazo técnico de 120 s não substitui a meta D10 de p95 ≤ 10 s.

## Configuração e operação

Node **22.13+**, com SQLite nativo, ainda experimental nessa versão ([documentação oficial](https://nodejs.org/download/release/v22.13.0/docs/api/sqlite.html)). Dependências continuam no `package-lock.json`; não foi adicionado serviço de fila ou pacote de banco.

```text
CONVERSATION_RUNTIME_ENABLED=false
CONVERSATION_DB_FILE=/data/conversations/turns.sqlite
BOT_TELEGRAM_ID=<ID numérico do bot, obtido por getMe>
```

Com a flag ligada, caminho e ID são obrigatórios. O exemplo de caminho pressupõe um volume já preparado; não cria/migra volume Railway. `BOT_API_TOKEN` e `ALLOWED_ORGANIZER_IDS` continuam obrigatórios para autenticação. O token do BotFather não pertence à API. Não modificar variáveis/segredos de produção para ensaiar esta infraestrutura sem DATA-01/OPS-01 e o processador integrados.

Usar **uma instância/processo** da API e diretório dedicado no volume persistente. SQLite usa WAL e `synchronous=FULL`. Diretório/arquivo são configurados para 700/600 em POSIX; no Windows, conferir ACL do diretório, pois bits POSIX não representam a proteção NTFS. Banco inválido ou versão não suportada falha fechado e não é substituído por banco vazio.

Para backup, parar o processo e aguardar o fechamento do banco, então copiar privadamente o diretório completo, preservando eventuais arquivos WAL/SHM. Não copiar apenas o arquivo principal de um banco aberto. Restaurar uma cópia consistente com o mesmo esquema em ambiente isolado; conferir `quick_check`, replay, versão e resultados antes de trocar o serviço. Nunca restaurar snapshot antigo sobre operação com efeito externo pendente/desconhecido: reconciliar antes. A migração/rollback dos vínculos OAuth existentes continua separada em OPS-01; não sobrescrever `.ifood-links` nem o SQLite do bot com este banco.

Payloads e snapshots podem conter contexto privado. Não registrar banco, backups, texto integral, identidade, referências ou tokens em Git/logs. Remoção lógica do payload não garante apagamento de páginas antigas/WAL/backups; retenção e acesso precisam da política operacional. O logger redige todos os caminhos v1, inclusive IDs de conversa/operação. Erros das rotas e do worker usam mensagens fixas; exceção bruta não é persistida nem devolvida.

## Validação e pendências

```text
npm ci
npm run typecheck
npm run lint
npm test
npm run build
```

CI adicionada para Windows/Ubuntu e Node 22.13/24. Os testes específicos usam SQLite em disco e processos filhos que terminam sem encerramento limpo, com falhas injetadas no aceite/commit, replay, origem, concorrência, token antigo, limites, cancelamento, prazo e efeito desconhecido. Os processadores e autorizações dos testes são sintéticos: nenhuma chamada de negócio ao iFood ou instância real do bot é iniciada.

Validação local em 18/10/2026, Windows/Node 24.13, após incorporar `main@cd22b9f`: **404 testes TypeScript passaram**, incluindo 34 da RUN-01; typecheck, lint e build passaram. Os seis testes Python de conformidade da API-01 também passaram. O resultado da matriz de CI deve ser conferido na PR. Não houve merge, deploy, mudança de variáveis Railway nem ensaio com conta real.

Para entrega operacional completa: integrar DATA-01 na persistência/validação de domínio e exclusão D7, instalar o processador AI-01, concluir OPS-01 com volume/recuperação verificados e ensaiar o bot via RUN-01. Manter zero escrita MCP, conforme DEC-01. Aprovação simulada exige ajuste explícito do contrato e suas tarefas; escrita real está fora dessa demo. Esses trabalhos não são marcados como concluídos pelos testes da infraestrutura.
