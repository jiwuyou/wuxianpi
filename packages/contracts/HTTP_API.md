# HTTP Contract

Default Runtime origin: `http://127.0.0.1:20765`.

The mobile Web API is rooted at:

```text
http://127.0.0.1:20765/api/web/v1
```

All examples below use the existing success envelope:

```json
{ "ok": true, "data": {} }
```

Errors use an HTTP error status and:

```json
{ "ok": false, "error": { "code": "...", "message": "..." } }
```

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

## Automation Turn Bridge

The local `automation-turn.v1` API is rooted at `/api/automation/v1`. It is a
thin bridge for trusted local programs to append a visible automation message
or trigger one Agent Turn in an existing WuxianPi conversation. It does not
define scheduling, workflows, task execution, or program distribution.

The Runtime advertises support as `capabilities.automationTurn = 1`. The API
does not enable CORS. Owner operations use the bearer token stored with mode
`0600` at `~/.pi/agent/wuxianpi/automation-owner.token`; task operations use the
scoped token returned when the binding is created. Only token hashes are stored
in `automation-turn.sqlite`.

| Method | Path | Authentication | Purpose |
| --- | --- | --- | --- |
| `POST` | `/api/automation/v1/bindings` | owner token | Bind `taskId`, `conversationId`, and canonical `taskRoot`; return a task token once |
| `DELETE` | `/api/automation/v1/bindings/:taskId` | owner token | Revoke a binding and cancel its active Turns |
| `POST` | `/api/automation/v1/messages` | task token | Append a visible `role: custom` automation message without starting the Agent |
| `POST` | `/api/automation/v1/turns` | task token | Append the automation input and start one serialized Agent Turn |
| `GET` | `/api/automation/v1/turns/:turnId?waitMs=30000` | task token | Read or bounded-wait for a Turn, up to 30 seconds per request |
| `POST` | `/api/automation/v1/turns/:turnId/cancel` | task token | Cancel a queued or running Turn |

Message and Turn requests contain `taskId`, `runId`, optional matching
`conversationId`, `message`, optional `artifactRefs`, and a required
`idempotencyKey`. Artifact references must resolve to existing files inside the
bound canonical task root, including after symlink resolution.

Turn idempotency is scoped by `(taskId, idempotencyKey)`. Message idempotency is
scoped by `(taskId, runId, idempotencyKey)`. A concurrent duplicate message
waits for the original append and returns the same message record. A completed
duplicate returns HTTP 200 with `created: false`; the original returns HTTP 201
with `created: true`. A failed append or a `pending` record left by an uncertain
process interruption is never appended again and returns HTTP 409 on retry.

Automation inputs are persisted as custom messages with
`customType: "wuxianpi.automation-turn"` and details containing `source`,
`kind`, `taskId`, `runId`, `conversationId`, `artifactRefs`, and
`idempotencyKey`. They do not impersonate ordinary user messages. Turns in one
conversation share the existing session serialization lane.

## Assistant, Workspace, and session ownership

The user-facing Main Assistant is the WuxianPi Profile equivalent. The HTTP
contract keeps `assistantId`, `workspaceId`, and `cwd` independent:

- `assistantId` selects identity, memory, capabilities, and Package bindings;
- `workspaceId` selects registered Workspace instructions and memory;
- `cwd` is the actual Pi execution directory and native session grouping key.

Pi SDK/source and native JSONL files are unchanged. WuxianPi stores only the
ownership mapping and Workspace registry in
`~/.pi/agent/wuxianpi/state.sqlite`. The Runtime requires Node.js `>=22.19.0`
for `node:sqlite`.

### Workspace endpoints

| Method | Path | Behavior |
| --- | --- | --- |
| `GET` | `/api/web/v1/workspaces` | List active Workspaces |
| `GET` | `/api/web/v1/workspaces?includeArchived=true` | Include archived Workspaces |
| `POST` | `/api/web/v1/workspaces` | Register a Workspace and create its context files |
| `GET` | `/api/web/v1/workspaces/:id` | Read one Workspace and its context |
| `PATCH` | `/api/web/v1/workspaces/:id` | Update metadata, instructions, or memory |
| `DELETE` | `/api/web/v1/workspaces/:id` | Delete a Workspace that owns no sessions |

Create request:

```http
POST /api/web/v1/workspaces
Content-Type: application/json

{
  "id": "wuxianpi-project",
  "name": "WuxianPi",
  "rootCwd": "/data/data/com.termux/files/home/projects/wuxianpi",
  "instructions": "Use the repository checks before integration.\n",
  "memory": "The production Runtime is runtime/wuxianpi-node.\n"
}
```

