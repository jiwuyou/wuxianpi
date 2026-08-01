#!/usr/bin/env bash
set -euo pipefail

deployment_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$deployment_dir"

canonical_health_url="http://127.0.0.1:20878/health"
candidate_health_url="${HUB_ROTATION_HEALTH_URL:-$canonical_health_url}"
candidate_health_attempts="${HUB_ROTATION_HEALTH_ATTEMPTS:-60}"

wait_for_health() {
  local url="$1"
  local attempts="$2"
  for _ in $(seq 1 "$attempts"); do
    if curl -fsS "$url" >/dev/null; then
      return 0
    fi
    sleep 2
  done
  return 1
}

if [[ ! -f secrets.env ]]; then
  echo "secrets.env does not exist; run deploy.sh first." >&2
  exit 1
fi
if ! wait_for_health "$canonical_health_url" 3; then
  echo "Hub is not healthy before credential rotation; refusing to rotate." >&2
  exit 1
fi

umask 077
old_secrets="$(mktemp "$deployment_dir/.secrets.env.before.XXXXXX")"
cp -p secrets.env "$old_secrets"
rollback_armed=true

rollback_rotation() {
  local status=$?
  trap - ERR INT TERM
  if [[ "$rollback_armed" == true ]]; then
    cp -p "$old_secrets" secrets.env
    docker compose up -d --force-recreate hub >/dev/null 2>&1 || true
    if ! wait_for_health "$canonical_health_url" 60; then
      echo "CRITICAL: old credentials were restored but the previous Hub container did not recover." >&2
    else
      echo "Credential rotation failed; old credentials and healthy Hub container were restored." >&2
    fi
  fi
  rm -f "$old_secrets" secrets.env.new
  exit "$status"
}
trap rollback_rotation ERR
trap 'false' INT TERM

admin_token="$(openssl rand -hex 32)"
publisher_token="$(openssl rand -hex 32)"
printf '%s\n' \
  "HUB_ADMIN_TOKEN=$admin_token" \
  "HUB_PUBLISHER_TOKENS={\"pub_wuxianpi\":{\"token\":\"$publisher_token\",\"name\":\"WuxianPi\",\"profileUrl\":\"https://github.com/jiwuyou\"}}" \
  > secrets.env.new
chmod 600 secrets.env.new
mv secrets.env.new secrets.env

docker compose up -d --force-recreate hub
if ! wait_for_health "$candidate_health_url" "$candidate_health_attempts"; then
  echo "Hub did not pass the post-rotation health check." >&2
  false
fi

rollback_armed=false
trap - ERR INT TERM
rm -f "$old_secrets"
echo "Hub credentials rotated. The new values remain in $deployment_dir/secrets.env"
