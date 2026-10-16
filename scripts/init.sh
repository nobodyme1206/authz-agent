#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
# Parent directory protects credentials on the host; individual files must be
# readable by the non-root containers receiving a read-only secret mount.
mkdir -p .secrets
chmod 700 .secrets
for name in db_password internal_token; do
  if [ ! -s ".secrets/$name" ]; then openssl rand -hex 32 > ".secrets/$name"; fi
done
if [ ! -f .secrets/model_api_key ]; then : > .secrets/model_api_key; fi
chmod 644 .secrets/db_password .secrets/internal_token .secrets/model_api_key
if [ ! -f .env ]; then cp .env.example .env; fi
printf '本地配置已准备；密钥不会写入镜像或 Git。\n'
