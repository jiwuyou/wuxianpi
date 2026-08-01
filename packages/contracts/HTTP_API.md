# HTTP Contract

Default Runtime origin: `http://127.0.0.1:20765`.

## Host endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Runtime liveness and protocol metadata |
| `GET` | `/v1/status` | Detailed Runtime and session status |
| `GET` | `/v1/ui/metadata` | Preferred and fallback Web UI locations |
| `GET` | `/` | Bundled Web UI, or Runtime metadata when no static UI is present |

`GET /health` must return HTTP 200 with at least:

```json
{
  "ok": true,
  "protocol": "wuxianpi-sdk-v1",
  "protocolVersion": 2,
  "version": "0.1.0",
  "uiMetadataPath": "/v1/ui/metadata"
}
```

`GET /v1/ui/metadata` must return `preferred`, `fallback`, `webApiUrl`, and
`capabilities`. The Host should open `preferred.url` when usable and otherwise
use the advertised fallback. UI IDs and ports are metadata, not fixed Host
constants.

## Model setup endpoints

The Android model UI and WuxianPi Web use the same Runtime-owned model setup
service:

| Method | Path | Behavior |
| --- | --- | --- |
| `GET` | `/api/web/v1/models/setup` | Read presets, providers, models, auth state, and default model |
| `POST` | `/api/web/v1/models/fetch` | Discover models from an unsaved draft |
| `POST` | `/api/web/v1/models/test` | Test a saved model or unsaved draft without applying it |
| `POST` | `/api/web/v1/models/apply` | Validate and atomically apply model setup |

Responses use the existing envelope:

```json
{ "ok": true, "data": {} }
```

Errors use an HTTP error status and:

```json
{ "ok": false, "error": { "code": "...", "message": "..." } }
```

The Runtime remains the authority for provider definitions, API keys, model
registry reloads, and global defaults. Android may store named
`provider/modelId` bindings, but must not maintain an independent provider
configuration as the source of truth.

## Browser Host diagnostics

These endpoints use the in-memory Browser Host registry described in
`BROWSER_HOST_CONTRACT.md`:

| Method | Path | Behavior |
| --- | --- | --- |
| `GET` | `/api/web/v1/browser/hosts` | List connected hosts, preferred host, capabilities, tabs, cached context, recent events, and pending count |
| `POST` | `/api/web/v1/browser/invoke` | Invoke a transport-neutral Browser Host method and wait for its correlated result |

Example invocation:

```json
{
  "method": "page.getText",
  "hostId": "native-browser",
  "target": { "tabId": "tab-3" },
  "params": {},
  "timeoutMs": 30000
}
```

`hostId` is optional and defaults to the preferred connected host. Successful
responses return `requestId`, `hostId`, and the Android result under `data`.
Disconnected hosts return HTTP 503 with `browser_host_offline`; timeouts return
HTTP 504 with `browser_host_timeout`.

The Runtime endpoint is core functionality. Pi-facing wrappers are supplied by
the optional `io.wuxianpi.browser-tools` Package and are not installed or
enabled globally by the Runtime.
