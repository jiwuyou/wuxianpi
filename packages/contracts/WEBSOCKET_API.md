# WebSocket Contract

Native chat connects to:

```text
ws://127.0.0.1:20765/v1/ws
```

The transport name is `wuxianpi-sdk-v1`; the current protocol version is `2`.
Frames are UTF-8 JSON. Binary frames are rejected.

## Ready event

The Runtime sends a ready event after connection:

```json
{
  "type": "runtime.ready",
  "connectionId": "uuid",
  "version": "0.1.0",
  "protocol": "wuxianpi-sdk-v1",
  "protocolVersion": 2,
  "capabilities": {}
}
```

## Request and response

```json
{
  "id": "request-id",
  "type": "session.prompt",
  "sessionId": "session-id",
  "payload": { "message": "hello" }
}
```

```json
{
  "id": "request-id",
  "ok": true,
  "result": {},
  "connectionId": "uuid"
}
```

Errors retain the request ID and return `error.code`, `error.message`, and an
optional `error.details`.

## Required Host command surface

Contract v1 preserves the command families already used by the Android
client:

- Runtime: `runtime.status`.
- Models: `model.status`, `model.login`, `model.logout`, `model.test`,
  `model.reload`, `model.setDefault`.
- Sessions: `session.list`, `session.history`, `session.create`,
  `session.open`, `session.close`, `session.prompt`, `session.steer`,
  `session.followUp`, `session.abort`, `session.compact`, `session.new`,
  `session.switch`, `session.fork`, `session.import`, `session.state`,
  `session.entries`, and `session.setModel`.
- Extension UI: `extension.uiResponse`.

## Agent events

Streaming events use this envelope:

```json
{
  "type": "agent.event",
  "connectionId": "uuid",
  "sessionId": "session-id",
  "eventStreamId": "stream-id",
  "sequence": 1,
  "payload": {}
}
```

Clients should acknowledge events when the `eventAck` capability is present.
Adding optional response fields, event payload fields, capabilities, or new
commands does not require a contract version change. Removing or changing the
meaning of the fields and commands above does.

The controlled-browser host uses the separate `/v1/browser-host` path and the
`wuxianpi-browser-host-v1` contract documented in `BROWSER_HOST_CONTRACT.md`.
