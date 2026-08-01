# Browser Host Contract v1

The Browser Host is an Android-owned controlled browser. WuxianPi Runtime owns
request routing and Pi tool exposure, while Android owns tabs, WebView state,
DOM input, screenshots, and optional app-level JavaScript actions.

## Transport

Android connects to:

```text
ws://127.0.0.1:<runtime-port>/v1/browser-host
```

Frames are UTF-8 JSON. The protocol name is `wuxianpi-browser-host-v1` and the
protocol version is `1`. Binary frames are rejected. The Runtime keeps all host
and pending-request state in memory.

After the WebSocket opens, Runtime sends:

```json
{
  "type": "browser.runtime.ready",
  "protocol": "wuxianpi-browser-host-v1",
  "protocolVersion": 1,
  "connectionId": "uuid"
}
```

Android must then register before sending results or events:

```json
{
  "type": "browser.register",
  "protocol": "wuxianpi-browser-host-v1",
  "protocolVersion": 1,
  "hostId": "native-browser",
  "priority": 200,
  "implementationVersion": "12",
  "capabilities": {
    "tabs": true,
    "javascript": true,
    "dom": true,
    "touch": true,
    "screenshot": true,
    "frontendActions": true
  },
  "tabs": [],
  "context": null
}
```

The preferred conventional priorities are `200` for `native-browser` and `100`
for `all-in-one`. Runtime chooses the highest priority and uses the conventional
Native/All-in-One order as a tie-breaker.

## Invocation

Runtime sends transport-neutral methods:

```json
{
  "type": "browser.invoke",
  "protocol": "wuxianpi-browser-host-v1",
  "protocolVersion": 1,
  "id": "request-id",
  "method": "page.getText",
  "target": {
    "hostId": "native-browser",
    "tabId": "tab-3"
  },
  "params": {}
}
```

Android returns exactly one correlated result:

```json
{
  "type": "browser.result",
  "id": "request-id",
  "ok": true,
  "result": { "text": "page text" }
}
```

```json
{
  "type": "browser.result",
  "id": "request-id",
  "ok": false,
  "error": {
    "code": "tab_not_found",
    "message": "The requested tab does not exist",
    "details": {}
  }
}
```

Stable method families are:

- `host.describe`, `host.status`, and `host.capabilities`.
- `tabs.list`, `tabs.open`, `tabs.activate`, and `tabs.close`.
- `page.navigate`, `page.reload`, `page.back`, `page.forward`,
  `page.evaluate`, `page.getText`, `page.getHtml`, `page.click`, `page.fill`,
  `page.wait`, `page.tap`, `page.type`, `page.scroll`, `page.screenshot`, and
  `page.run`.
- `cdp.invoke` for the supported compatibility subset.
- `app.getContext`, `app.describe`, `app.listActions`, and `app.invoke`.

Runtime core does not register Pi tools for these methods globally. The
optional `io.wuxianpi.browser-tools` WuxianPi Package contributes the
assistant-selectable `browser_operation` and `app_action` tools. Installing the
Package does not enable its extension until a user or assistant binding selects
the contribution.

Method-specific payloads remain in `params`; host and tab selection remain in
`target`. This keeps Broadcast, WebSocket, HTTP, CLI, and Pi adapters from
defining separate browser semantics.

## Events and cached context

Android may emit:

```json
{
  "type": "browser.event",
  "event": "app.contextChanged",
  "at": "2026-08-01T12:00:00.000Z",
  "tabId": "tab-3",
  "context": {
    "appId": "memo",
    "serviceId": "yuanshengwuxianpi",
    "route": "/apps/memo/"
  },
  "data": {}
}
```

An event may include complete `tabs` or `context` snapshots. Runtime caches the
latest snapshots and a bounded recent event list. Hosts must resend full tabs
and context in registration after reconnecting.

Recommended events include `host.ready`, `tab.created`, `tab.closed`,
`tab.activated`, `page.started`, `page.finished`, `page.titleChanged`, and
`app.contextChanged`.

## Reconnect and failure behavior

- A new connection registering the same `hostId` replaces the old connection.
- Pending requests on a disconnected or replaced connection fail immediately.
- Late results after timeout are ignored.
- If no host is selected explicitly, Runtime uses the preferred connected host.
- HTTP and Pi adapters surface stable error codes such as
  `browser_host_offline`, `browser_host_timeout`, `browser_host_disconnected`,
  and the Android-provided action error code.

The machine-readable envelope schema is `browser-host.v1.schema.json`.
