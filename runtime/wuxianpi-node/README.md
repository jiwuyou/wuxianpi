# WuxianPi Node Runtime

This package hosts the WuxianPi HTTP and WebSocket runtime backed by the Pi SDK.
It is intentionally independent from the Android host and the Web UI build.

## Requirements

- Node.js 22.19.0 or newer
- A writable Pi agent directory (defaults to the Pi SDK location)

## Development

```sh
npm ci
npm run typecheck
npm test
```

`npm test` builds `dist/` before running the Node test suite. Generated output,
dependencies, coverage, and caches are not source-controlled.

## Run

```sh
npm run build
node dist/index.js --listen 127.0.0.1:8765
```

Supported options:

- `--listen HOST:PORT`
- `--agent-dir PATH`
- `--idle-timeout-ms N`
- `--web-root PATH`
- `--preferred-web-ui-url URL`

The corresponding environment variables are `OPENHOUSE_PI_LISTEN`,
`PI_CODING_AGENT_DIR`, `OPENHOUSE_PI_IDLE_TIMEOUT_MS`, `WUXIANPI_WEB_ROOT`,
and `OPENHOUSE_AIONUI_ORIGIN`.

## Stable Host Surface

- Health: `GET /health`
- UI metadata: `GET /v1/ui/metadata`
- Native WebSocket: `/v1/ws`
- Protocol: `wuxianpi-sdk-v1`, version `2`
- Web and model API root: `/api/web/v1`

The Web UI may be served by passing `--web-root`, but its source and build output
belong to `apps/web` rather than this package.
