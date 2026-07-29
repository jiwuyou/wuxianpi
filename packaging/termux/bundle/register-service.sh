#!/data/data/com.termux/files/usr/bin/sh
set -eu

: "${HOME:?HOME is required}"
product_root=${WUXIANPI_INSTALL_ROOT:-$HOME/.local/share/wuxianpi}
service_dir=${OPENHOUSEAI_CONFIG_DIR:-$HOME/.config/openhouseai}/service-manager/services.d
spec=$service_dir/pi-agent.json
mkdir -p "$service_dir" "$HOME/workspace" "$HOME/.pi/agent/sessions"
tmp=$(mktemp "${TMPDIR:-${PREFIX:-/data/data/com.termux/files/usr}/tmp}/pi-agent.json.XXXXXX")

cat > "$tmp" <<JSON
{
  "name": "pi-agent",
  "description": "WuxianPi Web and Node Runtime",
  "provider": "termux-process",
  "command": ["sh", "-lc", "wuxianpi-node-start & child=\$!; trap 'kill -TERM \$child 2>/dev/null; wait \$child 2>/dev/null || true' TERM INT HUP; wait \$child"],
  "working_dir": "$HOME/workspace",
  "env": {
    "HOME": "$HOME",
    "PATH": "$HOME/.local/bin:${PREFIX:-/data/data/com.termux/files/usr}/bin:/system/bin",
    "PI_CODING_AGENT_DIR": "$HOME/.pi/agent",
    "OPENHOUSE_PI_RUNTIME_ORIGIN": "http://127.0.0.1:8765",
    "WUXIANPI_INSTALL_ROOT": "$product_root",
    "WUXIANPI_WEB_ROOT": "$product_root/web"
  },
  "runtime": {"strategy": "termux-process", "runtime": "termux", "platform": "android-arm64"},
  "restart": {"mode": "always", "max_retries": 0},
  "health": [{"type": "http", "url": "http://127.0.0.1:8765/health", "interval": "15s", "timeout": "3s"}],
  "enabled": true,
  "tags": ["group:local-stack", "wuxianpi", "agent", "openhouse-component:pi-agent"]
}
JSON

node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$tmp"
mv "$tmp" "$spec"
printf 'Registered service-manager service: %s\n' "$spec"

