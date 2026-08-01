#!/usr/bin/env bash
set -euo pipefail

deployment_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$deployment_dir"

destination="${1:-$deployment_dir/backups}"
mkdir -p "$destination"
archive="$destination/wuxianpi-hub-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
temporary="$archive.partial"
was_running=false

if docker compose ps --status running --services | grep -qx hub; then
  was_running=true
  docker compose stop hub
fi

restart_hub() {
  if [[ "$was_running" == true ]]; then
    docker compose start hub >/dev/null
  fi
}
trap restart_hub EXIT

tar -C "$deployment_dir" -czf "$temporary" data
mv "$temporary" "$archive"
(cd "$destination" && sha256sum -- "$(basename "$archive")" > "$(basename "$archive").sha256")

echo "$archive"
