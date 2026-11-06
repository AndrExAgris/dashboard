.PHONY: help up down restart clean update logs status reload

# Serviço específico para logs/restart: make logs S=exemplo-node
S ?=

help:
	@echo "  make up       - sobe os containers (builda se necessário)"
	@echo "  make down     - para e remove os containers"
	@echo "  make restart  - reinicia (down + up)"
	@echo "  make clean    - para os containers e apaga as imagens locais"
	@echo "  make update   - baixa a última versão do repositório e reconstrói"
	@echo "  make logs     - acompanha os logs em tempo real (S=nome para um só)"
	@echo "  make status   - mostra se os containers estão rodando"
	@echo "  make reload   - testa e recarrega o nginx depois de editar o nginx/default.conf"

up:
	docker compose up -d --build

down:
	docker compose down

restart: down up

clean:
	docker compose down --rmi local

update:
	git pull
	docker compose up -d --build

logs:
	docker compose logs -f $(S)

status:
	docker compose ps

reload:
	docker compose exec nginx nginx -t
	docker compose exec nginx nginx -s reload
