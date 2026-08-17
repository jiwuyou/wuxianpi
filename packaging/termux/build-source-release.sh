#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
version=""
output_dir="$repo_dir/release/dist"

usage() {
  cat <<'EOF'
Usage: build-source-release.sh [--version VERSION] [--output DIR]

Builds the Web and Runtime from source, reduces Runtime dependencies to the
production package-lock closure, then creates the official Termux ARM64
release with build-release.sh.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version) version="$2"; shift 2 ;;
    --output) output_dir="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'Unknown argument: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

[[ "$(uname -m)" == aarch64 || "$(uname -m)" == arm64 ]] || {
  printf 'Source releases must be built on ARM64 so optional production dependencies match Termux.\n' >&2
  exit 1
}
command -v npm >/dev/null || { printf 'npm is required\n' >&2; exit 1; }
command -v node >/dev/null || { printf 'node is required\n' >&2; exit 1; }
command -v zstd >/dev/null || { printf 'zstd is required\n' >&2; exit 1; }

version="${version:-$(node -p "require('$repo_dir/runtime/wuxianpi-node/package.json').version")}"
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/wuxianpi-source-release.XXXXXX")"
web_build="$work_dir/web-build"
runtime_build="$work_dir/runtime-build"
runtime_release="$work_dir/runtime-release"
base_release="$work_dir/base-release"
smoke_home="$work_dir/smoke-home"
smoke_pid=""

cleanup() {
  if [[ -n "$smoke_pid" ]]; then
    kill "$smoke_pid" >/dev/null 2>&1 || true
    wait "$smoke_pid" >/dev/null 2>&1 || true
  fi
  rm -rf -- "$work_dir"
}
trap cleanup EXIT INT TERM

copy_source() {
  local source="$1" target="$2"
  mkdir -p "$target"
  tar --exclude='./node_modules' --exclude='./dist' --exclude='./.next' \
    --exclude='./coverage' --exclude='*.tsbuildinfo' -cf - -C "$source" . \
    | tar -xf - -C "$target"
}

copy_source "$repo_dir/apps/web" "$web_build"
(
  cd "$web_build"
  npm ci --include=dev --prefer-offline
  npm run build
  test -s dist/index.html
)

copy_source "$repo_dir/runtime/wuxianpi-node" "$runtime_build"
(
  cd "$runtime_build"
  npm ci --include=dev --prefer-offline
  npm run build
  test -s dist/index.js
  npm prune --omit=dev
  node - <<'NODE'
const fs = require("node:fs");
const pkg = require("./package.json");
for (const name of Object.keys(pkg.devDependencies || {})) {
  if (fs.existsSync(`node_modules/${name}`)) {
    throw new Error(`development dependency remains in production Base: ${name}`);
  }
}
const sdk = require("./node_modules/@earendil-works/pi-coding-agent/package.json");
if (sdk.version !== "0.80.10") throw new Error(`unexpected Pi SDK version: ${sdk.version}`);
NODE
)

mkdir -p "$runtime_release" "$base_release"
cp -a "$runtime_build/package.json" "$runtime_build/package-lock.json" \
  "$runtime_build/dist" "$runtime_build/builtin-packages" "$runtime_release/"
node "$repo_dir/packaging/distributions/prepare-packages.mjs" \
  --lock "$repo_dir/packaging/distributions/openhouse/packages.lock.json" \
  --output "$runtime_release/preinstalled-packages"
cp -a "$runtime_build/node_modules" "$base_release/"

mkdir -p "$output_dir"
for artifact in \
  "$output_dir/wuxianpi-web-$version.tar.zst" \
  "$output_dir/wuxianpi-runtime-$version.tar.zst" \
  "$output_dir/wuxianpi-base-$version.tar.zst" \
  "$output_dir/wuxianpi-install-arm64-$version.tar.zst" \
  "$output_dir/runtime-manifest.json"; do
  [[ ! -e "$artifact" ]] || mv "$artifact" "$work_dir/$(basename "$artifact").previous"
done
SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-0}" "$repo_dir/packaging/termux/build-release.sh" \
  --version "$version" \
  --web-dir "$web_build/dist" \
  --runtime-dir "$runtime_release" \
  --base-dir "$base_release" \
  --channel release \
  --output "$output_dir"

install_archive="$output_dir/wuxianpi-install-arm64-$version.tar.zst"
mkdir -p "$work_dir/install" "$smoke_home"
zstd -q -dc "$install_archive" | tar -xf - -C "$work_dir/install"
HOME="$smoke_home" WUXIANPI_INSTALL_ROOT="$smoke_home/product" \
  "$work_dir/install/scripts/install-release.sh" "$work_dir/install"
HOME="$smoke_home" WUXIANPI_INSTALL_ROOT="$smoke_home/product" \
  "$smoke_home/.local/bin/wuxianpi-node" --help >/dev/null
smoke_port="$(python3 - <<'PY'
import socket
with socket.socket() as sock:
    sock.bind(("127.0.0.1", 0))
    print(sock.getsockname()[1])
PY
)"
HOME="$smoke_home" WUXIANPI_INSTALL_ROOT="$smoke_home/product" \
  OPENHOUSE_PI_LISTEN="127.0.0.1:$smoke_port" \
  OPENHOUSE_PI_IDLE_TIMEOUT_MS=60000 \
  "$smoke_home/.local/bin/wuxianpi-node-start" >"$work_dir/smoke-runtime.log" 2>&1 &
smoke_pid=$!
for _ in $(seq 1 100); do
  if HOME="$smoke_home" node - "$smoke_port" <<'NODE'
const http = require("node:http");
const request = http.get({host: "127.0.0.1", port: Number(process.argv[2]), path: "/health"}, response => {
  response.resume();
  response.on("end", () => process.exit(response.statusCode === 200 ? 0 : 1));
});
request.setTimeout(500, () => request.destroy());
request.on("error", () => process.exit(1));
NODE
  then
    break
  fi
  kill -0 "$smoke_pid" >/dev/null 2>&1 || {
    cat "$work_dir/smoke-runtime.log" >&2
    printf 'Installed WuxianPi runtime exited before becoming healthy.\n' >&2
    exit 1
  }
  sleep 0.1
done
HOME="$smoke_home" node - "$smoke_port" <<'NODE' || {
const http = require("node:http");
const request = http.get({host: "127.0.0.1", port: Number(process.argv[2]), path: "/health"}, response => {
  response.resume();
  response.on("end", () => process.exit(response.statusCode === 200 ? 0 : 1));
});
request.setTimeout(1000, () => request.destroy());
request.on("error", () => process.exit(1));
NODE
  cat "$work_dir/smoke-runtime.log" >&2
  printf 'Installed WuxianPi runtime did not pass /health.\n' >&2
  exit 1
}
kill "$smoke_pid" >/dev/null 2>&1 || true
wait "$smoke_pid" >/dev/null 2>&1 || true
smoke_pid=""

printf 'WuxianPi source release verified: %s\n' "$install_archive"
