# Pitch — Compra com Contexto

Roteiros falados para o Hackathon SEMCOMP × iFood 2026: **roteiro A** (com a preparação do carrinho real) e **roteiro B** (MVP de leitura, desafios e aprendizados). A escolha segue os critérios em [README.md](README.md#qual-roteiro-usar). A demonstração é feita **só com capturas de tela reais**, as mesmas da seção "Interface visual" dos entregáveis. Os slides e as falas não citam "roteiro A/B".

## Regras comuns

| Item | Valor |
| --- | --- |
| Limite | **5:00**, com corte do microfone. Meta: terminar até **4:30** |
| Ritmo | ~130 palavras por minuto; as contagens abaixo foram medidas |
| Trocas de apresentador | 3 trocas (A→B, B→C, C→A), ~2 s cada = **6 s** |
| Demonstração | Capturas reais em `imagens/`, uma por vez, em tela cheia, com legenda curta no slide |
| Corte de emergência | Aos **4:15**, se o slide 6 não começou, dizer só a frase final |

**Ênfase:** problema, impacto para quem organiza e experiência de uso. Tecnologia aparece só no slide 4, em linguagem simples ("o sistema de ofertas do iFood", "a IA"). Os detalhes ficam para as perguntas.

**Honestidade:**
- Não dizer que um pedido foi enviado ou pago.
- Não dizer que um item é "seguro" para quem tem alergia.
- Apresentar a API de alérgenos como **proposta**.
- Narrar só o que está na captura exibida.

**Ferramentas de IA:** Claude Code e Codex foram ferramentas de desenvolvimento da equipe. O Gemini é a IA do produto. Não confundir os dois.

**Papéis:** A (produto), B (demonstração), C (viabilidade). A equipe preenche os nomes: A ____ · B ____ · C ____.

---

## Roteiro A — com preparação do carrinho real

### Slides

| # | Tempo | Objetivo | Na tela |
| --- | --- | --- | --- |
| 1 | 0:00–0:40 | Fazer sentir o problema | Balões de chat (ilustração identificada como tal): "Quem tem alergia mesmo?" · "Meu limite é R$ 40" · "Alguém fecha aí?"; Ana ⚠️ e Bia ✅ diante da mesma pizza |
| 2 | 0:40–1:10 | Mostrar a solução | Problema → **Ailo** → ninguém esquecido, conta clara, você decide |
| 3 | 1:10–2:19 | Demonstrar | Capturas 01 a 07, uma por vez, com legenda; selo fixo "Telas reais · dados fictícios" |
| 4 | 2:19–3:15 | Provar que é viável | "Login real no iFood" · "IA testada: 16/16" · "No ar" · "Carrinho só após confirmação" · rodapé "Proposta: API de ingredientes e alérgenos" · diagrama de 4 caixas (Figura 1 dos entregáveis) |
| 5 | 3:15–3:45 | Diferenciais e benefícios | "Cada pessoa avaliada" · "O que não se sabe é mostrado" · "Você confirma antes" |
| 6 | 3:45–3:53 | Fechar | "O grupo inteiro atendido, ninguém esquecido, você no controle." · QR do repositório |

### Falas

**Slide 1 · A**
> Pensa no último pedido de comida que você organizou para um grupo.
> Você abre o chat: quem vai comer? A Ana tinha alergia a quê mesmo? O limite da Bia era quarenta ou cinquenta?
> A pizzaria mais barata serve para a Bia. Mas ninguém sabe se o molho leva amendoim, e a Ana é alérgica.
> No chat, esse detalhe se perde. E o erro custa caro: a saúde de alguém, ou alguém sem comer sem ninguém perceber.
>
> Por isso criamos o Compra com Contexto.

**Slide 2 · A**
> É o Ailo, um assistente no Telegram que organiza o pedido do grupo no iFood.
> Você conta quem vai comer, as alergias e quanto dá para gastar. Ele lembra de cada pessoa, busca ofertas reais e mostra quem está atendido e quem não está.
> Quando falta informação, ele avisa em vez de arriscar. E nada vai para o carrinho sem você confirmar.
>
> Vou mostrar como funciona.

**Slide 3 · B**: uma captura por fala, avançando a tela ao fim de cada frase.

| Captura | Legenda no slide | Fala |
| --- | --- | --- |
| — | "Telas reais · dados fictícios" | "Estas são telas reais do Ailo, com dados fictícios." |
| `01-conexao-ifood.png` | Conta conectada | "Primeiro, o organizador conecta a conta pelo login oficial do iFood. De volta ao Telegram, a conta já aparece conectada." |
| `02-grupo-restricoes.png` | Uma mensagem, o grupo todo | "Uma frase só registra o grupo: Ana, com alergia a amendoim, Bia sem restrições e o orçamento de cento e oitenta reais." |
| `03-correcao-orcamento.png` | Correção sem recomeçar | "Mudou o orçamento? Basta dizer. O teto vira cento e cinquenta, e a alergia da Ana continua lá." |
| `04-propostas.png` | Ofertas reais, pessoa por pessoa | "Aqui ele buscou ofertas reais no iFood. Cada proposta mostra quem está atendido e avisa que a soma ainda não é o total." |
| `05-revisao.png` | Tudo o que falta confirmar | "Escolhida a proposta, a revisão mostra os itens, quem consome cada um e o que ainda falta confirmar." |
| `06-confirmacao-humana.png` | Você confirma | "Só com a confirmação do organizador, e só para esta revisão, o sistema prepara o carrinho." |
| `07-carrinho-real.png` | Carrinho preparado, nenhum pedido enviado | "E aqui está o carrinho preparado no iFood. O pedido e o pagamento continuam com a pessoa." |

**Transição:** "E isso já roda hoje." *(B passa para C.)*

**Slide 4 · C**
> O login com a conta iFood funciona pelo Telegram.
> A IA do produto foi testada com o modelo de verdade e acertou dezesseis de dezesseis situações, incluindo as críticas de alergia e de manipulação.
> O serviço está no ar, com limite de gasto, e o carrinho só é preparado depois da confirmação de uma pessoa.
> Para construir isso no hackathon, usamos Claude Code e Codex como assistentes de programação, revisão e testes; as decisões de produto e os testes com a conta foram nossos.
> Nosso maior aprendizado: o cardápio não informa alérgenos. A mentoria permitia simular dados, mas preferimos usar só dados reais. Por isso propomos ao iFood uma API de ingredientes e alérgenos, com fonte e data.

**Slide 5 · C**
> Três coisas nos diferenciam.
> Cada pessoa é avaliada com as próprias restrições, e ninguém é excluído em silêncio.
> O que a gente não sabe, a gente mostra: sem informação, o item fica "a verificar com a loja".
> E você confirma antes de qualquer coisa ir para o carrinho.
> Para quem organiza: menos coisa para lembrar, menos risco e menos tempo no chat.

**Slide 6 · A**
> Compra com Contexto: o grupo inteiro atendido, ninguém esquecido e você no controle. Obrigado!

### Tempo do roteiro A

| Bloco | Palavras | Tempo |
| --- | --- | --- |
| Slide 1 (com transição) | 84 | 0:39 |
| Slide 2 (com transição) | 66 | 0:30 |
| Slide 3: 7 capturas (com transição) | 148 | 1:08 |
| Slide 4 | 118 | 0:54 |
| Slide 5 | 62 | 0:29 |
| Slide 6 | 14 | 0:06 |
| Trocas | — | 0:06 |
| **Total** | **492** | **~3:53** |

Folga de ~37 s até 4:30. Se o ensaio passar de 4:20, cortar nesta ordem: a última frase do slide 5; a frase do slide 4 sobre o serviço no ar. A fala da API e a menção às ferramentas ficam.

---

## Roteiro B — MVP de leitura, desafios e aprendizados

### Slides

| # | Tempo | Objetivo | Na tela |
| --- | --- | --- | --- |
| 1 | 0:00–0:40 | Fazer sentir o problema | Igual ao roteiro A |
| 2 | 0:40–1:11 | Mostrar a solução | Problema → **Ailo** → ninguém esquecido, conta clara, você decide |
| 3 | 1:11–2:18 | Demonstrar | Capturas 01 a 06, uma por vez, com legenda; selo fixo "Telas reais · dados fictícios" |
| 4 | 2:18–2:59 | Mostrar o que já é real | "Login real no iFood" · "IA testada: 16/16" · "No ar, com regras de segurança" · diagrama de 4 caixas (Figura 1) |
| 5 | 2:59–3:53 | Desafios, aprendizados e feedback | "Carrinho: só com contrato seguro" · "IA: sugere, não decide" · "Dados: alérgenos não informados" · rodapé "Proposta: API de ingredientes e alérgenos" (contém · pode conter · não contém · não informado) |
| 6 | 3:53–4:06 | Próximos passos e fechamento | "Próximo: carrinho real com a sua confirmação" · QR do repositório |

### Falas

**Slide 1 · A**: mesmas falas do roteiro A, terminando em "Por isso criamos o Compra com Contexto."

**Slide 2 · A**
> É o Ailo, um assistente no Telegram que organiza o pedido do grupo no iFood.
> Você conta quem vai comer, as alergias e quanto dá para gastar. Ele lembra de cada pessoa, busca ofertas reais e mostra quem está atendido e quem não está.
> Quando falta informação, ele avisa em vez de arriscar. No fim, a decisão é sempre sua.
>
> Vou mostrar o que já funciona.

**Slide 3 · B**: uma captura por fala.

| Captura | Legenda no slide | Fala |
| --- | --- | --- |
| — | "Telas reais · dados fictícios" | "Estas são telas reais do Ailo, com dados fictícios." |
| `01-conexao-ifood.png` | Conta conectada | "Primeiro, o organizador conecta a conta pelo login oficial do iFood. De volta ao Telegram, a conta já aparece conectada." |
| `02-grupo-restricoes.png` | Uma mensagem, o grupo todo | "Uma frase só registra o grupo: Ana, com alergia a amendoim, Bia sem restrições e o orçamento de cento e oitenta reais." |
| `03-correcao-orcamento.png` | Correção sem recomeçar | "Mudou o orçamento? Basta dizer. O teto vira cento e cinquenta, e a alergia da Ana continua lá." |
| `04-propostas.png` | Ofertas reais, pessoa por pessoa | "Aqui ele buscou ofertas reais no iFood. Cada proposta mostra quem está atendido e avisa que a soma ainda não é o total." |
| `05-revisao.png` | Tudo o que falta confirmar | "Escolhida a proposta, a revisão mostra os itens, quem consome cada um e o que ainda falta confirmar. Nenhum pedido é enviado." |
| `06-limites-pode-pedir.png` | A decisão é sua | "E se eu peço para ele finalizar, ele explica que a decisão e o pedido continuam com o organizador." |

Se a captura 04 mostrar outra resposta real do bot (por exemplo, nenhuma proposta), trocar a fala por uma descrição fiel da tela e ajustar a legenda.

**Transição:** "O que vocês viram já é real." *(B passa para C.)*

**Slide 4 · C**
> O login com a conta iFood funciona pelo Telegram.
> A IA do produto foi testada com o modelo de verdade: dezesseis de dezesseis situações, incluindo as críticas de alergia e de manipulação.
> E o serviço está no ar, com uma regra central: a IA entende e sugere, mas quem decide são as regras do nosso servidor.
> Para construir isso no hackathon, usamos Claude Code e Codex como assistentes de programação, revisão e testes; as decisões de produto e os testes com a conta foram nossos.

**Slide 5 · C**: desafios e aprendizados (~35 s), depois a proposta (~15 s).
> Três desafios marcaram o projeto.
> O carrinho: as ferramentas ainda não informam o formato da resposta nem evitam pedido duplicado. A preparação com a sua confirmação está em revisão, e preferimos não mostrar o que ainda não validamos.
> A IA: nos testes, ela às vezes cortava respostas ou liberava alguém cedo demais. O erro era nosso, e corrigimos com regras no servidor.
> E os dados: o cardápio não informa alérgenos.
> O maior aprendizado: um bom assistente precisa saber dizer "não sei".
> A mentoria permitia simular dados, mas preferimos usar só dados reais. Por isso propomos ao iFood uma API de ingredientes e alérgenos, com fonte e data, que separe "não contém" de "não informado".

**Slide 6 · A**
> Próximos passos: o carrinho real com a sua confirmação e testes com grupos de verdade.
> Compra com Contexto: o grupo inteiro atendido, ninguém esquecido e você no controle. Obrigado!

### Tempo do roteiro B

| Bloco | Palavras | Tempo |
| --- | --- | --- |
| Slide 1 (com transição) | 85 | 0:39 |
| Slide 2 (com transição) | 66 | 0:30 |
| Slide 3: 6 capturas (com transição) | 140 | 1:05 |
| Slide 4 | 85 | 0:39 |
| Slide 5 | 114 | 0:53 |
| Slide 6 | 29 | 0:13 |
| Trocas | — | 0:06 |
| **Total** | **519** | **~4:06** |

Folga de ~24 s até 4:30. Se o ensaio passar de 4:25, cortar nesta ordem: a captura 06 e sua fala; a frase sobre a IA no slide 5. A fala da API, a menção às ferramentas e o bloco de desafios ficam.

---

## Se houver problema técnico na exibição

| Situação | Ação (≤ 5 s) | Fala de ponte |
| --- | --- | --- |
| Arquivo de slides não abre | Abrir o PDF de reserva com as mesmas capturas (pendrive ou e-mail) | "Um instante, vou abrir a cópia." |
| Projetor sem imagem | Seguir com a narração do slide 3, descrevendo cada tela | "Vou descrever as telas enquanto o projetor volta." |
| Captura ilegível no telão | Ler o trecho principal da tela | — |

## Perguntas prováveis da banca

Respostas de 20 a 40 s. Responder primeiro, detalhar depois.

**1. Por que o pedido não é enviado automaticamente? (A)**
> As ferramentas de carrinho do iFood ainda não informam o formato da resposta nem evitam pedido duplicado. Se a conexão cair, ninguém sabe se algo foi feito. Por isso qualquer escrita no iFood exige a confirmação do organizador, vale uma vez só, e o envio do pedido e o pagamento ficam com a pessoa.

**2. *(roteiro B)* Por que o carrinho real não aparece na demonstração? (A)**
> A decisão de ir até o carrinho com confirmação humana está tomada e o código está em revisão. Falta validar as respostas reais do carrinho do iFood. Preferimos mostrar o que validamos a arriscar um pedido errado ou duplicado.

**3. Por que não simularam os dados que faltavam? (A)**
> Porque o que faltava era informação de segurança. Simular alérgenos deixaria a demonstração mais bonita, mas mostraria uma segurança que nenhuma fonte confirmou. Usamos dados reais e transformamos a lacuna numa proposta de API ao iFood.

**4. Se o iFood não informa alérgenos, o produto serve para quem tem alergia? (A)**
> Serve para não esquecer a alergia e não recomendar o que o cardápio indica como incompatível. Sem informação, o item fica "a verificar com a loja" para aquela pessoa. Com a API que propomos, o sistema poderia liberar itens mostrando quem declarou e quando, sem prometer risco zero.

**5. Como garantem que a IA não ignora uma alergia? (C)**
> A IA não decide: ela sugere ações de uma lista fechada, e o servidor confere cada uma. Alergia é sempre obrigatória, e tirar uma restrição exige confirmação do organizador. Testamos tentativas de manipulação, inclusive texto malicioso vindo do cardápio, e corrigimos um caso em que a IA liberava alguém sem confirmação.

**6. Vocês usaram IA para programar? O que foi da equipe? (C)**
> Sim, usamos Claude Code e Codex como assistentes, o que o hackathon permitia: para escrever código, revisar, criar testes e documentar. As decisões de produto, o que entrava ou não, a revisão de cada mudança e os testes com a conta real foram da equipe. A IA que o usuário encontra no produto é outra, o Gemini.

**7. Quem pagaria por isso? (A)**
> Vemos isso como uma funcionalidade do próprio iFood: pedidos de grupo tendem a ter valor maior, e reduzir a coordenação pode juntar vários pedidos num só. É uma hipótese; não medimos conversão. O próximo passo seria testar com grupos reais.

**8. O que foi limitação do iFood e o que foi erro de vocês? (C)**
> Do lado do iFood, faltam dados: alérgenos, taxa de serviço e um contrato claro para o carrinho; houve também uma indisponibilidade pontual. Do nosso lado, erramos a configuração da IA, que cortava respostas, uma regra que liberava alguém cedo demais e um ranking que bloqueava opções válidas. Corrigimos todos com testes.

**9. Por que Gemini? Quanto custa? (C)**
> No nosso teste, o Gemini 3.8 Flash acertou 16 de 16 situações, com resposta da IA em cerca de 3 segundos, e a rodada custou cerca de um centavo e meio de dólar. Há limite de chamadas e de gasto: se estourar, o sistema para antes de chamar a IA, sem perder nada.

**10. E a privacidade? (C)**
> O acesso à conta iFood fica só no servidor; nunca vai para o bot, para a IA ou para os registros. Os registros não guardam nomes, alergias ou endereço. Os dados da compra são apagados ao encerrar ou após 24 horas sem uso.

**11. Por que Telegram? (A)**
> É onde grupos já combinam pedidos, e permite botões para as confirmações. Toda a inteligência está no servidor, então a mesma lógica poderia ir para o app do iFood.

## Checklist de ensaio

- [ ] Roteiro escolhido (A ou B) conforme o [README](README.md#qual-roteiro-usar).
- [ ] Todas as capturas do roteiro existem em `imagens/` e são legíveis no telão.
- [ ] As falas do slide 3 descrevem exatamente o que aparece em cada captura.
- [ ] Três rodadas cronometradas: ____ / ____ / ____ (nenhuma acima de 4:30).
- [ ] Corte aos 4:15 ensaiado.
- [ ] PDF de reserva com os slides testado em outro computador.
- [ ] Perguntas respondidas em voz alta, cada uma ≤ 40 s.
- [ ] Nenhuma fala diz "seguro", "pedido enviado" ou "pagamento feito"; a API de alérgenos é dita como proposta.
- [ ] Claude Code e Codex citados como ferramentas de desenvolvimento, não como parte do produto.
- [ ] Nenhum dado pessoal ou credencial visível nas capturas.
