# WuxianPi Contracts

This directory freezes the Android Host-facing contract for WuxianPi. The
contract describes observable behavior only; Android must not depend on the
Runtime source tree, Node module layout, or Web build output.

Current contract files:

- `runtime-manifest.v1.json`: machine-readable Host contract.
- `release-manifest.schema.json`: schema for generated release manifests.
- `HOST_CONTRACT.md`: compatibility and ownership rules.
- `HTTP_API.md`: fixed HTTP endpoints used by Android.
- `WEBSOCKET_API.md`: fixed native chat transport.
- `SERVICE_CONTRACT.md`: Termux and service-manager integration.

`hostContractVersion` is a product protocol version, not an Android
`versionCode`. A release declares `minHostVersion` against this contract
version. Contract version `1` represents the behavior already implemented by
the current Android Host and Runtime.

