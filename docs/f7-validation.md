# F7 — Relatório de implementação e validação

> Relatório histórico de código/testes retirados localmente em 20/10/2026. Resultados abaixo não representam a suíte ou a interface atual; ver [retirada do legado](retirada-legado.md).

Branch: `feat/f7-cart-checkout`. PR #4 em rascunho, sem merge para main. A árvore estava limpa antes da
incorporação solicitada de origin/main; arquivos existentes e ignorados foram preservados. Nenhuma compra
ou chamada real de carrinho foi executada. Testes usam exclusivamente AS e MCP simulados.

## Estado atual após a revisão do PR #4

Origin/main (`686300d`) foi incorporada à branch em `33f591e`, incluindo os commits `20e46fd` e `686300d`.
As correções relacionadas a #2/#3 estão integradas, não apenas disponíveis em outra branch. O bloqueio fixo
SECURITY_ISSUES_2_3_PENDING foi removido. A feature permanece `IFOOD_CART_ENABLED=false`, com revisão
informativa, `ELIGIBILITY_UNVERIFIED` e checkout inacessível. Não se habilitou aprovação nem envio real.

### Correções da revisão

1. **Expiração do access token:** um linkId inalterado passa por verify/refresh antes de ser considerado
   indisponível. Refresh válido conserva o carrinho; falha temporária mantém UNAVAILABLE; credencial rejeitada
   exige RECONNECT_REQUIRED. Tentativa de troca de conta e alteração real de linkId continuam bloqueando acesso.
2. **Idempotência após escrita confirmada:** um único registro por requestId vira DONE antes de reler getCart.
   A seleção de entrega/pagamento/cupom não fica presa num segundo registro UNKNOWN. Retry confirmado de
   adição/atualização também consulta a intenção antes de revalidar itemRef ou getItem, permitindo releitura
   mesmo com catálogo expirado. Conteúdo diferente conflita, e escrita de resultado desconhecido continua bloqueada.
3. **Catálogo parcial e limitado:** falha individual de getItem não elimina outros candidatos. Até três chamadas
   simultâneas, dez candidatos e 25 segundos no total da fase de detalhamento; até 15 segundos por chamada,
   limitados ao restante. Timeout local e AbortSignal impedem espera indefinida e publicação tardia de referências.
   Respostas mantêm ordem e devolvem partial, errors sanitizados e contadores de detalhamento.

Não houve expansão para ranking ou implementação do bot Telegram. As alterações de autenticação/elegibilidade
nesta revisão vêm dos commits de segurança incorporados, sem mudanças adicionais nesses módulos de produção.

## Verificações finais — F7 integrada à main

| Comando | Resultado |
|---|---|
| `npm test` | **267 passaram**, 18 arquivos; nenhuma falha ou teste ignorado |
| `npm run typecheck` | passou |
| `npm run lint` | passou |
| `npm run build` | passou, incluindo typecheck e bundle Vite |
| `git diff --check` | passou |

Há **53 testes de F7**, incluindo 13 regressões novas. As 13 falharam contra o serviço anterior às correções
e passaram depois delas. As regressões exercitam refresh aceito/recusado/temporariamente indisponível,
seleção confirmada com falha posterior de getCart, retry de adição/atualização com itemRef expirado,
falha parcial/total de detalhes, concorrência, prazo total mesmo com dependência que ignora timeout,
remoção do bloqueio fixo e manutenção de feature/checkout desabilitados.

A suíte existente também cobre isolamento entre organizadores, desconexão/troca de conta, referências de IDs,
opções obrigatórias/variantes, dinheiro em centavos, totais divergentes, revisão invalidada, estado desconhecido,
transporte sem replay em 401 e rejeição de submitOrder pelo gateway e pelas rotas HTTP. As simulações de
submitOrder usam somente funções falsas, sem conexão ao provedor.

### Portabilidade dos testes de armazenamento

A main trouxe testes que exigiam modos POSIX 700/600 incondicionalmente. Dois falhavam no Windows, onde
[fs.chmod não representa integralmente permissões POSIX](https://nodejs.org/api/fs.html#file-modes).
Foram ajustadas somente essas asserções: modos completos continuam sendo exigidos em plataformas POSIX;
no Windows confere-se o bit de escrita suportado. Todos os testes de criação, gravação, refresh e rollback
continuam executando. **Isso não valida privacidade por ACL no Windows**; uma execução POSIX e validação de
ACLs Windows continuam necessárias para afirmar essas garantias. Nenhum teste foi simplesmente ignorado.

## Arquivos desta revisão

- `src/server/cart/service.ts`: renovação operacional e idempotência antes das releituras/validações.
- `src/server/cart/catalog.ts`: workers limitados, prazo, cancelamento e falhas parciais por candidato.
- `test/cart/review-regressions.test.ts`: 13 regressões reproduzidas antes da correção.
- `test/cart/fakes.ts`: dependências de leitura injetáveis e identidade estável da sessão, independente da
  rotação do access token.
- `test/links/storage.test.ts`: asserções de modos apropriadas à plataforma, sem alterar autenticação de produção.
- `.env.example`, `CLAUDE.md`, `docs/requirements.md`, `docs/bot-api.md`, `docs/f7-cart-checkout.md` e este relatório:
  estado de integração, contrato de resposta parcial, limites e pendências atualizados.

## Funcionalidades de F7 preservadas

Carrinho isolado por organizador/linkId; createCart, getCart, adição/atualização/remoção de itens;
validação contra respostas do catálogo; seleção de entrega/pagamento/cupons; totais reais exclusivamente
através do adaptador getCart, em centavos; revisão invalidada por mudanças; proteção contra repetição de
mutações. Endpoints e corpos completos: [f7-cart-checkout.md](f7-cart-checkout.md).

As entradas vieram da captura real de tools/list, mas as **saídas de carrinho ainda não têm captura real**.
O adaptador conservador permanece provisório e validado apenas por MCP simulado. Isso não constitui
integração real pronta, mesmo com os checks passando.

## Limitações restantes antes de habilitar carrinho/checkout real

- Validar saídas reais de cart, entrega, pagamento e cupons com sessão própria do vínculo.
- Persistir intenções/revisões de forma durável e reconciliar resultados desconhecidos; estado atual é em memória,
  um processo, e reinício perde referências. Nunca reexecutar intenções automaticamente ao reiniciar.
- Definir limpeza, quotas, proteção multiprocesso e cancelamento/reconciliação de operações remotas.
- Garantir elegibilidade rastreável por pessoa/opções; referência de catálogo não comprova segurança alimentar.
- Validar aprovação humana de uso único, consumir aprovação/intenção atomicamente e verificar o contrato real
  de idempotência do checkout, em uma etapa separada. submitOrder continua inacessível nesta etapa.
- Validar permissões de armazenamento na plataforma de implantação, incluindo ACLs quando aplicável.

## Histórico da primeira entrega

A primeira entrega (a0a8f5d), baseada em ed76aea, tinha 40 testes novos passando; a suíte completa tinha
234 aprovados e três falhas preexistentes, com typecheck/build bloqueados por cancelAttempt ausente.
A comparação isolada de ed76aea reproduzia 194 aprovados e as mesmas três falhas em 197 testes.
Esses resultados são históricos e foram substituídos pela validação integrada descrita acima.
