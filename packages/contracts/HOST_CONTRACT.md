# Host Contract v1

Android Host and WuxianPi are independently releasable products. The Host
contract is intentionally small and follows the behavior already present in
the Android application.

## Compatibility

- Contract version: `1`.
- A WuxianPi release declares `minHostVersion` in `runtime-manifest.json`.
- `minHostVersion` refers to the Host contract version, not an APK
  `versionCode`.
- Host contract version `1` supports Runtime protocol
  `wuxianpi-sdk-v1` version `2`.
- A Host must reject a release only when `minHostVersion` is greater than the
  Host contract version it implements.

## Host responsibilities

- Install or update the published WuxianPi artifacts in Termux.
- Ask service-manager to start, stop, and recover `pi-agent`.
- Open the Web URL returned by `GET /v1/ui/metadata`.
- Use HTTP for model setup and WebSocket for native chat/session behavior.
- Provide Android-only bridges and permissions when a feature needs Android.

## Runtime responsibilities

- Own Web UI, Pi SDK integration, model setup, sessions, history, MCP, Skills,
  and extensions.
- Preserve Pi data in `$HOME/.pi/agent` across updates.
- Serve the fixed loopback endpoints and protocol documented here.
- Publish a release manifest with artifact versions, sizes, and SHA-256 values.

## Non-contract details

Android must not read or assume:

- Runtime source or Node module directories.
- Web build output paths.
- Pi Registry implementation details.
- `models.json`, authentication files, or session files as an API substitute.
- Internal layer installation directories.

The stable filesystem contract is limited to Pi data at `$HOME/.pi/agent` and
the default workspace at `$HOME/workspace`.

