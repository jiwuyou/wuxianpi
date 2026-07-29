# WuxianPi Web

This directory is the independently buildable WuxianPi Web UI. It is a Vite
SPA and communicates with the WuxianPi Node Runtime over its HTTP and
WebSocket Host contract.

## Development

```sh
npm ci
npm run dev
```

The default development port is `30141`. The Runtime API origin can be
configured through the existing Web API client environment settings.

## Checks

```sh
npm run typecheck
npm test
npm run build
```

The release build output is `dist/`. It is consumed by
`packaging/termux/build-release.sh`; dependencies and build output are not
included in source control.
