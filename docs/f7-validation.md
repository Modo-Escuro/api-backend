# F7 — Relatório de implementação e validação

Branch: `feat/f7-cart-checkout`, baseada em `ed76aea`. Commit e PR autorizados pelo usuário após a validação; sem merge automático.
A árvore estava limpa no início. Arquivos ignorados já existentes foram preservados; nenhuma credencial foi
lida para os testes. Nenhuma compra ou chamada real de carrinho foi executada.

## Entrega

F7.1/F7.2 implementadas como fluxo isolado de carrinho, com inputs dos schemas MCP capturados, referências de
catálogo emitidas pelo backend, revalidação de item/opções, operações de itens, entrega, pagamento e cupons,
totais exclusivamente de getCart, revisão invalidável e proteção contra repetição de mutações. As saídas de
carrinho ainda não têm captura real; o adaptador conservador foi validado apenas com MCP simulado. A feature
fica desligada por padrão (`IFOOD_CART_ENABLED=false`), sem reivindicar integração real pronta.

F7.3 preparada: revisão informativa, contrato de aprovação futura ligado a identidade/revisão/total/expiração,
política pura e testes de submitOrder com função falsa. Gateway e rotas não permitem enviar pedido real;
aprovação/envio HTTP retornam CHECKOUT_DISABLED. Login e revisão nunca aprovam compra.

Contrato completo de endpoints e limitações: [f7-cart-checkout.md](f7-cart-checkout.md).
O resumo foi acrescentado a [bot-api.md](bot-api.md#10-f7--contrato-do-carrinho-e-revisão).

## Verificações executadas

Node/npm instalados localmente; dependências instaladas com `npm ci --no-audit --no-fund`, sem mudar o lockfile.
Testes usam exclusivamente AS e MCP falsos.

| Comando | Resultado final |
|---|---|
| `npm test` | **234 passaram, 3 falharam**, 237 no total; as três falhas já existem na revisão-base |
| `npm run typecheck` | falha somente por `cancelAttempt` inexistente em `test/links/concurrency.test.ts:98` e `:148` |
| `npm run lint` | passou |
| `npm run build` | bloqueado pelo mesmo typecheck, antes do Vite |
| `git diff --check` | passou |

Os **40 testes novos** de `test/cart/` passaram na execução completa. Cobrem operações/contrato HTTP, IDs, opções obrigatórias e variantes desconhecidas, quantidades, isolamento por organizador/linkId, desconexão em chamada pendente, troca de conta, escopos, flag desabilitada, entrega/pagamento/cupons, cartão sem exposição de token, totais ausentes/divergentes, expiração/invalidação de revisão, repetição concorrente, conteúdo conflitante, timeout, erro inline sanitizado, falha de leitura depois de escrita, transporte sem replay em 401 e compra simulada.

### Comparação isolada com a base

Foi extraído `git archive HEAD` em diretório temporário separado, reutilizando somente as dependências
instaladas. A branch de trabalho não foi revertida, e nenhum teste preexistente foi modificado/ignorado.

- Base `ed76aea`: **194 passaram e 3 falharam**, 197 testes; os mesmos dois erros de TypeScript.
- Falha 1: desconexão durante gravação de tokens termina em CONNECTED, em vez de DISCONNECTED (issue #2).
- Falhas 2 e 3: `env.links.cancelAttempt is not a function`, nos cenários de cancelamento concorrente.
- A mesma comparação na branch de F7 produziu as três falhas e nenhum novo erro de TypeScript.

## Arquivos alterados/adicionados

| Grupo | Arquivos |
|---|---|
| Serviço/contratos/política | `src/server/cart/service.ts`, `contracts.ts`, `approval.ts` |
| Gateway/transporte | `src/server/mcp/cart.ts`, `client.ts` |
| Integração de sessão | `src/server/links/session.ts`, `service.ts` (somente gateway, contexto, escopos e mensagem de status) |
| HTTP/configuração | `src/server/routes/cart.ts`, `src/server/app.ts`, `src/server/config.ts`, `.env.example` |
| Testes | `test/cart/cart.test.ts`, `approval.test.ts`, `transport.test.ts`, `fakes.ts` |
| Regras e documentação | `CLAUDE.md`, `eslint.config.js`, `docs/requirements.md`, `docs/bot-api.md`, `docs/f7-cart-checkout.md`, este relatório |

`auth.ts`, `botAuth.ts`, o domínio de elegibilidade e os testes preexistentes não foram alterados. A extensão de
`McpSession` permite desligar replay 401 para o carrinho e preserva o padrão anterior das sessões de leitura.

## Pendências antes de habilitação real e PR

**Issues #2 e #3 continuam pendentes e precisam constar como dependências do PR.** Não se declara segurança de alergia a partir de filtros nem correção do ciclo de vida de vínculos. Revisões de F7 têm bloqueio explícito
`ELIGIBILITY_UNVERIFIED`, além de checkout desabilitado.

Ainda são necessários: validar payloads reais de cart/entrega/pagamento/cupons;
integrar as correções de segurança;
persistir intenções e revisões;
implementar reconciliação de resultados desconhecidos e recuperação após reinício;
definir limpeza/quotas;
garantir elegibilidade por pessoa/opções;
validar callback Telegram humano de uso único e consumir aprovação/intenção atomicamente;
verificar o contrato real de idempotência do checkout.
Não habilitar compra real apenas porque testes sintéticos passam ou porque o usuário fez login.

## Estado remoto na preparação do PR

A referência origin/main avançou para 686300d, com os commits de segurança 20e46fd e 686300d, após a implementação e os testes descritos acima. Essas correções ainda não foram integradas à branch F7. Os resultados registrados continuam correspondendo à branch baseada em ed76aea; não são uma validação da combinação com a main atual. O PR será aberto em rascunho para revisar essa integração e repetir os checks antes de habilitar a feature.
