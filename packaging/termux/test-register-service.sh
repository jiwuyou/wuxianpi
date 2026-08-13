#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work="$(mktemp -d "${TMPDIR:-/tmp}/wuxianpi-register-test.XXXXXX")"
trap 'rm -rf -- "$work"' EXIT
export HOME="$work/home"
export PREFIX="${PREFIX:-/usr}"
mkdir -p "$HOME"
script="$root/bundle/register-service.sh"
service_dir="$HOME/.config/openhouseai/service-manager/services.d"

sh "$script"
node -e 'const x=require(process.argv[1]);if(x.name!=="yuanshengwuxianpi")process.exit(1)' \
  "$service_dir/yuanshengwuxianpi.json"

cat >"$work/custom.json" <<'JSON'
{"name":"wuxianpi-dev","provider":"termux-process","command":["node","dist/index.js"],"ports":[{"name":"web","preferred":40141,"dynamic":true}],"health":[{"type":"http","url":"http://127.0.0.1:{{port:web}}/health"}]}
JSON
sh "$script" --spec "$work/custom.json"
cmp "$work/custom.json" "$service_dir/wuxianpi-dev.json"

sed 's/wuxianpi-dev/wuxianpi-beta2/' "$work/custom.json" \
  | sh "$script" --spec -
test -s "$service_dir/wuxianpi-beta2.json"
cmp "$work/custom.json" "$service_dir/wuxianpi-dev.json"

cp "$service_dir/wuxianpi-dev.json" "$work/before.json"
printf '{bad json\n' >"$work/invalid.json"
if sh "$script" --spec "$work/invalid.json" >/dev/null 2>&1; then
  printf 'invalid JSON was accepted\n' >&2
  exit 1
fi
cmp "$work/before.json" "$service_dir/wuxianpi-dev.json"

printf '%s\n' '{"name":"../bad","provider":"termux-process","command":["true"]}' \
  | if sh "$script" --spec - >/dev/null 2>&1; then
      printf 'invalid service name was accepted\n' >&2
      exit 1
    fi

printf 'register-service tests passed\n'
