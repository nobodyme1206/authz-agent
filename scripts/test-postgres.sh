#!/bin/sh
set -eu
# Refuse to overwrite an existing database. Only clean up after createdb succeeds.
docker compose exec -T db createdb -U authz authz_batch1_test
trap 'docker compose exec -T db dropdb -U authz authz_batch1_test' EXIT
docker compose run --rm --no-deps -e AUTHZ_TEST_POSTGRES=1 api python -m pytest -q -p no:cacheprovider
