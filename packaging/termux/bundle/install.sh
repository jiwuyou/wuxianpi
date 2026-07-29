#!/data/data/com.termux/files/usr/bin/sh
set -eu

root=$(CDPATH= cd "$(dirname "$0")" && pwd)
"$root/scripts/install-release.sh" "$root"
"$root/scripts/register-service.sh"

