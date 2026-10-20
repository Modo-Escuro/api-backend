# Compra com Contexto — API

API Node/TypeScript e Hono do bot Telegram. A árvore local oferece login/vínculos, fila durável, memória seletiva, domínio em centavos, ranking e propostas. Referências remotas datadas ficam em [estado remoto/local](docs/estado-remoto-local.md); esta documentação não é monitoramento do serviço implantado.

O [assistente conversacional](docs/assistente-conversacional.md) é o único processador na árvore local, instalado por opt-in do modelo. Recebe pedidos naturais, planeja consultas iFood e apresenta resultados com prévia progressiva no Telegram. Ofertas alimentares elegíveis podem virar propostas persistidas; a escolha digitada seleciona a sacola DATA-01. Envio/pagamento ainda dependem de BUY-01/BUY-02.

- [Estado remoto e alterações locais](docs/estado-remoto-local.md)
- [Decisões vigentes — carrinho real com confirmação humana](docs/decisoes-conversacionais.md)
- [Plano de execução e pendências](docs/plano-conversacional.md)
- [Índice técnico](docs/README.md)
- [Contrato HTTP de conversa e sessão](docs/conversation-api-v1.md), [SQLite v6](docs/armazenamento-v6.md) e [reconciliação GitHub](docs/sincronizacao-github.md)

O código local inclui a [CART-01](docs/cart-01-escrita-confirmada.md): preparação de itens do carrinho real após revisão e confirmação humana PREPARE_CART, desligada por padrão. A ativação exige evidência externa INT-02 e callback BOT-03 validado; código local não comprova merge ou deploy. A F7 legada foi retirada, assim como o modo structured, o painel React e a sessão global; ver [migração](docs/retirada-legado.md). Login, senha e texto do agente não autorizam escrita. Envio de pedido e pagamento continuam proibidos neste incremento.

Código integrado não comprova configuração operacional, deploy nem conversa completa no Telegram. As evidências históricas continuam identificadas nos documentos de cada incremento.

## Desenvolvimento

Node 22.13+; configuração explícita no ambiente (modelo desativado por padrão). Use `.env.example` como referência, sem copiar tokens entre contas.

```bash
npm install
npm run dev        # Hono :8000; interface pelo Telegram
npm run typecheck
npm run lint
npm test
npm run build      # validação TypeScript; execução via tsx
```

`GET /` e `GET /callback` mantêm o retorno OAuth do vínculo, com página de conclusão no navegador. Tokens são persistidos exclusivamente por vínculo em `IFOOD_LINKS_DIR`.
