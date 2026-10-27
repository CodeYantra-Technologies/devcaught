#!/usr/bin/env bash
set -euo pipefail
set +x
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.."
docker info --format '{{.ServerVersion}}' >/dev/null
export DEVCAUGHT_SETUP_UID="$(id -u)" DEVCAUGHT_SETUP_GID="$(id -g)"
export DEVCAUGHT_AUTH_SECRET_DIR="$HOME/.local/share/devcaught/auth-dev-secrets"
# List metadata only. Do not inspect container environment or volume contents.
containers="$(docker container ls -a --format '{{.Names}}')"
volumes="$(docker volume ls --format '{{.Name}}')"
networks="$(docker network ls --format '{{.Name}}')"
project_resources="$(docker container ls -a --filter label=com.docker.compose.project=devcaught-auth-dev --format '{{.Names}}')"
project_volumes="$(docker volume ls --filter label=com.docker.compose.project=devcaught-auth-dev --format '{{.Name}}')"
project_networks="$(docker network ls --filter label=com.docker.compose.project=devcaught-auth-dev --format '{{.Name}}')"
for item in devcaught-pg-dev; do
  if [[ $'\n'"$containers"$'\n' == *$'\n'"$item"$'\n'* ]]; then echo "BLOCKED: container name conflict: $item"; exit 1; fi
done
if [[ $'\n'"$volumes"$'\n' == *$'\n'devcaught_pg_dev_data$'\n'* ]] ||
   [[ $'\n'"$networks"$'\n' == *$'\n'devcaught_pg_dev_net$'\n'* ]] ||
   [[ -n "$project_resources$project_volumes$project_networks" ]] || [[ -e "$DEVCAUGHT_AUTH_SECRET_DIR" ]] || [[ -L "$DEVCAUGHT_AUTH_SECRET_DIR" ]]; then
  echo 'BLOCKED: dedicated resource, project or credential directory already exists; nothing will be reused.'; exit 1
fi
node --input-type=module -e "import('pg'); import('kysely')" >/dev/null
# Pull before creation: setup container has no outbound network.
docker pull postgres:16-bookworm
docker pull node:22-bookworm-slim
umask 077
mkdir -p -- "$(dirname -- "$DEVCAUGHT_AUTH_SECRET_DIR")"
mkdir -m 700 -- "$DEVCAUGHT_AUTH_SECRET_DIR"
node --input-type=module <<'NODE'
import {randomBytes} from 'node:crypto';
import {writeFileSync} from 'node:fs';
for (const name of ['admin_password', 'owner_password', 'app_password', 'better_auth_secret']) {
  writeFileSync(`${process.env.DEVCAUGHT_AUTH_SECRET_DIR}/${name}`, randomBytes(32).toString('hex'), {mode: 0o600, flag: 'wx'});
}
NODE
compose=(docker compose --env-file /dev/null -p devcaught-auth-dev -f compose.postgres-dev.yaml)
"${compose[@]}" config --quiet
"${compose[@]}" up -d --no-deps --wait --wait-timeout 120 postgres-dev
"${compose[@]}" run --rm --no-deps setup
"${compose[@]}" ps postgres-dev
echo 'Database setup complete. Application unchanged; private inbox 503 guard remains enabled.'
