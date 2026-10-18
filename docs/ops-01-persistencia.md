# OPS-01 — Persistência dos vínculos iFood

Issue: [#6 OPS-01](https://github.com/Modo-Escuro/api-backend/issues/6) · Contrato do bot: [bot-api](bot-api.md)

Vínculos confirmados (metadados + tokens OAuth por vínculo) ficam em arquivos em `IFOOD_LINKS_DIR`. Eles só
sobrevivem a reinício e redeploy se esse diretório estiver num **volume persistente**. O sistema de arquivos do
container da Railway é efêmero: sem volume, todo redeploy apaga os vínculos.

## O que o código garante

| Garantia | Como |
| --- | --- |
| Gravação atômica e durável | Temporário exclusivo → `fsync` do arquivo → `rename` → `fsync` do diretório (`src/server/storage/durableFile.ts`). Queda em qualquer ponto deixa o arquivo anterior ou o novo inteiro. |
| Permissões | Diretório 700, arquivos 600, reaplicadas a cada gravação. |
| Ordem transacional na confirmação | Tokens novos → `links.json` → memória. Falha ⇒ rollback; vínculo anterior intacto; mesmo `confirmationId` continua válido (`LINK_STORAGE_FAILED`). |
| Leitura falha fechada | Só "arquivo inexistente" vale como "nenhum vínculo". `links.json` corrompido, ilegível, em versão desconhecida ou com nome de arquivo de token inválido ⇒ `503 LINK_STORAGE_UNAVAILABLE` em todas as rotas de vínculo e **nada é sobrescrito**. Depois de corrigir o arquivo, a próxima chamada carrega de novo, sem reiniciar. |
| Refresh token rotacionado | Gravado na hora. Se o disco falhar, os tokens novos seguem em memória (o anterior já foi invalidado pelo AS), a gravação é refeita no próximo uso e `/api/health` mostra `DEGRADED`. |
| Gravações concorrentes | Fila por arquivo; a última gravação é sempre a do estado mais recente; logout não é desfeito por gravação atrasada. |
| Temporários órfãos | Removidos na inicialização. |
| Isolamento por organizador | Um registro por organizador; organizador removido da allowlist não é carregado, mas seu registro é preservado. |
| Disco efêmero detectado | Railway sem volume (ou `IFOOD_LINKS_DIR` fora do volume) e Vercel ⇒ `EPHEMERAL`: aviso na inicialização, `/api/health/ready` = 503 e novas conexões recusadas com `503 LINK_STORAGE_NOT_DURABLE` antes do OAuth. Vínculos existentes continuam legíveis. |
| Logs | Só códigos (`EIO`, `LINKS_FILE_CORRUPT`); nunca caminho, conteúdo, tokens ou IDs. |

Classificação de durabilidade (`src/server/config.ts`, `resolveLinksStorage`):

| Ambiente detectado | `durability` | Novas conexões |
| --- | --- | --- |
| Railway + `RAILWAY_VOLUME_MOUNT_PATH` + diretório dentro do volume | `VOLUME` | Aceitas |
| Railway sem volume, ou diretório fora do volume | `EPHEMERAL` | Recusadas (salvo `IFOOD_LINKS_ALLOW_EPHEMERAL=true`) |
| Vercel | `EPHEMERAL` | Recusadas (salvo opt-in) |
| `NODE_ENV=production` em outra plataforma | `UNVERIFIED` | Aceitas, com aviso: a persistência depende da infraestrutura |
| Local | `LOCAL_DEV` | Aceitas |

## Configuração na Railway (serviço `api-backend`)

Dependência externa **não provisionada por este repositório**: o volume precisa ser criado no painel da Railway.

1. No serviço da API: **Settings → Volumes → New Volume**, mount path `/data`.
   A Railway passa a injetar `RAILWAY_VOLUME_MOUNT_PATH=/data`.
2. Variáveis do serviço:
   - `IFOOD_LINKS_DIR=/data/ifood-links` (recomendado deixar explícito; se vazio, o padrão já é `$RAILWAY_VOLUME_MOUNT_PATH/ifood-links`).
   - Não definir `IFOOD_LINKS_ALLOW_EPHEMERAL`.
   - Manter `PUBLIC_BASE_URL`/`IFOOD_REDIRECT_URI` com o HTTPS público cadastrado.
3. **Settings → Healthcheck Path**: `/api/health/ready`. Com isso, um deploy sem volume ou com `links.json` ilegível não
   fica ativo.
4. Manter **uma réplica**. O backend é um único processo; duas instâncias no mesmo diretório não são suportadas.
5. Depois do deploy, conferir no log `[links] armazenamento: durabilidade=VOLUME` e em `GET /api/health`:
   `"linksStorage": { "state": "OK", "durability": "VOLUME", "acceptingNewLinks": true }`.

O volume é só da API. **Não copiar o banco do bot (`/data` do serviço do bot) para o volume da API**, nem o contrário.

## Migração do deploy atual (sem volume)

O deploy atual guarda os vínculos em `.ifood-links` dentro do container. O próximo redeploy os apaga. Há dois caminhos:

**A. Preservar o vínculo existente** (exige shell no container em execução, antes de qualquer redeploy):

```bash
railway ssh --service api-backend          # shell no container atual
npm run links -- verify                    # contagens e permissões; não imprime tokens
npm run links -- backup --out /tmp/links-bak
```

Transferir `/tmp/links-bak` para um local privado (o backup contém tokens: tratar como segredo, nunca no Git, nunca
colado em chat). Depois de criar o volume e fazer o deploy com `IFOOD_LINKS_DIR=/data/ifood-links`:

```bash
railway ssh --service api-backend
npm run links -- verify-backup --from <backup>
npm run links -- restore --from <backup>  # só restaura em diretório vazio; nunca sobrescreve
npm run links -- verify
```

Em seguida, `POST /api/bot/ifood/verify` pelo bot confirma que a sessão continua operacional.

**B. Reconectar** (mais simples para a conta de teste): criar o volume, fazer o deploy e repetir uma vez o fluxo
Conectar → Confirmar no Telegram. Use B se o container atual já foi substituído por outro deploy — nesse caso o vínculo
anterior já se perdeu.

## Backup e restauração

| Comando | Efeito |
| --- | --- |
| `npm run links -- verify [--dir D]` | Formato, tokens referenciados presentes e permissões (exit 1 se algo estiver errado) |
| `npm run links -- backup --out <novo> [--dir D]` | Cópia consistente (relê e compara; repete se a API gravou no meio), arquivos 600, `MANIFEST.json` com hash SHA-256 e tamanho; recusa destino não vazio |
| `npm run links -- verify-backup --from <backup>` | Confere hashes, tamanhos e `links.json` |
| `npm run links -- restore --from <backup> [--to D]` | Verifica e restaura num diretório vazio (700/600), depois confere o resultado; recusa destino com arquivos |

Para substituir um diretório em uso: parar o serviço, mover o diretório atual para outro nome (manualmente), restaurar e
subir de novo. A ferramenta nunca apaga nem sobrescreve vínculos.

Saídas dos comandos têm só contagens e códigos. O conteúdo do backup é sensível (tokens OAuth em claro, como no
diretório original).

## Limitações

- Um processo e uma réplica. Tentativas de conexão pendentes (link aberto, confirmação aguardando) ficam em memória e
  se perdem no reinício; o organizador gera um link novo.
- Tokens não são criptografados em repouso; a proteção é o volume privado do serviço e as permissões 700/600.
- Na Railway, serviço com volume não sobe uma instância nova em paralelo com a antiga: há uma breve indisponibilidade
  em cada redeploy.
- Backup periódico não é automático. Fazer backup manual antes de mudanças de infraestrutura.
- Armazenamento transacional (banco) para compra/participantes fica para DATA-01/RUN-01; este formato atende só aos vínculos.
