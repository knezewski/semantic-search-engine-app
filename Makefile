# Semantic Document Retrieval Engine — Makefile
# Stack: Redis + Qdrant (Docker) + Bun (API/workers).

# NOTE: do NOT `-include .env` / `export` here. Bun already loads .env itself
# and strips quotes; Make does not, so exporting raw values would inject
# literal quotes (e.g. REDIS_URL='') and break Redis/Qdrant connections.

COMPOSE := docker compose -f docker/docker-compose.yml

.PHONY: help setup infra-init infra-up start start-infra build stop prune restart test api worker redis redisinsight clean

help: ## show available commands
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(firstword $(MAKEFILE_LIST)) | awk 'BEGIN {FS = ":.*?## "}; {printf "  make %-14s %s\n", $$1, $$2}'

setup: ## copy .env and install dependencies
	@test -f .env || cp .env.example .env
	bun install

# db-init equivalent: full infrastructure reset and recreate.
infra-init: ## drop volumes and recreate Redis + Qdrant
	make stop
	$(COMPOSE) down -v || true
	$(COMPOSE) up -d
	@echo "Waiting for Redis to be ready..."
	@until docker exec semantic-redis redis-cli ping 2>/dev/null | grep -q PONG; do sleep 2; done
	@echo "Redis is ready!"
	@echo "Waiting for Qdrant to be ready..."
	@until docker exec semantic-qdrant bash -c 'echo > /dev/tcp/127.0.0.1/6333' 2>/dev/null; do sleep 2; done
	@echo "Qdrant is ready!"

build: ## build (type-check) and prune docker
	bun install
	bun run build
	docker system prune -f

start: ## bring up infrastructure + API + workers (Ctrl+C stops everything)
	make infra-up
	@mkdir -p .run
	@trap 'kill 0; rm -f .run/api.pid .run/worker.pid' INT TERM EXIT; \
	bun run dev & echo $$! > .run/api.pid; \
	bun run dev:worker & echo $$! > .run/worker.pid; \
	wait

infra-up: ## start Redis + Qdrant + RedisInsight
	$(COMPOSE) up -d

start-infra: infra-up ## alias: start infrastructure only

stop: ## gracefully stop API, workers, and infrastructure
	@for pid_file in .run/api.pid .run/worker.pid; do \
		if [ -f "$$pid_file" ]; then kill -TERM "$$(cat "$$pid_file")" 2>/dev/null || true; fi; \
	done
	@timeout=0; \
	while [ "$$timeout" -lt 10 ]; do \
		alive=0; \
		for pid_file in .run/api.pid .run/worker.pid; do \
			if [ -f "$$pid_file" ] && kill -0 "$$(cat "$$pid_file")" 2>/dev/null; then alive=1; fi; \
		done; \
		if [ "$$alive" -eq 0 ]; then break; fi; \
		sleep 1; \
		timeout=$$((timeout + 1)); \
	done
	@for pid_file in .run/api.pid .run/worker.pid; do \
		if [ -f "$$pid_file" ] && kill -0 "$$(cat "$$pid_file")" 2>/dev/null; then \
			kill -KILL "$$(cat "$$pid_file")" 2>/dev/null || true; \
		fi; \
	done
	@rm -f .run/api.pid .run/worker.pid
	$(COMPOSE) down

prune: ## remove unused docker resources
	docker system prune -f

restart: ## restart the whole stack
	make stop
	sleep 5
	make start

test: ## run tests
	bun test src

api: ## run API only (foreground)
	bun run dev

worker: ## run workers only (foreground)
	bun run dev:worker

redis: ## open redis-cli
	$(COMPOSE) exec redis redis-cli

redisinsight: ## open RedisInsight in the browser
	@open http://localhost:5540

clean: ## stop and remove volumes (data)
	$(COMPOSE) down -v
