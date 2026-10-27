#!/usr/bin/env bash
set -euo pipefail
set +x
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.."
docker info --format '{{.ServerVersion}}' >/dev/null
export DEVCAUGHT_SETUP_UID="$(id -u)" DEVCAUGHT_SETUP_GID="$(id -g)"
export DEVCAUGHT_AUTH_SECRET_DIR="$HOME/.local/share/devcaught/auth-dev-secrets"
# Metadata and file existence only; secret contents are read inside containers.
test -f "$DEVCAUGHT_AUTH_SECRET_DIR/app_password"
test -f "$DEVCAUGHT_AUTH_SECRET_DIR/better_auth_secret"
containers="$(docker container ls -a --format '{{.Names}}')"
volumes="$(docker volume ls --format '{{.Name}}')"
networks="$(docker network ls --format '{{.Name}}')"
for spec in 'container devcaught-local-candidate' 'volume devcaught_candidate_inbox' 'network devcaught_candidate_net'; do
  read -r kind name <<< "$spec"
  case "$kind" in container) listing="$containers";; volume) listing="$volumes";; network) listing="$networks";; esac
  if [[ $'\n'"$listing"$'\n' == *$'\n'"$name"$'\n'* ]]; then echo "BLOCKED: existing $kind $name"; exit 1; fi
done
for kind in container volume network; do
  if [[ "$kind" == container ]]; then
    existing="$(docker container ls -a -q --filter label=com.docker.compose.project=devcaught-candidate)"
  else
    existing="$(docker "$kind" ls -q --filter label=com.docker.compose.project=devcaught-candidate)"
  fi
  if [[ -n "$existing" ]]; then echo 'BLOCKED: candidate project already has resources'; exit 1; fi
done
for image in devcaught:candidate devcaught:candidate-base; do
  if [[ -n "$(docker image ls -q "$image")" ]]; then echo "BLOCKED: existing image $image"; exit 1; fi
done
[[ "$(docker inspect --type container --format '{{.State.Health.Status}}' devcaught-pg-dev)" == healthy ]]
[[ "$(docker network inspect --format '{{.Internal}}' devcaught_pg_dev_net)" == true ]]
python3 - <<'PY'
import socket
sockets = []
try:
    for port in (3300, 8325, 1325):
        sock = socket.socket()
        sock.bind(('127.0.0.1', port))
        sockets.append(sock)
finally:
    for sock in sockets:
        sock.close()
PY
node --input-type=module -e "import('pg'); import('kysely')" >/dev/null
compose=(docker compose --env-file /dev/null -p devcaught-candidate -f compose.candidate-local.yaml)
"${compose[@]}" config --quiet
# The base Dockerfile unsets DATABASE_URL during build; no runtime secrets supplied.
docker build -f Dockerfile -t devcaught:candidate-base .
docker pull node:22-bookworm-slim
"${compose[@]}" build candidate
"${compose[@]}" up -d --no-deps --no-build candidate
"${compose[@]}" run --rm --no-deps verify
"${compose[@]}" ps candidate
echo 'Candidate is available at http://localhost:3300; no application cutover performed.'
