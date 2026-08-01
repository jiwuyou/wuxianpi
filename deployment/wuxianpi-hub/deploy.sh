#!/usr/bin/env bash
set -euo pipefail

deployment_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$deployment_dir"

umask 077
mkdir -p data/assets backups

if [[ ! -f runtime.env ]]; then
  cp runtime.env.example runtime.env
fi

if [[ ! -f secrets.env ]]; then
  admin_token="$(openssl rand -hex 32)"
  publisher_token="$(openssl rand -hex 32)"
  cat > secrets.env <<EOF
HUB_ADMIN_TOKEN=$admin_token
HUB_PUBLISHER_TOKENS={"pub_wuxianpi":{"token":"$publisher_token","name":"WuxianPi","profileUrl":"https://github.com/jiwuyou"}}
EOF
fi

chmod 600 runtime.env secrets.env
docker compose config --quiet
docker compose build --pull
docker compose up -d --remove-orphans

for _ in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:20878/health >/dev/null; then
    echo "WuxianPi Hub is healthy on http://127.0.0.1:20878"
    echo "Server credentials remain in $deployment_dir/secrets.env"
    exit 0
  fi
  sleep 2
done

docker compose ps
docker compose logs --tail=120 hub
echo "WuxianPi Hub did not become healthy" >&2
exit 1
