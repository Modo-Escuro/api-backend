# Evidência de validação — API-01

Conferência em 18/10/2026, Windows, Node 24.19.0 e Python 3.12. Base: `main@686300d`. Escopo: contrato executável e conformidade offline, sem registrar rotas no aplicativo. [Especificação e reprodução](conversation-api-v1.md).

| Verificação executada | Resultado |
| --- | --- |
| Instalação `npm ci --ignore-scripts` com lockfile | concluída |
| Geração dos JSON Schemas e exemplos via `node --import tsx` | concluída; schemas comparados com Zod nos testes |
| `tsc --noEmit -p tsconfig.json` | passou |
| `eslint .` | passou |
| `vitest run test/contracts/conversation.test.ts` | 103/103 passaram |
| Python: `unittest discover -s test/contracts -p "test_*.py" -v` | 6/6 passaram; mesmos exemplos JSON, incluindo fronteira Unicode |
| `vitest run` completo | 315/317 passaram; duas falhas de permissões POSIX no Windows |
| `vite build` | passou |
| `git diff --check` e `git diff --cached --check` | passaram |

As duas falhas completas são de `test/links/storage.test.ts`: criação com modo 700 e correção de diretório/arquivo com permissões frouxas. Ambas comparam `438` (modo 0666 observado no Windows) com `448` (0700). Reprodução em worktree limpo de `686300d`, executando somente esse arquivo: 4/6 passaram, **as mesmas duas falhas**. Nenhum código/teste de storage foi alterado nesta entrega. A suíte não está integralmente verde neste ambiente; Linux/CI não foi executado aqui.

A primeira execução sob sandbox também encontrou EPERM no armazenamento temporário falso; a execução completa acima foi repetida com acesso aos temporários e ficou limitada às duas falhas de plataforma reproduzidas no baseline. Não são falhas do provedor real.

## Critérios de API-01 cobertos

- Schemas estritos, exemplos sintéticos positivos/negativos e testes nos dois consumidores.
- Mock HTTP com autenticação do adaptador existente; rejeição de outra identidade, bot/conversa, conteúdo conflitante e versão antiga.
- Replay após perda de resposta recupera a operação, sem outra proveniência; concorrência do mesmo evento converge no mock.
- Referências humanas fora da projeção do modelo; texto/booleano não aprova compra. Pré-condições de aprovação validam conta, conteúdo, total, versão, prazo e escopo.
- Changes vinculam evento, mensagem/callback e versões, sem exigir texto integral; schema e testes rejeitam associação incoerente.
- Cancelamento tem resultado próprio e aponta para a operação original; política de prazo, parcialidade, erros seguros e compatibilidade está documentada.

## Limites

Mocks usam memória e transporte injetado. Não comprovam recuperação durável, implantação, Telegram real, avaliação de LLM ou integração de carrinho/envio. DATA-01/RUN-01/BOT-01 implementarão transações, outbox e handlers; CART-01/BUY-01/BUY-02 implementarão as ações controladas. DEC-01 continua com decisões de produto/metas pendentes. Não houve login, compra, alteração de credenciais ou configuração de produção.
