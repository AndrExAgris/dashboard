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
| `config.yaml` | nome da barra, discos do monitor, interfaces de rede |
| `dashboard.yaml` | serviços do servidor: `name`, `descricao`, `url`, `iconurl`, `tags` |
| `projetos.yaml` | projetos: `nome`, `icone`, `descricao`, `url`, `repo`, `tags` |
| `bookmarks.yaml` | favoritos em categoria, lista e item |

Qualquer serviço ou projeto aceita `verificar: false` para não ser testado, ou `verificar_url` para testar outro endereço.

