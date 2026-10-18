# RUN-01 — processamento durável de turnos

[Issue #14](https://github.com/Modo-Escuro/api-backend/issues/14) · [Contrato v1.0](conversation-api-v1.md) · [Vínculo Telegram](bot-api.md)

## Entrega e disponibilidade

Implementada a infraestrutura de aceite, fila, execução limitada, consulta, cancelamento local e recuperação em SQLite real. As rotas v1 estão registradas no aplicativo. A ativação é explícita e permanece **desligada por padrão**. Nenhum schema da API-01 foi alterado.

Sem opt-in separado do modelo, novos eventos continuam retornando **503 UNAVAILABLE**, mesmo com a infraestrutura ativa.
A [montagem AI-01](ai-01-montagem-ensaio.md) conecta o Gemini 3.8 Flash ao processador da AI-02 (com as sugestões
da GRP-01) somente com configuração explícita; ensaio operacional e D10 permanecem pendentes.
O domínio da DATA-01 já está integrado ao armazenamento ([data-01-compra](data-01-compra.md)). Replays e consultas
de operações existentes continuam possíveis. Não há executor de compra instalado.

DATA-01 representa participantes/restrições/origem, valida patches e conserva o acordo da compra no mesmo banco (schema v2), gravando domínio e snapshot na mesma transação. OPS-01 permanece responsável pelo volume e preservação dos vínculos existentes. O armazenamento de snapshots da RUN-01 não substitui esse domínio nem comprova que a migração operacional foi feita. Outbox/acompanhamento BOT-01 já estão integrados ao bot remoto; o ensaio operacional é uma evidência separada.

A main remota conferida em [estado remoto/local](estado-remoto-local.md) já inclui montagem AI-01 e testes finais RUN-01 #41. A [DEC-01 vigente](decisoes-conversacionais.md) permite preparação real confirmada, mas CART-01 nova ainda é local; o runtime publicado não ganha escrita por documentação. PREPARE_CART é distinto de aprovação de pedido; RUN-01 não reutiliza `/purchase-approvals` para preparar carrinho.

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

Um `TurnProcessor` é código interno confiável, não uma ferramenta exposta ao modelo. Recebe `purchase` e `previewDomain()` no `TurnContext`, propõe só operações tipadas em `TurnResult.domain` (o armazenamento recalcula o estado a partir do persistido) e produz `TurnResult` com snapshot validado, versão base + 1, completude e campos afetados. Não instalar um repasse do JSON do LLM como processador. O commit cria a referência de alteração ligada ao evento e à mensagem de origem. Processamento somente leitura não pode publicar `OUTCOME`, `SUBMITTING` ou `CONFIRMED` de compra, mesmo com referência aparentemente válida. Neste incremento, referências de ação/aprovação não são emitidas; eventos gerais de ação e a rota de aprovação retornam `ACTION_UNAVAILABLE` até suas integrações específicas.

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

Na main remota conferida, `beforeExternalWrite()` é uma barreira interna que **sempre rejeita escrita**. Nenhuma flag ou texto de aprovação a libera. O armazenamento possui primitivas defensivas para marcador anterior ao efeito e resultado desconhecido, exercitadas somente em testes sintéticos. Não há executor de carrinho confirmado instalado. A decisão de permitir PREPARE_CART já foi tomada na DEC-01; falta integrar a CART-01 local, com confirmação/intenção consumidas atomicamente antes da rede e reconciliação verificada na INT-02. Não basta instalar um hook.

Depois do marcador, uma falha é conservadoramente desconhecida mesmo se o processo caiu antes de alcançar o provedor. Operação desconhecida bloqueia outra barreira de escrita na conversa e não expira automaticamente. Resultado conhecido exige bloco estruturado com referência de evidência; texto do modelo não resolve incerteza. A main conferida não oferece endpoint de reconciliação: o contrato externo pertence à INT-02, a preparação à CART-01 e eventual envio futuro à BUY-02. Não prometer execução única no provedor.

O abort é cooperativo. Processador que ignora o sinal não libera slots para criar execuções ilimitadas; após a tolerância técnica, o runtime fecha a admissão com `UNAVAILABLE`. A manutenção de prazos continua; resultados tardios são rejeitados. O operador deve corrigir/reiniciar esse processador. `stop()` aborta e fecha o banco sem esperar indefinidamente; o próximo processo respeita o lease persistido antes de retomar.

No mesmo processo, uma operação com lease perdido não é retomada enquanto sua promise anterior ainda ocupa um slot, mesmo depois de abortada. A limpeza do slot também confere o token da execução: uma finalização antiga não pode remover o acompanhamento de uma tentativa mais nova. O teste de regressão combina lease perdido, conclusão atrasada e fila adicional para verificar o limite real de concorrência.

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

Replay é consultado antes dos limites, para não perder acesso ao processamento já aceito com fila cheia. Ao atingir o limite de registros, não apagar chaves automaticamente: retornar `LIMIT_EXCEEDED` para novo trabalho. A D7 já definiu exclusão ao encerrar/24 h inativas, logs até 7 dias e backups até 7 dias. A DATA-01 implementa a parte deste banco: encerrar a compra exclui os dados na mesma transação e `purge()` (chamado pelo tick a cada 60 s) exclui conversas com 24 h sem evento aceito, mantendo só chave + hash dos eventos e o status das operações para deduplicação. Logs e backups seguem a OPS-01/OPS-02. Efeitos desconhecidos nunca devem ser liberados por expiração de chave. Limites de tokens/ferramentas/custo do modelo ficam em AI-01/OPS-02; o prazo técnico de 120 s não substitui a meta D10 de p95 ≤ 10 s.

## Configuração e operação

Node **22.13+**, com SQLite nativo, ainda experimental nessa versão ([documentação oficial](https://nodejs.org/download/release/v22.13.0/docs/api/sqlite.html)). Dependências continuam no `package-lock.json`; não foi adicionado serviço de fila ou pacote de banco.

```text
CONVERSATION_RUNTIME_ENABLED=false
CONVERSATION_DB_FILE=/data/conversations/turns.sqlite
BOT_TELEGRAM_ID=<ID numérico do bot, obtido por getMe>
```

Com a flag ligada, caminho e ID são obrigatórios. A classificação da OPS-01 é reutilizada para recusar banco em disco sabidamente efêmero (Railway sem volume/diretório fora dele ou Vercel). O exemplo de caminho pressupõe um volume já preparado; não cria/migra volume Railway. `BOT_API_TOKEN` e `ALLOWED_ORGANIZER_IDS` continuam obrigatórios para autenticação. O token do BotFather não pertence à API. Não modificar variáveis/segredos de produção para ensaiar esta infraestrutura sem DATA-01/OPS-01 e o processador integrados.

Usar **uma instância/processo** da API e diretório dedicado no volume persistente. SQLite usa WAL e `synchronous=FULL`. Diretório/arquivo são configurados para 700/600 em POSIX; no Windows, conferir ACL do diretório, pois bits POSIX não representam a proteção NTFS. Banco inválido ou versão não suportada falha fechado e não é substituído por banco vazio.

Com CART-01, o banco migra de v2 para v3; com a [conversa guiada](conversa-guiada.md), avança para **v4**, que aceita a intenção de busca persistida. As migrações são aditivas/transacionais, mesmo com a escrita desligada. Confirmações/intenção usam o mesmo SQLite; o ciclo `recover()` trata intenções vencidas sem repetir rede. Possível efeito mantém RESULT_UNKNOWN e bloqueia alterações/expurgo. Rollback por flag preserva os dados; binários anteriores recusam versões mais novas. Não rebaixar `user_version` nem restaurar banco antigo para contornar essa proteção. Ver [CART-01](cart-01-escrita-confirmada.md).

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

Registro histórico da implementação RUN-01, antes dos merges posteriores: validação local em 18/10/2026, Windows/Node 24.13, após incorporar `main@9aa02f2`: **440 testes TypeScript passaram**, incluindo 35 da RUN-01; dois testes POSIX de permissões da OPS-01 foram omitidos no Windows, conforme a condição já existente nessa base. Typecheck, lint e build passaram. Os seis testes Python de conformidade da API-01 também passaram. O resultado da matriz de CI deve ser conferido na PR. Não houve merge na main, deploy, mudança de variáveis Railway nem ensaio com conta real.

Validação integrada em 18/10/2026, Linux/Node 22.23, sobre `main@dc448f9` (AI-01 #36 + DATA-01 + GRP-01):

- `test/turns/run01-integrated.test.ts`: morte real do processo com o **processador da AI-02** (Gemini com transporte
  sintético) sobre o domínio da DATA-01 nas etapas aceite, execução (modelo em voo) e commit. O reinício recupera a mesma
  operação e aplica uma vez; a leitura retomada chama o modelo de novo, e resultado já gravado não chama. Busca GRP-01
  lenta × correção de teto na mesma versão: a correção vence e a busca termina `STALE_VERSION`.
- Ensaio de processo real (API em execução, adaptador do bot simulado por HTTP, Gemini real, dados sintéticos, banco em
  diretório dedicado 700/600): 202 após commit; replay idêntico → 200 com a mesma operação; mesmo `eventId` com outro
  texto → 409 `EVENT_CONFLICT`; `kill -9` com o turno `RUNNING` → retomado após o lease (18 s, 2 tentativas, uma
  aplicação, alergia preservada, teto R$ 150); `kill -9` após o commit → snapshot idêntico, sem nova execução; versão
  antiga → 409 `STALE_VERSION`; "pode pedir" sem aprovação; `quick_check ok`; logs sem texto, identidade ou segredo.
- Não executado: bot Telegram real (exige o único worker de polling e token do bot) e volume Railway (OPS-01).

Situação vigente na base remota `f3b8b55`: AI-01/AI-02, DATA-01, GRP-01, OPS-01 e os testes finais RUN-01 (#41) estão integrados ao código; a montagem do processador depende de configuração explícita. Isso não comprova o estado do deploy, volume Railway nem ensaio com Telegram real. A DEC-01 agora permite preparar carrinho real após confirmação humana específica. CART-01 permanece somente local; sua integração e a validação externa INT-02 #40 continuam pendentes. Envio e pagamento seguem proibidos, e testes automatizados não fazem escritas externas. Conferir [estado remoto/local](estado-remoto-local.md) antes de ativar qualquer fluxo.
