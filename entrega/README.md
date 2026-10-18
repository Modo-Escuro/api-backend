# Entrega do hackathon

| Arquivo | Conteúdo |
| --- | --- |
| [entregaveis.tex](entregaveis.tex) | Documento com os seis entregáveis (proposta de negócio, desenho da solução, racional de UX, interface visual, documento técnico resumido e feedback sobre o MCP), anexos e fontes |
| [entregaveis-A.tex](entregaveis-A.tex) | Gera o PDF do cenário A: inclui a confirmação humana e a preparação do carrinho real |
| [entregaveis-B.tex](entregaveis-B.tex) | Gera o PDF do cenário B: MVP de leitura, com desafios e aprendizados no corpo do documento |
| [pitch.md](pitch.md) | Roteiros A e B, seis slides cada, demonstração só com capturas de tela, falas cronometradas e perguntas da banca |
| [imagens/](imagens/LEIAME.md) | Capturas reais do bot, com os nomes de arquivo esperados |

O PDF não exibe o nome do cenário. As diferenças estão só no conteúdo.

## Compilar no Overleaf

1. Envie a pasta `entrega/` inteira (inclusive `imagens/`) para um projeto novo: *New Project → Upload Project*, com a pasta compactada em `.zip`.
2. Em *Menu → Main document*, escolha `entregaveis-A.tex` ou `entregaveis-B.tex`. O compilador pode ser pdfLaTeX (padrão) ou XeLaTeX.
3. Clique em *Recompile* e baixe o PDF. Para gerar o outro cenário, troque o *Main document* e recompile.

Alternativa: compilar `entregaveis.tex` direto, editando a linha `\providecommand{\cenario}{B}` no topo.

Localmente, com TeX Live: `latexmk -pdf entregaveis-A.tex` e `latexmk -pdf entregaveis-B.tex`. Os dois cenários foram compilados com Tectonic (XeTeX) em 18/10/2026: 13 páginas cada, sem erros nem linhas estouradas.

**Antes de submeter, o PDF não pode ter:**
- **"CAPTURA PENDENTE"**: falta a imagem correspondente em `imagens/`;
- **"[A PREENCHER: …]" em vermelho**: dado a confirmar, como nomes dos integrantes, versões implantadas ou resultado do ensaio.

## Qual roteiro usar

Decidir com base **somente** no que estiver registrado no ensaio. Na dúvida, usar o B.

| # | Critério | Como verificar |
| --- | --- | --- |
| 1 | CART-01 mergeado na `main` (hoje: PR #46, rascunho) | GitHub |
| 2 | INT-02 validada com **respostas reais** do carrinho do iFood (hoje: PR #48 aberto; testes com respostas simuladas não contam) | Registro da validação |
| 3 | Confirmação da revisão por botão no Telegram (BOT-03) implantada | Commit implantado do bot |
| 4 | Ensaio humano completo aprovado, incluindo confirmação e carrinho preparado, sem pedido enviado | Registro sanitizado do ensaio (versões, data, resultado) |
| 5 | Capturas 01 a 07 obtidas nessa mesma versão, sem tela montada | Arquivos em `imagens/` e commits anotados no registro do ensaio |

**Todos sim → cenário A.** Qualquer não → **cenário B**. As melhorias de UX (menu, versão Ailo, login sem segundo clique) só aparecem nas capturas se estiverem implantadas; elas não decidem o cenário.

## Capturas obrigatórias

Capturas reais, com dados fictícios (Ana e Bia) e conta, e-mail, telefone e endereço ocultados. São as mesmas imagens do PDF (Seção 4) e da demonstração do pitch: não há vídeo. Nomes de arquivo em [imagens/LEIAME.md](imagens/LEIAME.md).

| Captura | Cenário A | Cenário B |
| --- | --- | --- |
| `01-conexao-ifood.png`: conexão com o iFood | obrigatória | obrigatória |
| `02-grupo-restricoes.png`: grupo, alergia e orçamento | obrigatória | obrigatória |
| `03-correcao-orcamento.png`: correção preservando a alergia | obrigatória | obrigatória |
| `04-propostas.png`: propostas com ofertas reais | obrigatória | se comprovada; senão, a resposta real exibida pelo bot (ajustar a legenda) |
| `05-revisao.png`: revisão com pendências | obrigatória | obrigatória |
| `06-confirmacao-humana.png`: confirmação da revisão | obrigatória | — |
| `07-carrinho-real.png`: carrinho preparado no iFood | somente se comprovado | — |
| `06-limites-pode-pedir.png`: resposta a "Pode pedir" | — | obrigatória |

## Pendências antes da submissão

- [ ] Nomes dos integrantes na capa.
- [ ] Versões implantadas do bot e do servidor (último registro: bot `9314c72`, servidor `28edd06`, de 18/10/2026; versões posteriores sem deploy registrado).
- [ ] Ensaio humano da jornada completa, com registro sanitizado. O checklist está no repositório do bot: `docs/ensaio-bot02-operacional.md`.
- [ ] Capturas da tabela acima, salvas em `imagens/`.
- [ ] Slides do pitch montados com as capturas e PDF de reserva dos slides.
- [ ] Preencher a coluna "Demonstrado" da tabela de estado (Seção 5.5) e a linha do ensaio no Anexo A.
- [ ] Cenário A apenas: data, versão e resultado da preparação do carrinho real.
- [ ] PRs abertos que podem mudar o texto: #46 (CART-01), #47 (confirmar endereço antes das sugestões), #48 (INT-02).
