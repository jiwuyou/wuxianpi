# Termux Release Packaging

The release is split into independently downloadable layers:

```text
wuxianpi-web-<version>.tar.zst
wuxianpi-runtime-<version>.tar.zst
wuxianpi-base-<version>.tar.zst
wuxianpi-install-arm64-<version>.tar.zst
runtime-manifest.json
```

The official OpenHouse Runtime layer also carries the exact, Hub-approved Git
worktrees listed in `packaging/distributions/openhouse/packages.lock.json`.
They are imported as updateable `preinstalled` Packages on first Runtime start.

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

For a complete source build, run the ARM64 Termux entry point instead:

```bash
packaging/termux/build-source-release.sh --output release/dist
```

It builds Web and Runtime in clean temporary directories, runs
`npm prune --omit=dev` against the Runtime lock file, and places only that
production dependency closure in the Base layer. It must run on ARM64 so
platform-specific optional dependencies are selected for the target device.

The full ARM64 archive contains all three layers and a Termux installer. A Web
only update can publish just a new Web layer plus a new manifest while keeping
the Runtime and base versions unchanged.

This first skeleton uses SHA-256 for release integrity. It intentionally does
not add signing, authentication, rollback orchestration, or legacy migration.

## Service lifecycle

The Termux bundle registers the service-manager service with these fixed
values:

```text
id: yuanshengwuxianpi
origin: http://127.0.0.1:20765
residentByDefault: false
restart.mode: on-failure
```

Installation only writes the service definition. It does not start WuxianPi or
make it resident. A stopped WuxianPi service is the normal idle state; callers
start it through service-manager when the UI, model API, or agent is needed.
Only service-manager itself is expected to be kept alive by termux-services.
tmux is reserved for installation and repair commands and is not a production
service supervisor.

OpenHouse and other hosts may provide the complete service-manager definition
without changing the WuxianPi installer:

```bash
scripts/register-service.sh --spec /path/to/service.json
# or: generate-service-spec | scripts/register-service.sh --spec -
```

The script validates the service identity and required fields, then atomically
writes `services.d/<name>.json`. It only registers the definition; it does not
start the service or call service-manager APIs.
