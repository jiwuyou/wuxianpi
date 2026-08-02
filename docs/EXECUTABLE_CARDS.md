# Executable Cards

Executable Cards let the model prepare a native form and defer execution until the user submits it. They are a built-in WuxianPi capability and do not require an application-specific Web Extension.

## Model Tool

Every session includes the internal `present_executable_card` tool. It remains active independently of the assistant's visible tool preset.

A card defines fields and one workflow:

```json
{
  "title": "Create memo",
  "fields": [
    { "id": "title", "type": "text", "label": "Title" },
    { "id": "content", "type": "textarea", "label": "Content", "required": true },
    { "id": "tags", "type": "tags", "label": "Tags" }
  ],
  "workflow": {
    "type": "http",
    "method": "POST",
    "url": "http://127.0.0.1:37821/api/memos",
    "headers": { "content-type": "application/json" },
    "body": {
      "title": { "$field": "title" },
      "content": { "$field": "content" },
      "tags": { "$field": "tags" }
    }
  },
  "submitLabel": "Save memo"
}
```

The tool terminates the current model turn after returning the card. The workflow is not executed until the user clicks Submit.

## Workflows

The first contract version supports:

- `process`: execute a command with structured arguments.
- `shell`: execute a shell script using `-lc`.
- `script`: write and run generated Node.js, Python, or Bash source.
- `http`: send an HTTP request and parse JSON responses when possible.
- `sequence`: execute nested workflows in order.

Template values can reference form fields, environment variables, literals, and previous sequence results:

```json
{ "$field": "content" }
{ "$env": "HOME" }
{ "$literal": { "fixed": true } }
{ "$step": "0.stdout" }
```

Exact string shorthands are also accepted because models commonly emit them:

```json
"$field.content"
"$env.HOME"
"$step.0.stdout"
```

Executable Card workflows run with the same operating-system authority as the WuxianPi Runtime process. `process` should be preferred when values are command arguments; `shell` and `script` are available for arbitrary logic.

## Persistence

The card specification is stored in the `present_executable_card` tool result. Submissions and results are appended to the Pi session as:

- `wuxianpi.executable-card-submission`
- `wuxianpi.executable-card-result`

Snapshots aggregate these entries into `cards`, preserving card state across reloads and session branches.

## Web API

```text
POST /api/web/v1/sessions/:sessionId/cards/:cardId/submit
POST /api/web/v1/sessions/:sessionId/cards/:cardId/cancel
```

A submission includes `requestId`, `workflowDigest`, and `values`. The Runtime reads the workflow from the session rather than accepting a replacement workflow from the browser. `requestId` makes retries idempotent.

The Runtime emits `card_updated` session events as execution starts and completes. Process output is bounded, executions have a timeout, and cancellation terminates the spawned process group.
