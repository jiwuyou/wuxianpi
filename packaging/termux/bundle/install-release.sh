#!/data/data/com.termux/files/usr/bin/sh
set -eu

: "${HOME:?HOME is required}"
bundle_root=${1:-$(CDPATH= cd "$(dirname "$0")/.." && pwd)}
product_root=${WUXIANPI_INSTALL_ROOT:-$HOME/.local/share/wuxianpi}
stage=$(mktemp -d "${TMPDIR:-${PREFIX:-/data/data/com.termux/files/usr}/tmp}/wuxianpi-install.XXXXXX")
trap 'rm -rf "$stage"' EXIT HUP INT TERM

command -v zstd >/dev/null
command -v node >/dev/null
node -e 'const [major,minor]=process.versions.node.split(".").map(Number);if(major<22||(major===22&&minor<19))process.exit(1)'

for kind in base runtime web; do
  set -- "$bundle_root/layers/wuxianpi-$kind-"*.tar.zst
  [ "$#" -eq 1 ] && [ -f "$1" ] || {
    printf 'Missing or ambiguous %s layer\n' "$kind" >&2
    exit 1
  }
  mkdir -p "$stage/$kind"
  zstd -q -dc "$1" | tar -xf - -C "$stage/$kind"
  [ -f "$stage/$kind/layer.json" ] && [ -d "$stage/$kind/payload" ] || {
    printf 'Invalid %s layer\n' "$kind" >&2
    exit 1
  }
done

[ -f "$stage/runtime/payload/dist/index.js" ] || {
  printf 'Runtime layer is missing dist/index.js\n' >&2
  exit 1
}
[ ! -e "$stage/runtime/payload/node_modules" ] || {
  printf 'Runtime layer must not contain node_modules; put stable dependencies in base\n' >&2
  exit 1
}
[ -f "$stage/base/payload/node_modules/@earendil-works/pi-coding-agent/package.json" ] || {
  printf 'Base layer is missing the Pi SDK package\n' >&2
  exit 1
}
[ -f "$stage/web/payload/index.html" ] || {
  printf 'Web layer is missing index.html\n' >&2
  exit 1
}

mkdir -p "$product_root" "$HOME/.local/bin" "$HOME/.pi/agent/sessions" "$HOME/workspace"
for kind in base runtime web; do
  next="$product_root/$kind.new.$$"
  old="$product_root/$kind.old.$$"
  rm -rf "$next" "$old"
  mv "$stage/$kind/payload" "$next"
  if [ -e "$product_root/$kind" ]; then mv "$product_root/$kind" "$old"; fi
  mv "$next" "$product_root/$kind"
  rm -rf "$old"
done

ln -sfn ../base/node_modules "$product_root/runtime/node_modules"
for command_name in wuxianpi wuxianpi-node wuxianpi-node-start; do
  install -m 0755 "$bundle_root/bin/$command_name" "$HOME/.local/bin/$command_name"
done

WUXIANPI_INSTALL_ROOT="$product_root" "$HOME/.local/bin/wuxianpi-node" --help >/dev/null
printf 'Installed WuxianPi under %s\n' "$product_root"

