# Revisão da branchBruna e integração ao plano conversacional

> Revisão histórica do SHA abaixo. Pendências/arquivos descrevem aquela base; a árvore reconciliada tem [assistente](../assistente-conversacional.md), [v6](../armazenamento-v6.md) e [legado retirado](../retirada-legado.md). Este parecer não verifica o serviço atual; seus achados/resultados mantêm a proveniência original.

## Referência e alcance

Repositório: `Modo-Escuro/api-backend`. Head revisado: `8393615d4c140f9d06501033cba9069fcbd3a19f`; base `main`: `686300d1a10c12bb6c3bd899e40fbd3a68c648f5`. A comparação mostrou um commit à frente, zero atrás e 13 arquivos alterados. Referências são um retrato desta revisão, não acompanhamento contínuo.

[Diff revisado](https://github.com/Modo-Escuro/api-backend/compare/686300d1a10c12bb6c3bd899e40fbd3a68c648f5...8393615d4c140f9d06501033cba9069fcbd3a19f).

Inspeção estática, verificações locais e reproduções sintéticas em cópia temporária isolada. Nenhuma chamada de negócio ao iFood, alteração de Railway, merge ou publicação. Este documento complementa o planejamento do bot/API atuais; não modifica retroativamente o baseline do protótipo Python.

## Atualização de planejamento

O [plano atual](../plano-conversacional.md) transforma os achados em issues. Após esta revisão identificou-se a branch F7 b08957d, com preparação de carrinho e checkout bloqueado; sua auditoria e integração estão planejadas, sem alterar retroativamente os achados do ranking.

## Parecer

Aproveitar a branch como componente de avaliação e ranking de itens, após corrigir os problemas abaixo. Ela ainda não implementa compra coletiva, memória de conversa, agente LLM, carrinho, aprovação de compra ou envio. Não recomendar integração sem ressalvas apenas porque os testes existentes passam em outro ambiente.

Ganhos concretos:

- Ranking puro e determinístico, sem novas chamadas remotas ou ferramentas de escrita.
- Elegibilidade antes da pontuação; itens incompatíveis e com dados obrigatórios insuficientes não entram nas recomendações.
- Categorias `ELIGIBLE`, `BLOCKED` e `NEEDS_VERIFICATION`, explicações, pesos e limitações expostos.
- Contrato em centavos preservado nos novos conjuntos da resposta.
- Testes de domínio, pipeline e contrato HTTP acrescentados.

## Achados e mudanças sugeridas

### R1 — P1 para a integração: preferência opcional pode bloquear um candidato

**Origem: herdado da main**, não introduzido por Bruna. A nova documentação promete que preferências não mudam elegibilidade, mas isso só é coberto pelos testes para o novo objeto `preferences`.

`blockedOptions` reúne opções de todas as restrições, inclusive `requirement: PREFERENCE`. `evaluateCandidate` passa esse conjunto à configuração mínima e transforma a impossibilidade de configurá-la em `NO_VALID_CONFIGURATION`.

Reprodução: grupo obrigatório com uma opção de bacon; sem restrições, candidato elegível; adicionar `DIETARY/VEGAN/PREFERENCE` torna o mesmo candidato bloqueado. A preferência virou condição obrigatória.

Correção: calcular viabilidade com restrições obrigatórias; preferências podem favorecer outra configuração viável e gerar avisos, mas não eliminar a única configuração permitida pelas regras obrigatórias. Acrescentar testes pelos dois canais: `restrictions[].requirement=PREFERENCE` e `preferences`.

[Uso das opções bloqueadas](https://github.com/Modo-Escuro/api-backend/blob/8393615d4c140f9d06501033cba9069fcbd3a19f/src/server/domain/eligibility.ts#L137) · [União sem distinguir obrigatoriedade](https://github.com/Modo-Escuro/api-backend/blob/8393615d4c140f9d06501033cba9069fcbd3a19f/src/server/domain/constraints.ts#L340).

### R2 — P2: a pontuação considera adicionais que não compõem o preço exibido

**Origem: ranking novo.** `textCorpus` mistura nome da loja, item e todas as opções. O preço usa a configuração selecionada ou mínima. Assim, a explicação e o preço podem se referir a composições diferentes.

Reprodução: prato de R$ 20 com bacon opcional de R$ 10; configuração mínima sem adicionais. O ranking atribui preferência por bacon igual a 1, mantendo o preço de R$ 20 e `options: []`.

Correção: pontuar a configuração efetivamente avaliada. Uma alternativa com adicional precisa ser outra configuração, com preço e restrições recalculados. Nome da loja não deve comprovar ingrediente do item.

[Corpus do ranking](https://github.com/Modo-Escuro/api-backend/blob/8393615d4c140f9d06501033cba9069fcbd3a19f/src/server/domain/ranking.ts#L199).

### R3 — P2: negação e informação ausente geram preferências enganosas

**Origem: ranking novo.** `mentions` procura palavras sem interpretar negação. Ausência de termo também recebe pontuação positiva em `avoidedIngredients`.

Reproduções:

- Descrição “Sem bacon”: gostar de bacon recebe 1; evitar bacon recebe 0.
- Item sem descrição e sem evidência de ingredientes: evitar bacon recebe 1.

Isso não libera uma alergia no código atual, mas prejudica recomendação e explicação. Correção: reconhecer negações, distinguir ausência de menção de evidência favorável e usar `NO_DATA` quando não houver sustentação. Manter a barreira de segurança alimentar independente da heurística de preferência.

[Correspondência de texto](https://github.com/Modo-Escuro/api-backend/blob/8393615d4c140f9d06501033cba9069fcbd3a19f/src/server/domain/ranking.ts#L208) · [Pontuação por ingrediente](https://github.com/Modo-Escuro/api-backend/blob/8393615d4c140f9d06501033cba9069fcbd3a19f/src/server/domain/ranking.ts#L287).

### R4 — P2: prioridade ECONOMY favorece preço unitário, não necessariamente menor desembolso

**Origem: política do ranking novo.** `PRICE` usa preço por unidade; frete entra em `DELIVERY`, misturado com tempo. Dobrar PRICE não equivale a minimizar o custo da compra.

Reprodução com mesma quantidade, avaliação e prazo: A custa R$ 10 + R$ 20 de frete; B custa R$ 20 + frete zero. Com ECONOMY, A fica primeiro (score 0,7917), embora totalize R$ 30 contra R$ 20 de B (0,2083).

Correção: definir se prioridade significa preferência ponderada ou ordenação estrita. Para economia, comparar custo total da configuração/plano, incluindo quantidade e custos suportados. Para rapidez, separar tempo de frete. Custos desconhecidos e faixas devem permanecer explícitos; ponto médio não é promessa de orçamento nem cotação final.

[Preço usado pelo ranking](https://github.com/Modo-Escuro/api-backend/blob/8393615d4c140f9d06501033cba9069fcbd3a19f/src/server/domain/ranking.ts#L214) · [Mistura de frete e tempo](https://github.com/Modo-Escuro/api-backend/blob/8393615d4c140f9d06501033cba9069fcbd3a19f/src/server/domain/ranking.ts#L390).

### R5 — P1 antes da conversa: distinguir limites obrigatórios de preferências de contexto

**Origem: lacuna do contrato existente, tornada mais relevante pelo novo critério CONTEXT.** Distância, prazo e taxa são encaminhados ao provedor como filtros; o ranking local apenas atribui notas, sem bloquear violação ou dado ausente. As justificativas usam a palavra “permitidos”.

Reprodução local: prazo de 60 minutos e frete de R$ 15 continuam recomendáveis com contexto de no máximo 30 minutos/R$ 5. Isso demonstra ausência de validação local; não demonstra que o iFood desrespeitou filtros em uma chamada real.

Correção: distinguir no estado da conversa um limite obrigatório de uma preferência. Validar localmente limites obrigatórios antes do ranking e bloquear dado essencial desconhecido. Se o campo for só preferência, a interface não pode apresentá-lo como garantia.

[Critério de contexto](https://github.com/Modo-Escuro/api-backend/blob/8393615d4c140f9d06501033cba9069fcbd3a19f/src/server/domain/ranking.ts#L320).

### R6 — P2: mudança de contrato deve ser explícita

Na main, `blocked` reúne todos os não elegíveis. Na branch, parte deles muda para `needsVerification`. Isso muda a semântica de um campo existente; consumidores que só leem `eligible` e `blocked` podem omitir itens e motivos. O bot atual ainda não consome `/api/evaluate`, portanto não foi observado um defeito nele.

Correção: versionar/documentar o contrato e adaptar consumidores juntos; testar que todas as categorias são apresentadas. `NEEDS_VERIFICATION` continua impedido de compra e não deve virar “pode continuar por sua conta”.

[Particionamento da resposta](https://github.com/Modo-Escuro/api-backend/blob/8393615d4c140f9d06501033cba9069fcbd3a19f/src/server/services/evaluate-view.ts#L137).

### Ajustes menores e decisões de ranking

- `classifyBlockers([NOT_DETAILED, código desconhecido])` retorna `NEEDS_VERIFICATION`, contrariando a regra documentada de código desconhecido resultar em `BLOCKED`. Ambos ficam fora do ranking; é inconsistência de classificação, não autorização indevida. Testar a combinação e definir precedência explícita.
- Redistribuir pesos por candidato quando faltam dados pode premiar informação incompleta. Política documentada não equivale a política validada: incluir cobertura da evidência e avaliar casos em que retirar um dado ruim melhora a posição. Não apresentar score como probabilidade de satisfação ou segurança.
- Manter min–max como nota relativa ao conjunto consultado: páginas, limites e candidatos diferentes podem mudar notas. Não comparar percentuais entre consultas como se fossem absolutos.
- Antes de compra, migrar os cálculos internos de BRL decimal para centavos inteiros, com arredondamento explícito na entrada. O problema antecede a branch.
- `CLAUDE.md` e `docs/requirements.md` ainda descrevem recomendação sem checkout, localhost e regras antigas de UNKNOWN/“ignorar restrição”. Atualizar a documentação para distinguir incremento atual, objetivo final e regras vigentes; preservar o histórico. A aprovação humana e o bloqueio alimentar do projeto não podem ser removidos para adequar o plano a documentos antigos.

## Encaixe no planejamento

| Ordem | Trabalho | Aproveitamento da branch | Critério de aceite |
| --- | --- | --- | --- |
| 1 | Preservar e persistir vínculos da API | Não resolvido pela branch | Migração privada e reinício preservam vínculo; recuperação ensaiada |
| 2 | Corrigir avaliação/ranking e alinhar contrato | Integrar funções puras, categorias, explicações e testes corrigidos | Preferência não bloqueia; preço e explicação usam mesma configuração; contrato de categorias validado |
| 3 | Estado de compra e avaliação por pessoa | Reutilizar avaliação de itens como componente | Participante tem identidade estável, condições e origem; restrições desconhecidas não são apagadas |
| 4 | Conversa útil e persistente | IA usa resultados estruturados, sem recalcular elegibilidade | Mudança de orçamento preserva restrições; reinício recupera turno; resultado atrasado não sobrescreve versão atual |
| 5 | Propostas coletivas | Reutilizar sinais do ranking, sem aplicar top-4 cedo demais | Cobertura por pessoa e custo agregado validados; propostas completas ranqueadas antes de exibir até quatro |
| 6 | Carrinho, revisão, aprovação e envio | Nenhuma dessas capacidades está nesta branch | Aprovação vinculada a responsável/conta/versão/total/validade; mudança invalida; timeout desconhecido exige reconciliação |

A investigação dos contratos externos de carrinho, envio e consulta deve começar durante as primeiras etapas, sem aguardar o fim da conversa. A implementação de checkout permanece bloqueada até suas proteções e contratos existirem.

Para o grupo, não juntar todas as restrições em uma única lista aplicada a todos os itens. Construir matriz participante × configuração, atribuir quantidades/pessoas e avaliar a composição completa. Itens compartilhados precisam atender a todas as pessoas que os consumirão. Busca por perfis deve preservar a origem dos filtros que sustentam cada evidência; não reutilizar como prova para outra consulta.

Não somar estimativas de pedidos individuais com um frete em cada uma: custos comuns pertencem ao plano da compra. Política de rateio, restaurante único e cobertura parcial continuam decisões explícitas. Nunca excluir silenciosamente uma pessoa para viabilizar a recomendação.

Separar o conjunto interno de candidatos do limite visual de quatro recomendações: truncar antes da composição pode eliminar a única opção que atende alguém. O ranking do item auxilia; não substitui o ranking de propostas completas.

## Verificações realmente executadas

- `npm ci --ignore-scripts --no-audit --no-fund` na cópia temporária.
- `npm run typecheck`: passou.
- `npm run lint`: passou.
- `npm test`: execução inicial sofreu EPERM de sandbox; repetição com acesso normal terminou com **237 aprovados e 2 falhas, 239 no total**.
- As duas falhas estão em `test/links/storage.test.ts`, comparando modos POSIX `0700` com o resultado do Windows. Arquivo e implementação correspondentes não foram alterados pela branch. Não afirmar suíte integralmente verde neste ambiente; executar Linux e tratar portabilidade das asserções separadamente.
- Sete probes sintéticos executados: custo total versus ECONOMY; adicional não selecionado; negação; descrição ausente; limites de contexto; classificação mista; preferência opcional que bloqueia. São reproduções diagnósticas, não ensaio de compra real.
- Nenhum teste online, token real, polling do bot ou operação de compra foi utilizado nesta revisão.

## Revisão final do plano

Adotar a branch como avanço parcial da recomendação, com correções. Antecipar integridade das preferências, semântica de limites e custo agregado; manter persistência e contrato de conversa como dependências próprias. Evitar reescrever o ranking dentro do LLM. A IA interpreta e explica; a API conserva o acordo, valida evidências e controla a execução.
