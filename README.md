# Painel

Dashboard do servidor, monitor do sistema, projetos e favoritos.

## Requisitos

Docker com o Compose v2 (o comando `docker compose`). 

## Dia a dia

| Quero... | Faço |
| --- | --- |
| Adicionar ou mudar serviço, projeto ou favorito | Edito o YAML em `dados/` e recarrego a página. Não precisa de rebuild. |
| Mudar o código (`server.js` ou `public/`) | `docker compose up -d --build` |
| Ver o que está acontecendo | `docker logs -f painel` |
| Parar | `docker compose down` |

Se um YAML tiver erro, a página mostra a linha com problema e continua com a última versão que funcionou.

## Os arquivos de `dados/`

| Arquivo | O que guarda |
| --- | --- |
| `config.yaml` | nome da barra, discos do monitor, interfaces de rede, prefixo da rede local |
| `dashboard.yaml` | serviços do servidor: `name`, `descricao`, `url_tailscale`, `url_local`, `iconurl`, `tags` |
| `projetos.yaml` | projetos: `nome`, `icone`, `descricao`, `url_tailscale`, `url_local`, `repo`, `tags` |
| `bookmarks.yaml` | favoritos em categoria, lista e item |

Qualquer serviço ou projeto aceita `verificar: false` para não ser testado, ou `verificar_url` para testar outro endereço.

## DNS dinâmico: tailscale fora de casa, rede local em casa

Cada serviço e projeto tem dois endereços, mesma porta, IP diferente: `url_tailscale` (funciona de qualquer rede) e `url_local` (a rede de casa, direto, sem passar pelo Tailscale). O navegador decide sozinho qual usar: se o endereço pelo qual a própria página do Painel foi aberta começa com o `rede.prefixo_local` do `config.yaml` (por padrão `192.168.`), os cartões abrem por `url_local`; senão, por `url_tailscale`. Por isso é importante abrir o Painel sempre por um desses dois endereços (tailscale ou IP da rede de casa), nunca por um domínio ou proxy diferente, senão a detecção não tem como funcionar.

Um item com só `url` (formato antigo) continua funcionando nos dois casos. O teste de "está no ar" (que roda dentro do container, não no navegador) usa `verificar_url`, senão `url_local`, senão `url_tailscale`.

A aba Servidor nunca mostra o endereço do serviço, só o nome, a descrição e se está no ar.

