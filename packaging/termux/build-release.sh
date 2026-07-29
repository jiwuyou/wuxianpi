#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  cat <<'EOF'
Usage: build-release.sh --version VERSION --web-dir DIR --runtime-dir DIR
                        --base-dir DIR [--web-version VERSION]
                        [--runtime-version VERSION] [--base-version VERSION]
                        [--min-host-version NUMBER] [--channel NAME]
                        [--output DIR]
EOF
}

version=""
web_version=""
runtime_version=""
base_version=""
web_dir=""
runtime_dir=""
base_dir=""
min_host_version="1"
channel="development"
output_dir="release/dist"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version) version="$2"; shift 2 ;;
    --web-version) web_version="$2"; shift 2 ;;
    --runtime-version) runtime_version="$2"; shift 2 ;;
    --base-version) base_version="$2"; shift 2 ;;
    --web-dir) web_dir="$2"; shift 2 ;;
    --runtime-dir) runtime_dir="$2"; shift 2 ;;
    --base-dir) base_dir="$2"; shift 2 ;;
    --min-host-version) min_host_version="$2"; shift 2 ;;
    --channel) channel="$2"; shift 2 ;;
    --output) output_dir="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'Unknown argument: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

[[ -n "$version" && -n "$web_dir" && -n "$runtime_dir" && -n "$base_dir" ]] || {
  usage >&2
  exit 2
}
[[ "$min_host_version" =~ ^[1-9][0-9]*$ ]] || {
  printf 'min host version must be a positive integer\n' >&2
  exit 2
}

web_version="${web_version:-$version}"
runtime_version="${runtime_version:-$version}"
base_version="${base_version:-$version}"

for source in "$web_dir" "$runtime_dir" "$base_dir"; do
  [[ -d "$source" ]] || { printf 'Missing input directory: %s\n' "$source" >&2; exit 1; }
  [[ -n "$(find "$source" -mindepth 1 -maxdepth 1 -print -quit)" ]] || {
    printf 'Input directory is empty: %s\n' "$source" >&2
    exit 1
  }
done

[[ -f "$web_dir/index.html" ]] || {
  printf 'Web input is missing index.html: %s\n' "$web_dir" >&2
  exit 1
}
[[ -f "$runtime_dir/dist/index.js" ]] || {
  printf 'Runtime input is missing dist/index.js: %s\n' "$runtime_dir" >&2
  exit 1
}
[[ ! -e "$runtime_dir/node_modules" ]] || {
  printf 'Runtime input must not contain node_modules: %s\n' "$runtime_dir" >&2
  exit 1
}
[[ -f "$base_dir/node_modules/@earendil-works/pi-coding-agent/package.json" ]] || {
  printf 'Base input is missing the Pi SDK package: %s\n' "$base_dir" >&2
  exit 1
}

command -v zstd >/dev/null || { printf 'zstd is required\n' >&2; exit 1; }
command -v python3 >/dev/null || { printf 'python3 is required\n' >&2; exit 1; }

mkdir -p "$output_dir"
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/wuxianpi-release.XXXXXX")"
trap 'rm -rf -- "$work_dir"' EXIT
source_date_epoch="${SOURCE_DATE_EPOCH:-0}"

make_layer() {
  local kind="$1" layer_version="$2" source="$3" output="$4"
  local stage="$work_dir/layer-$kind"
  mkdir -p "$stage/payload"
  tar -cf - -C "$source" . | tar -xf - -C "$stage/payload"
  python3 - "$stage/layer.json" "$kind" "$layer_version" <<'PY'
import json
import pathlib
import sys

path, kind, version = sys.argv[1:]
pathlib.Path(path).write_text(json.dumps({
    "schemaVersion": 1,
    "product": "wuxianpi",
    "kind": kind,
    "version": version,
    "platform": "termux-android-arm64",
}, indent=2) + "\n", encoding="utf-8")
PY
  tar --sort=name --mtime="@$source_date_epoch" --owner=0 --group=0 --numeric-owner \
    -cf - -C "$stage" . | zstd -q -10 -T0 -o "$output.tmp"
  mv "$output.tmp" "$output"
}

web_archive="$output_dir/wuxianpi-web-$web_version.tar.zst"
runtime_archive="$output_dir/wuxianpi-runtime-$runtime_version.tar.zst"
base_archive="$output_dir/wuxianpi-base-$base_version.tar.zst"
install_archive="$output_dir/wuxianpi-install-arm64-$version.tar.zst"

make_layer web "$web_version" "$web_dir" "$web_archive"
make_layer runtime "$runtime_version" "$runtime_dir" "$runtime_archive"
make_layer base "$base_version" "$base_dir" "$base_archive"

bundle="$work_dir/install-arm64"
mkdir -p "$bundle/layers" "$bundle/scripts" "$bundle/bin"
cp "$web_archive" "$runtime_archive" "$base_archive" "$bundle/layers/"
cp "$script_dir/bundle/install.sh" "$bundle/install.sh"
cp "$script_dir/bundle/install-release.sh" "$script_dir/bundle/register-service.sh" "$bundle/scripts/"
cp "$script_dir/bundle/bin/"* "$bundle/bin/"
chmod 0755 "$bundle/install.sh" "$bundle/scripts/"*.sh "$bundle/bin/"*
tar --sort=name --mtime="@$source_date_epoch" --owner=0 --group=0 --numeric-owner \
  -cf - -C "$bundle" . | zstd -q -10 -T0 -o "$install_archive.tmp"
mv "$install_archive.tmp" "$install_archive"

python3 "$script_dir/generate-release-manifest.py" \
  --output "$output_dir/runtime-manifest.json" \
  --version "$version" \
  --channel "$channel" \
  --min-host-version "$min_host_version" \
  --web-version "$web_version" \
  --runtime-version "$runtime_version" \
  --base-version "$base_version" \
  --web "$web_archive" \
  --runtime "$runtime_archive" \
  --base "$base_archive" \
  --install-arm64 "$install_archive"

printf 'WuxianPi release written to %s\n' "$output_dir"
