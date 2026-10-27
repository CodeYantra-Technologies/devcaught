#!/usr/bin/env bash
set -euo pipefail
set +x
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.."
docker info --format '{{.ServerVersion}}' >/dev/null
export DEVCAUGHT_SETUP_UID="$(id -u)" DEVCAUGHT_SETUP_GID="$(id -g)"
export DEVCAUGHT_AUTH_SECRET_DIR="$HOME/.local/share/devcaught/auth-dev-secrets"
export DEVCAUGHT_CANDIDATE_AUTH_IMAGE=devcaught:candidate-auth-verification
export DEVCAUGHT_CANDIDATE_AUTH_TEST=disabled AUTH_VERIFY_MODE=closed
export DEVCAUGHT_CANDIDATE_AUTH_EXPIRES=0
# Inspect metadata only. Refuse any unexpected identity or resource reuse.
[[ "$(docker inspect --type container --format '{{index .Config.Labels "com.docker.compose.project"}}' devcaught-local-candidate)" == devcaught-candidate ]]
[[ "$(docker inspect --type container --format '{{index .Config.Labels "com.docker.compose.service"}}' devcaught-local-candidate)" == candidate ]]
[[ "$(docker inspect --type container --format '{{range .Mounts}}{{if eq .Destination "/app/data"}}{{.Name}}{{end}}{{end}}' devcaught-local-candidate)" == devcaught_candidate_inbox ]]
if [[ -n "$(docker volume ls -q --filter name='^devcaught_candidate_auth_inbox$')" ]] ||
   [[ -n "$(docker image ls -q devcaught:candidate-auth-verification)" ]]; then
  echo 'BLOCKED: authorization-test volume or image already exists; nothing reused.'; exit 1
fi
[[ -n "$(docker image ls -q devcaught:candidate)" ]]
test -f "$DEVCAUGHT_AUTH_SECRET_DIR/app_password"
test -f "$DEVCAUGHT_AUTH_SECRET_DIR/better_auth_secret"
compose=(docker compose --env-file /dev/null -p devcaught-candidate -f compose.candidate-local.yaml -f compose.candidate-auth.yaml)
"${compose[@]}" config --quiet
node --experimental-strip-types --test scripts/candidate/auth-policy.test.ts
"${compose[@]}" build candidate
# From here on, rollback always closes the capability, even when verification fails.
close_candidate() {
  local previous_status=$?
  trap - EXIT INT TERM
  export DEVCAUGHT_CANDIDATE_AUTH_IMAGE=devcaught:candidate-auth-verification
  export DEVCAUGHT_CANDIDATE_AUTH_TEST=disabled AUTH_VERIFY_MODE=closed
  if "${compose[@]}" up -d --no-deps --no-build --force-recreate candidate &&
     "${compose[@]}" run --rm --no-deps verify; then
    echo 'Candidate restored to disabled mode; all private routes return 503.'
  else
    echo 'BLOCKED: automatic candidate closure failed; stopping only devcaught-local-candidate.'
    docker stop devcaught-local-candidate >/dev/null || true
    previous_status=1
  fi
  exit "$previous_status"
}
trap close_candidate EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# Normal release image must remain closed even with every candidate opt-in set.
export DEVCAUGHT_CANDIDATE_AUTH_IMAGE=devcaught:candidate DEVCAUGHT_CANDIDATE_AUTH_TEST=enabled
export DEVCAUGHT_CANDIDATE_AUTH_EXPIRES="$(node -e 'process.stdout.write(String(Date.now()+10*60*1000))')"
"${compose[@]}" up -d --no-deps --no-build --force-recreate candidate
"${compose[@]}" run --rm --no-deps verify
echo 'PASS: normal release image ignores candidate opt-in and returns 503'
export DEVCAUGHT_CANDIDATE_AUTH_IMAGE=devcaught:candidate-auth-verification DEVCAUGHT_CANDIDATE_AUTH_TEST=disabled
"${compose[@]}" up -d --no-deps --no-build --force-recreate candidate
"${compose[@]}" run --rm --no-deps verify
echo 'PASS: candidate capability disabled returns 503'
export DEVCAUGHT_CANDIDATE_AUTH_TEST=enabled AUTH_VERIFY_MODE=active
export DEVCAUGHT_CANDIDATE_AUTH_EXPIRES="$(node -e 'process.stdout.write(String(Date.now()+10*60*1000))')"
"${compose[@]}" up -d --no-deps --no-build --force-recreate candidate
"${compose[@]}" run --rm --no-deps verify
echo 'PASS: candidate-only authorization verification complete; closing capability now'
