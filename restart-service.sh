#!/usr/bin/env bash
set -Eeuo pipefail

readonly APP_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly ENV_FILE="${AFTERDRAFT_ENV_FILE:-/srv/homelab/secrets/afterdraft.env}"
readonly HEALTH_URL="${AFTERDRAFT_HEALTH_URL:-http://127.0.0.1:4310/health}"

usage() {
  cat <<'EOF'
Usage: ./restart-service.sh [--check]

Rebuilds the ProfRead image, force-recreates the service container, and
waits for the local health endpoint. Use --check to validate the deployment
configuration without changing the running service.

Optional environment variables:
  AFTERDRAFT_ENV_FILE    Compose env file
  AFTERDRAFT_HEALTH_URL  Health endpoint to wait for
EOF
}

case "${1:-}" in
  '') ;;
  --check) CHECK_ONLY=1 ;;
  -h|--help) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac
readonly CHECK_ONLY="${CHECK_ONLY:-0}"

command -v docker >/dev/null || { echo "docker is not installed" >&2; exit 1; }
docker compose version >/dev/null
[[ -r "${ENV_FILE}" ]] || { echo "ProfRead env file is not readable: ${ENV_FILE}" >&2; exit 1; }

cd "${APP_DIR}"
docker compose --env-file "${ENV_FILE}" config --quiet

if [[ "${CHECK_ONLY}" == 1 ]]; then
  echo "ProfRead restart configuration is valid."
  exit 0
fi

echo "Building ProfRead from ${APP_DIR} ..."
docker compose --env-file "${ENV_FILE}" build afterdraft

echo "Recreating the ProfRead container ..."
docker compose --env-file "${ENV_FILE}" up -d --force-recreate afterdraft

echo "Waiting for ${HEALTH_URL} ..."
for attempt in $(seq 1 30); do
  if response="$(curl --fail --silent --show-error "${HEALTH_URL}" 2>/dev/null)" \
    && [[ "${response}" == *'"status":"ok"'* ]]; then
    container_id="$(docker compose --env-file "${ENV_FILE}" ps -q afterdraft)"
    image_id="$(docker inspect --format '{{.Image}}' "${container_id}")"
    echo "ProfRead is healthy. Image: ${image_id:7:12}"
    exit 0
  fi
  sleep 2
done

echo "ProfRead did not become healthy; recent logs follow:" >&2
docker compose --env-file "${ENV_FILE}" logs --tail=80 afterdraft >&2
exit 1
