#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: RESTORE_CONFIRM=1 $0 <backup.tar.gz>" >&2
  exit 2
fi
if [[ "${RESTORE_CONFIRM:-}" != "1" ]]; then
  echo "Set RESTORE_CONFIRM=1 to replace the current Hub data." >&2
  exit 2
fi

deployment_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
archive="$(realpath "$1")"
checksum="$archive.sha256"
cd "$deployment_dir"

if [[ ! -f "$checksum" ]]; then
  echo "Required checksum file is missing: $checksum" >&2
  exit 1
fi

checksum_line="$(<"$checksum")"
expected_digest="${checksum_line%%  *}"
recorded_name="${checksum_line#*  }"
if [[ ! "$expected_digest" =~ ^[0-9a-fA-F]{64}$ || "$recorded_name" != "$(basename "$archive")" || "$checksum_line" == *$'\n'* ]]; then
  echo "Checksum file is not in the generated '<sha256>  <archive-name>' format." >&2
  exit 1
fi
actual_digest="$(sha256sum -- "$archive" | awk '{print $1}')"
if [[ "${actual_digest,,}" != "${expected_digest,,}" ]]; then
  echo "Backup checksum verification failed." >&2
  exit 1
fi

staging="$(mktemp -d "$deployment_dir/.restore.XXXXXX")"
cleanup_staging() {
  rm -rf "$staging"
}
trap cleanup_staging EXIT

python3 - "$archive" "$staging" <<'PY'
import os
import shutil
import sys
import tarfile
from pathlib import Path, PurePosixPath

archive = sys.argv[1]
staging = Path(sys.argv[2])
seen: set[str] = set()
saw_data = False

with tarfile.open(archive, "r:gz") as source:
    members = source.getmembers()
    for member in members:
        raw = member.name
        if not raw or raw.startswith("/") or "\\" in raw:
            raise SystemExit(f"unsafe archive path: {raw!r}")
        trimmed = raw[:-1] if raw.endswith("/") else raw
        parts = trimmed.split("/")
        if not parts or parts[0] != "data" or any(part in {"", ".", ".."} for part in parts):
            raise SystemExit(f"archive member is outside data/: {raw!r}")
        normalized = str(PurePosixPath(*parts))
        if normalized in seen:
            raise SystemExit(f"duplicate archive member: {raw!r}")
        seen.add(normalized)
        saw_data = True
        if normalized == "data" and not member.isdir():
            raise SystemExit("archive data root must be a directory")
        if not (member.isdir() or member.isreg()):
            raise SystemExit(f"unsupported archive member type: {raw!r}")

    if not saw_data:
        raise SystemExit("archive does not contain data/")

    for member in members:
        trimmed = member.name[:-1] if member.name.endswith("/") else member.name
        destination = staging.joinpath(*trimmed.split("/"))
        if member.isdir():
            destination.mkdir(parents=True, exist_ok=False)
            os.chmod(destination, member.mode & 0o777)
            continue
        destination.parent.mkdir(parents=True, exist_ok=True)
        stream = source.extractfile(member)
        if stream is None:
            raise SystemExit(f"unable to read archive member: {member.name!r}")
        with stream, destination.open("xb") as output:
            shutil.copyfileobj(stream, output)
        os.chmod(destination, member.mode & 0o777)
PY

if [[ "${RESTORE_VALIDATE_ONLY:-}" == "1" ]]; then
  echo "Backup archive and checksum are safe."
  exit 0
fi

operation_id="$(date -u +%Y%m%dT%H%M%S)-$$"
previous="data.before-restore-$operation_id"
failed="data.failed-restore-$operation_id"
previous_saved=false
candidate_installed=false

wait_for_health() {
  for _ in $(seq 1 30); do
    if curl -fsS http://127.0.0.1:20878/health >/dev/null; then
      return 0
    fi
    sleep 2
  done
  return 1
}

rollback_restore() {
  local status=$?
  trap - ERR
  if [[ "$candidate_installed" == true && -e data ]]; then
    mv data "$failed"
  fi
  if [[ "$previous_saved" == true && -e "$previous" ]]; then
    mv "$previous" data
  fi
  docker compose up -d hub >/dev/null 2>&1 || true
  wait_for_health || true
  exit "$status"
}
trap rollback_restore ERR

docker compose stop hub
if [[ -e data ]]; then
  mv data "$previous"
  previous_saved=true
fi
mv "$staging/data" data
candidate_installed=true

docker compose up -d hub
if ! wait_for_health; then
  echo "Restored Hub did not become healthy; restoring the previous data." >&2
  false
fi

rm -rf "$previous" "$failed"
trap - ERR
echo "Restore completed from $archive"
