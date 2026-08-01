import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { createRuntimeServer } from "../dist/server.js";

test("Browser Host WebSocket registers, serves HTTP diagnostics, invokes, and caches events", { timeout: 20_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "wuxianpi-browser-host-"));
  const server = createRuntimeServer({
    host: "127.0.0.1", port: 0, agentDir: join(root, "agent"), idleTimeoutMs: 0, browserHostRequestTimeoutMs: 1_000,
  });
  const address = await server.start();
  const origin = `http://127.0.0.1:${address.port}`;
  const websocket = new WebSocket(`ws://127.0.0.1:${address.port}/v1/browser-host`);
  const messages = messageQueue(websocket);
  t.after(async () => {
    websocket.close();
    await server.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });

  const ready = await messages.waitFor((message) => message.type === "browser.runtime.ready");
  assert.equal(ready.protocol, "wuxianpi-browser-host-v1");
  assert.equal(ready.protocolVersion, 1);
  websocket.send(JSON.stringify({
    type: "browser.register",
    protocol: "wuxianpi-browser-host-v1",
    protocolVersion: 1,
    hostId: "native-browser",
    priority: 200,
    implementationVersion: "android-test",
    capabilities: { tabs: true, dom: true, frontendActions: true },
    tabs: [{ tabId: "tab-1", active: true, url: "https://example.com", title: "Example" }],
    context: { appId: "example", route: "/" },
  }));
  const registered = await messages.waitFor((message) => message.type === "browser.registered");
  assert.equal(registered.hostId, "native-browser");
  assert.equal(registered.preferred, true);

  let hosts = await jsonFetch(`${origin}/api/web/v1/browser/hosts`);
  assert.equal(hosts.data.preferredHostId, "native-browser");
  assert.equal(hosts.data.hosts[0].tabs[0].title, "Example");

  const invokeResponse = fetch(`${origin}/api/web/v1/browser/invoke`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method: "page.getText", target: { tabId: "tab-1" }, params: { visibleOnly: true } }),
  });
  const invoke = await messages.waitFor((message) => message.type === "browser.invoke" && message.method === "page.getText");
  assert.deepEqual(invoke.target, { hostId: "native-browser", tabId: "tab-1" });
  websocket.send(JSON.stringify({ type: "browser.result", id: invoke.id, ok: true, result: { text: "browser text" } }));
  const invoked = await (await invokeResponse).json();
  assert.equal(invoked.ok, true);
  assert.equal(invoked.data.hostId, "native-browser");
  assert.deepEqual(invoked.data.result, { text: "browser text" });

  const appInvokeResponse = fetch(`${origin}/api/web/v1/browser/invoke`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method: "app.invoke", params: { action: "createNote", args: { text: "hello" } } }),
  });
  const appInvoke = await messages.waitFor((message) => message.type === "browser.invoke" && message.method === "app.invoke");
  websocket.send(JSON.stringify({ type: "browser.result", id: appInvoke.id, ok: true, result: { noteId: 9 } }));
  assert.deepEqual((await (await appInvokeResponse).json()).data.result, { noteId: 9 });

  websocket.send(JSON.stringify({
    type: "browser.event", event: "app.contextChanged", tabId: "tab-1",
    context: { appId: "memo", serviceId: "yuanshengwuxianpi", route: "/apps/memo/" },
  }));
  await waitForCondition(async () => {
    hosts = await jsonFetch(`${origin}/api/web/v1/browser/hosts`);
    return hosts.data.hosts[0]?.context?.appId === "memo";
  });
  assert.equal(hosts.data.hosts[0].recentEvents.at(-1).event, "app.contextChanged");

});

test("Browser Host HTTP invoke reports an offline host with a stable error", { timeout: 20_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "wuxianpi-browser-offline-"));
  const server = createRuntimeServer({ host: "127.0.0.1", port: 0, agentDir: join(root, "agent"), idleTimeoutMs: 0 });
  const address = await server.start();
  t.after(async () => {
    await server.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  const response = await fetch(`http://127.0.0.1:${address.port}/api/web/v1/browser/invoke`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ method: "tabs.list" }),
  });
  const body = await response.json();
  assert.equal(response.status, 503);
  assert.equal(body.error.code, "browser_host_offline");
});

function messageQueue(websocket) {
  const queue = [];
  const waiters = [];
  websocket.on("message", (data) => {
    queue.push(JSON.parse(data.toString("utf8")));
    for (let index = 0; index < waiters.length; index++) {
      const waiter = waiters[index];
      const messageIndex = queue.findIndex(waiter.predicate);
      if (messageIndex < 0) continue;
      waiters.splice(index, 1);
      waiter.resolve(queue.splice(messageIndex, 1)[0]);
      index--;
    }
  });
  return {
    waitFor(predicate) {
      const index = queue.findIndex(predicate);
      if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]);
      return new Promise((resolve) => waiters.push({ predicate, resolve }));
    },
  };
}

async function jsonFetch(url, init) {
  const response = await fetch(url, init);
  const body = await response.json();
  assert.equal(response.ok, true, JSON.stringify(body));
  return body;
}

async function waitForCondition(condition) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition was not met");
}