`id` is optional; the Runtime generates one when omitted. The response is:

```json
{
  "ok": true,
  "data": {
    "workspace": {
      "id": "wuxianpi-project",
      "name": "WuxianPi",
      "rootCwd": "/data/data/com.termux/files/home/projects/wuxianpi",
      "archived": false,
      "instructions": "Use the repository checks before integration.\n",
      "memory": "The production Runtime is runtime/wuxianpi-node.\n"
    }
  }
}
```

`PATCH` accepts any subset of `name`, `rootCwd`, `archived`, `instructions`,
and `memory`. A new `rootCwd` is rejected when it would exclude an existing
session `cwd`. Deletion is rejected with `workspace_has_sessions` while any
session is bound to the Workspace. Successful deletion returns:

```json
{ "ok": true, "data": { "id": "wuxianpi-project" } }
```

### Session endpoints

| Method | Path | Behavior |
| --- | --- | --- |
| `GET` | `/api/web/v1/sessions` | List Pi sessions with explicit ownership |
| `GET` | `/api/web/v1/sessions?assistantId=:id` | Filter by Main Assistant |
| `GET` | `/api/web/v1/sessions?workspaceId=:id` | Filter by Workspace |
| `POST` | `/api/web/v1/sessions` | Create a bound WuxianPi session |

Web session creation requires `assistantId`:

```http
POST /api/web/v1/sessions
Content-Type: application/json

{
  "assistantId": "main",
  "workspaceId": "wuxianpi-project",
  "cwd": "/data/data/com.termux/files/home/projects/wuxianpi/runtime",
  "provider": "openai",
  "modelId": "gpt-5.6",
  "thinkingLevel": "high",
  "toolNames": ["read", "bash"]
}
```

`workspaceId`, `cwd`, model, thinking, and tool overrides are optional. When a
Workspace is supplied, omitted `cwd` defaults to its `rootCwd`; an explicit
`cwd` must be equal to or below that root. Without a Workspace, omitted `cwd`
defaults to the Assistant directory.

Creation returns the Pi session identity plus WuxianPi ownership:

```json
{
  "ok": true,
  "data": {
    "sessionId": "019f...",
    "sessionPath": "/home/u/.pi/agent/sessions/--data-.../2026-..._019f....jsonl",
    "cwd": "/data/data/com.termux/files/home/projects/wuxianpi/runtime",
    "isRunning": false,
    "isIdle": true,
    "assistantId": "main",
    "workspaceId": "wuxianpi-project",
    "workspaceName": "WuxianPi",
    "ownershipState": "bound"
  }
}
```

Session list, history, status, and snapshot responses expose the same ownership
fields. Sessions created directly by Pi have no SQLite binding and return:

```json
{
  "assistantId": null,
  "workspaceId": null,
  "ownershipState": "unbound"
}
```

WuxianPi never derives Assistant ownership from `cwd`. Fork and new-session
operations inherit the source binding; existing bindings cannot be reassigned
to another Assistant or Workspace.

## Functional-assistant bindings

`GET /api/web/v1/packages/bindings/:assistantId` returns the Assistant's active
contribution IDs, experience spaces, and functional-assistant settings:

```json
{
  "ok": true,
  "data": {
    "binding": {
      "assistantId": "main",
      "enabledContributionIds": ["io.example.ops/assistant.ops"],
      "experienceSpaces": {},
      "functionalAssistants": {
        "io.example.ops/assistant.ops": { "sharingMode": "hybrid" }
      },
      "updatedAt": "2026-08-04T12:00:00.000Z"
    }
  }
}
```

Functional assistants are stateful Skills, not independent Pi sessions. Valid
sharing modes are `isolated`, `shared`, and `hybrid`; new bindings default to
`hybrid`. Package code is installed once. State is retained across Package
updates, binding removal, and ordinary uninstall. A Package uninstall with
`?purgeData=true` explicitly deletes its mutable data and functional-assistant
state.

## Model setup endpoints

The Android model UI and WuxianPi Web use the same Runtime-owned model setup
service:

| Method | Path | Behavior |
| --- | --- | --- |
| `GET` | `/api/web/v1/models/setup` | Read presets, providers, models, auth state, and default model |
| `POST` | `/api/web/v1/models/fetch` | Discover models from an unsaved draft |
| `POST` | `/api/web/v1/models/test` | Test a saved model or unsaved draft without applying it |
| `POST` | `/api/web/v1/models/apply` | Validate and atomically apply model setup |

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
