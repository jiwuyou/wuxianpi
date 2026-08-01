#!/usr/bin/env bash
set -euo pipefail

deployment_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
temporary="$(mktemp -d)"
trap 'rm -rf "$temporary"' EXIT

python3 - "$temporary" <<'PY'
import io
import sys
import tarfile
from pathlib import Path

root = Path(sys.argv[1])

def write(name, members):
    with tarfile.open(root / name, "w:gz") as archive:
        for member, content in members:
            archive.addfile(member, io.BytesIO(content) if content is not None else None)

data = tarfile.TarInfo("data")
data.type = tarfile.DIRTYPE
file = tarfile.TarInfo("data/hub.sqlite")
file.size = 4
write("valid.tar.gz", [(data, None), (file, b"test")])

for name, member in [
    ("traversal.tar.gz", tarfile.TarInfo("data/../../deployment/wuxianpi-hub/deploy.sh")),
    ("absolute.tar.gz", tarfile.TarInfo("/etc/passwd")),
]:
    member.size = 1
    write(name, [(member, b"x")])

symlink = tarfile.TarInfo("data/link")
symlink.type = tarfile.SYMTYPE
symlink.linkname = "../../deployment"
write("symlink.tar.gz", [(symlink, None)])

hardlink = tarfile.TarInfo("data/hardlink")
hardlink.type = tarfile.LNKTYPE
hardlink.linkname = "data/hub.sqlite"
write("hardlink.tar.gz", [(hardlink, None)])

fifo = tarfile.TarInfo("data/fifo")
fifo.type = tarfile.FIFOTYPE
write("fifo.tar.gz", [(fifo, None)])

device = tarfile.TarInfo("data/device")
device.type = tarfile.CHRTYPE
write("device.tar.gz", [(device, None)])
PY

checksum() {
  (cd "$temporary" && sha256sum -- "$1" > "$1.sha256")
}
expect_rejected() {
  local archive="$1"
  if RESTORE_CONFIRM=1 RESTORE_VALIDATE_ONLY=1 "$deployment_dir/restore.sh" "$temporary/$archive" >/dev/null 2>&1; then
    echo "Unsafe archive was accepted: $archive" >&2
    exit 1
  fi
}

checksum valid.tar.gz
RESTORE_CONFIRM=1 RESTORE_VALIDATE_ONLY=1 "$deployment_dir/restore.sh" "$temporary/valid.tar.gz" >/dev/null

cp "$temporary/valid.tar.gz" "$temporary/missing-checksum.tar.gz"
expect_rejected missing-checksum.tar.gz

for archive in traversal.tar.gz absolute.tar.gz symlink.tar.gz hardlink.tar.gz fifo.tar.gz device.tar.gz; do
  checksum "$archive"
  expect_rejected "$archive"
done

if [[ "${TEST_LIVE_ROTATION:-}" == "1" ]]; then
  before="$(sha256sum "$deployment_dir/secrets.env" | awk '{print $1}')"
  if HUB_ROTATION_HEALTH_URL=http://127.0.0.1:1/health HUB_ROTATION_HEALTH_ATTEMPTS=1 "$deployment_dir/rotate-secrets.sh"; then
    echo "Forced rotation failure unexpectedly succeeded." >&2
    exit 1
  fi
  after="$(sha256sum "$deployment_dir/secrets.env" | awk '{print $1}')"
  [[ "$before" == "$after" ]]
  curl -fsS http://127.0.0.1:20878/health >/dev/null
fi

echo "Deployment script tests passed."
