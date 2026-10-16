.PHONY: init up test test-postgres stop
init:
	./scripts/init.sh
up: init
	docker compose up --build -d
test:
	docker compose run --rm --no-deps api python -m pytest -q -p no:cacheprovider
	docker compose run --rm --no-deps agent-worker npm run typecheck
	docker compose run --rm --no-deps agent-worker npm test
test-postgres:
	sh scripts/test-postgres.sh
stop:
	docker compose down
