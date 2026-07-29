# Termux Release Packaging

The release is split into independently downloadable layers:

```text
wuxianpi-web-<version>.tar.zst
wuxianpi-runtime-<version>.tar.zst
wuxianpi-base-<version>.tar.zst
wuxianpi-install-arm64-<version>.tar.zst
runtime-manifest.json
```

Expected prepared input layouts:

- Web: static build with `index.html` at its root.
- Runtime: compiled Runtime with `dist/index.js`; it must not contain
  `node_modules`.
- Base: stable `node_modules`, including
  `@earendil-works/pi-coding-agent`.

Example:

```bash
packaging/termux/build-release.sh \
  --version 0.1.0 \
  --web-dir apps/web/dist \
  --runtime-dir runtime/wuxianpi-node/release \
  --base-dir runtime/wuxianpi-node/release-base \
  --output release/dist
```

The full ARM64 archive contains all three layers and a Termux installer. A Web
only update can publish just a new Web layer plus a new manifest while keeping
the Runtime and base versions unchanged.

This first skeleton uses SHA-256 for release integrity. It intentionally does
not add signing, authentication, rollback orchestration, or legacy migration.

