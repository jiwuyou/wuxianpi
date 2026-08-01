import assert from "node:assert/strict";
import test from "node:test";
import { BrowserHostRegistry } from "../dist/browser-host-registry.js";

test("registry selects the preferred host and correlates results", async () => {
  const registry = new BrowserHostRegistry({ defaultTimeoutMs: 1_000 });
  const allInOne = connection("all-connection");
  const native = connection("native-connection");
  registry.register(allInOne, registration("all-in-one", 100));
  registry.register(native, registration("native-browser", 200));

  const description = registry.describe();
  assert.equal(description.preferredHostId, "native-browser");
  assert.deepEqual(description.hosts.map((host) => host.hostId), ["native-browser", "all-in-one"]);

  const pending = registry.invoke({ method: "page.getText", target: { tabId: "tab-1" }, params: { visibleOnly: true } });
  const sent = native.sent.at(-1);
  assert.equal(sent.type, "browser.invoke");
  assert.equal(sent.method, "page.getText");
  assert.deepEqual(sent.target, { hostId: "native-browser", tabId: "tab-1" });
  assert.deepEqual(sent.params, { visibleOnly: true });
  assert.equal(registry.acceptResult(native.id, { type: "browser.result", id: sent.id, ok: true, result: { text: "hello" } }), true);
  assert.deepEqual(await pending, { requestId: sent.id, hostId: "native-browser", result: { text: "hello" } });
  assert.equal(registry.acceptResult(native.id, { type: "browser.result", id: "late", ok: true, result: {} }), false);

  const failed = registry.invoke({ method: "page.click", target: { tabId: "tab-1" }, params: { selector: "#missing" } });
  const failedRequest = native.sent.at(-1);
  registry.acceptResult(native.id, {
    type: "browser.result",
    id: failedRequest.id,
    ok: false,
    error: { code: "selector_not_found", message: "No matching element", details: { selector: "#missing" } },
  });
  await assert.rejects(failed, (error) => error.code === "selector_not_found" && error.details.remoteDetails.selector === "#missing");
});

test("registry caches browser events, tabs, and app context", () => {
  const registry = new BrowserHostRegistry({ maxEventsPerHost: 2 });
  const native = connection("native-events");
  registry.register(native, registration("native-browser", 200));
  registry.acceptEvent(native.id, {
    type: "browser.event",
    event: "tab.activated",
    tabId: "tab-2",
    tabs: [{ tabId: "tab-2", active: true, url: "https://example.com" }],
  });
  registry.acceptEvent(native.id, {
    type: "browser.event",
    event: "app.contextChanged",
    context: { appId: "memo", serviceId: "yuanshengwuxianpi" },
  });
  registry.acceptEvent(native.id, { type: "browser.event", event: "page.finished", data: { ok: true } });

  const host = registry.describe().hosts[0];
  assert.equal(host.tabs[0].tabId, "tab-2");
  assert.deepEqual(host.context, { appId: "memo", serviceId: "yuanshengwuxianpi" });
  assert.deepEqual(host.recentEvents.map((event) => event.event), ["app.contextChanged", "page.finished"]);
});

test("registry rejects timeout, disconnect, and same-host reconnect requests", async () => {
  const registry = new BrowserHostRegistry({ defaultTimeoutMs: 15 });
  const first = connection("first");
  registry.register(first, registration("native-browser", 200));

  await assert.rejects(registry.invoke({ method: "tabs.list" }), (error) => error.code === "browser_host_timeout");

  const disconnected = registry.invoke({ method: "tabs.list", timeoutMs: 1_000 });
  registry.disconnect(first.id, "test disconnect");
  await assert.rejects(disconnected, (error) => error.code === "browser_host_disconnected");

  registry.register(first, registration("native-browser", 200));
  const replaced = registry.invoke({ method: "tabs.list", timeoutMs: 1_000 });
  const second = connection("second");
  registry.register(second, registration("native-browser", 200));
  await assert.rejects(replaced, (error) => error.code === "browser_host_replaced");
  assert.deepEqual(first.closed, [{ code: 4001, reason: "browser host replaced" }]);
  assert.equal(registry.describe().hosts[0].connectionId, second.id);
});

function registration(hostId, priority) {
  return {
    type: "browser.register",
    protocol: "wuxianpi-browser-host-v1",
    protocolVersion: 1,
    hostId,
    priority,
    implementationVersion: "test",
    capabilities: { tabs: true, frontendActions: true },
    tabs: [{ tabId: "tab-1", active: true, url: "https://example.com" }],
    context: { appId: "example" },
  };
}

function connection(id) {
  return {
    id,
    sent: [],
    closed: [],
    send(message) { this.sent.push(message); },
    close(code, reason) { this.closed.push({ code, reason }); },
  };
}
