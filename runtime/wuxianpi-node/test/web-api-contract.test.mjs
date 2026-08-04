import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRuntimeServer } from "../dist/server.js";

test("AI Web contract covers session controls and complete snapshots", { timeout: 30_000 }, async (t) => {
  const fixture = await startFixture(t, "session-contract");
  const created = await jsonFetch(`${fixture.base}/api/web/v1/sessions`, {
    method: "POST", headers: jsonHeaders,
    body: JSON.stringify({ assistantId: "wuxianpi", cwd: fixture.root, toolNames: ["read"], thinkingLevel: "low" }),
  });
  const sessionId = created.data.sessionId;
  const slot = await fixture.server.registry.getOrOpen(sessionId);
  slot.runtime.session.sessionManager.appendMessage({ role: "user", content: "seed", timestamp: Date.now() });
  const userEntryId = slot.runtime.session.sessionManager.getLeafId();
  assert.ok(userEntryId);
  slot.runtime.session.sessionManager.appendMessage({
    role: "assistant", content: [{ type: "text", text: "seed response" }], api: "openai-responses",
    provider: "openai", model: "seed", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now(),
  });
  const leafId = slot.runtime.session.sessionManager.getLeafId();
  assert.ok(leafId);

  let snapshot = await jsonFetch(`${fixture.base}/api/web/v1/sessions/${sessionId}/snapshot`);
  assert.deepEqual(snapshot.data.entries, [userEntryId, leafId]);
  assert.equal(snapshot.data.sessionEntries.some((entry) => entry.id === leafId), true);
  assert.equal(Array.isArray(snapshot.data.tree), true);
  assert.equal(Array.isArray(snapshot.data.state.tools), true);
  assert.equal(Array.isArray(snapshot.data.state.extensionStatuses), true);
  assert.equal(Array.isArray(snapshot.data.state.extensionWidgets), true);
  assert.deepEqual(snapshot.data.state.activeToolNames, ["read"]);
  assert.equal(Array.isArray(snapshot.data.state.slashCommands.commands), true);
  assert.equal(typeof snapshot.data.state.sessionStats, "object");
  assert.equal(snapshot.data.state.assistantId, "wuxianpi");
  assert.equal(snapshot.data.state.ownershipState, "bound");

  const updatedTools = await jsonFetch(`${fixture.base}/api/web/v1/sessions/${sessionId}/tools`, {
    method: "PATCH", headers: jsonHeaders, body: JSON.stringify({ toolNames: ["read", "pi:read", "bash"] }),
  });
  assert.deepEqual(updatedTools.data.activeToolNames, ["read", "bash"]);
  assert.equal(Array.isArray(updatedTools.data.warnings), true);
  assert.equal(updatedTools.data.warnings.length, 0);

  await jsonFetch(`${fixture.base}/api/web/v1/sessions/${sessionId}`, {
    method: "PATCH", headers: jsonHeaders, body: JSON.stringify({ name: "Renamed" }),
  });
  snapshot = await jsonFetch(`${fixture.base}/api/web/v1/sessions/${sessionId}/snapshot?leafId=${leafId}`);
  assert.equal(snapshot.data.state.sessionName, "Renamed");

  for (const endpoint of ["tree", "commands", "stats", "entries", "tools"]) {
    const response = await fetch(`${fixture.base}/api/web/v1/sessions/${sessionId}/${endpoint}`);
    assert.equal(response.ok, true, `${endpoint} returned ${response.status}`);
  }
  await jsonFetch(`${fixture.base}/api/web/v1/sessions/${sessionId}/navigate`, {
    method: "POST", headers: jsonHeaders, body: JSON.stringify({ targetId: leafId }),
  });
  let extensionRequestId;
  const unsubscribe = fixture.server.registry.subscribe((event) => {
    if (event.payload?.type === "extension_ui_request") extensionRequestId = event.payload.requestId;
  });
  const confirmation = slot.ui.context.confirm("Confirm", "Continue?");
  assert.ok(extensionRequestId);
  await jsonFetch(`${fixture.base}/api/web/v1/sessions/${sessionId}/extension-ui-responses`, {
    method: "POST", headers: jsonHeaders, body: JSON.stringify({ id: extensionRequestId, cancelled: true }),
  });
  assert.equal(await confirmation, false);
  unsubscribe();
  const fork = await jsonFetch(`${fixture.base}/api/web/v1/sessions/${sessionId}/fork`, {
    method: "POST", headers: jsonHeaders, body: JSON.stringify({ entryId: userEntryId }),
  });
  assert.equal(fork.data.newSessionId, fork.data.sessionId);
});

test("assistant lifecycle, capabilities, TTS, MCP adapter status, and extension bridge match the UI contract", { timeout: 30_000 }, async (t) => {
  const fixture = await startFixture(t, "resource-contract");
  const extensionRoot = join(fixture.agentDir, "wuxianpi", "extensions", "demo");
  await mkdir(extensionRoot, { recursive: true });
  await writeFile(join(extensionRoot, "wuxianpi-extension.json"), JSON.stringify({
    schemaVersion: 1, apiVersion: "1", id: "demo", name: "Demo", version: "1.0.0", entry: "index.html",
    permissions: ["assistant.read", "storage.read", "storage.write", "ui.notify"],
  }));
  await writeFile(join(extensionRoot, "index.html"), "demo");

  const assistants = await jsonFetch(`${fixture.base}/api/web/v1/assistants`);
  assert.equal(assistants.data.assistants.some((assistant) => assistant.id === "wuxianpi"), true);
  const createdWithAvatar = await jsonFetch(`${fixture.base}/api/web/v1/assistants`, {
    method: "POST", headers: jsonHeaders, body: JSON.stringify({
      id: "avatar-create", manifest: { schemaVersion: 1, name: "Avatar Create" },
      avatarAsset: { action: "upload", mimeType: "image/png", data: ONE_PIXEL_PNG },
    }),
  });
  assert.match(createdWithAvatar.data.assistant.manifest.avatar, /^\.assets\/avatar-[a-f0-9]{16}\.png$/);
  assert.equal((await fetch(`${fixture.base}/api/web/v1/assistants/avatar-create/avatar`)).status, 200);
  await jsonFetch(`${fixture.base}/api/web/v1/assistants/avatar-create`, {
    method: "PATCH", headers: jsonHeaders, body: JSON.stringify({ manifest: { avatar: "../outside.png" } }),
  });
  assert.equal((await fetch(`${fixture.base}/api/web/v1/assistants/avatar-create/avatar`)).status, 400);
  const copied = await jsonFetch(`${fixture.base}/api/web/v1/assistants/wuxianpi/copy`, {
    method: "POST", headers: jsonHeaders, body: JSON.stringify({ targetId: "copied" }),
  });
  assert.equal(copied.data.assistant.id, "copied");
  const detail = await jsonFetch(`${fixture.base}/api/web/v1/assistants/copied`);
  assert.equal(detail.data.assistant.id, "copied");
  assert.equal(typeof detail.data.files.agents, "string");
  const avatarUpdate = await jsonFetch(`${fixture.base}/api/web/v1/assistants/copied`, {
    method: "PATCH", headers: jsonHeaders,
    body: JSON.stringify({ avatarAsset: { action: "upload", mimeType: "image/png", data: ONE_PIXEL_PNG } }),
  });
  assert.match(avatarUpdate.data.assistant.manifest.avatar, /^\.assets\/avatar-[a-f0-9]{16}\.png$/);
  const avatar = await fetch(`${fixture.base}/api/web/v1/assistants/copied/avatar`);
  assert.equal(avatar.status, 200);
  assert.equal(avatar.headers.get("content-type"), "image/png");
  assert.equal(avatar.headers.get("x-content-type-options"), "nosniff");
  assert.equal(avatar.headers.get("cache-control"), "private, max-age=31536000, immutable");
  assert.deepEqual(Buffer.from(await avatar.arrayBuffer()), Buffer.from(ONE_PIXEL_PNG, "base64"));
  const invalidAvatar = await fetch(`${fixture.base}/api/web/v1/assistants/copied`, {
    method: "PATCH", headers: jsonHeaders,
    body: JSON.stringify({ avatarAsset: { action: "upload", mimeType: "image/png", data: Buffer.from("not a png").toString("base64") } }),
  });
  assert.equal(invalidAvatar.status, 400);
  await jsonFetch(`${fixture.base}/api/web/v1/assistants/copied`, {
    method: "PATCH", headers: jsonHeaders,
    body: JSON.stringify({ manifest: { tools: ["pi:read", "pi:bash"] } }),
  });
  const assistantSession = await jsonFetch(`${fixture.base}/api/web/v1/sessions`, {
    method: "POST", headers: jsonHeaders, body: JSON.stringify({ assistantId: "copied" }),
  });
  const assistantSlot = await fixture.server.registry.getOrOpen(assistantSession.data.sessionId);
  assistantSlot.runtime.session.sessionManager.appendMessage({ role: "user", content: "persist assistant tools", timestamp: Date.now() });
  assistantSlot.runtime.session.sessionManager.appendMessage({
    role: "assistant", content: [{ type: "text", text: "persisted" }], api: "openai-responses",
    provider: "openai", model: "seed", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now(),
  });
  const assistantTools = await jsonFetch(`${fixture.base}/api/web/v1/sessions/${assistantSession.data.sessionId}/tools`);
  assert.deepEqual(assistantTools.data.activeToolNames, ["read", "bash"]);
  assert.equal(assistantTools.data.toolSource, "assistant");
  await fixture.server.registry.close(assistantSession.data.sessionId);
  const reopenedAssistantTools = await jsonFetch(`${fixture.base}/api/web/v1/sessions/${assistantSession.data.sessionId}/tools`);
  assert.deepEqual(reopenedAssistantTools.data.activeToolNames, ["read", "bash"]);
  assert.equal(reopenedAssistantTools.data.toolSource, "assistant");

  const exported = await fetch(`${fixture.base}/api/web/v1/assistants/copied/export`);
  assert.equal(exported.headers.get("content-type"), "application/zip");
  const form = new FormData();
  form.set("id", "imported");
  form.set("file", new File([await exported.arrayBuffer()], "copied.wuxianpi.zip", { type: "application/zip" }));
  const imported = await jsonFetch(`${fixture.base}/api/web/v1/assistants/import`, { method: "POST", body: form });
  assert.equal(imported.data.assistant.id, "imported");
  const importedAvatar = await fetch(`${fixture.base}/api/web/v1/assistants/imported/avatar`);
  assert.equal(importedAvatar.status, 200);
  assert.deepEqual(Buffer.from(await importedAvatar.arrayBuffer()), Buffer.from(ONE_PIXEL_PNG, "base64"));
  const removedAvatar = await jsonFetch(`${fixture.base}/api/web/v1/assistants/copied`, {
    method: "PATCH", headers: jsonHeaders, body: JSON.stringify({ avatarAsset: { action: "remove" } }),
  });
  assert.equal(removedAvatar.data.assistant.manifest.avatar, undefined);
  assert.equal((await fetch(`${fixture.base}/api/web/v1/assistants/copied/avatar`)).status, 404);

  const config = await jsonFetch(`${fixture.base}/api/web/v1/capabilities/config`, {
    method: "PATCH", headers: jsonHeaders, body: JSON.stringify({
      mcpServers: [{ id: "local", name: "Local", transport: "stdio", command: "node", args: ["server.js"], enabled: true }],
      ttsProfiles: [{ id: "browser:test", name: "Browser", provider: "browser-speech", enabled: true }],
    }),
  });
  assert.equal(config.data.mcpServers[0].id, "local");
  assert.match(await readFile(fixture.mcpConfigPath, "utf8"), /"local"/);
  const capabilities = await jsonFetch(`${fixture.base}/api/web/v1/capabilities`);
  assert.equal(Array.isArray(capabilities.data.catalog.capabilities), true);
  assert.deepEqual(capabilities.data.catalog.capabilities.find((item) => item.id === "pi:read").selection,
    { field: "tools", values: ["pi:read"] });
  assert.equal(capabilities.data.config.ttsProfiles[0].id, "browser:test");
  const permissions = await jsonFetch(`${fixture.base}/api/web/v1/capabilities/permissions`);
  assert.deepEqual(permissions.data.pending, []);
  await jsonFetch(`${fixture.base}/api/web/v1/capabilities/permissions`, {
    method: "POST", headers: jsonHeaders,
    body: JSON.stringify({ action: "revoke", request: { assistantId: "copied", capabilityId: "pi:bash" } }),
  });
  const mcp = await jsonFetch(`${fixture.base}/api/web/v1/capabilities/mcp`, {
    method: "POST", headers: jsonHeaders, body: JSON.stringify({ action: "test", serverId: "local" }),
  });
  assert.equal(mcp.data.configPath, fixture.mcpConfigPath);
  const tts = await fetch(`${fixture.base}/api/web/v1/capabilities/tts`, {
    method: "POST", headers: jsonHeaders, body: JSON.stringify({ profileId: "browser:test", text: "hello" }),
  }).then((response) => response.json());
  assert.equal(tts.kind, "client");

  const extensions = await jsonFetch(`${fixture.base}/api/web/v1/extensions`);
  assert.equal(extensions.data.extensions[0].manifest.id, "demo");
  const nonce = await jsonFetch(`${fixture.base}/api/web/v1/extensions/nonce`, {
    method: "POST", headers: jsonHeaders, body: JSON.stringify({ extensionId: "demo", assistantId: "copied" }),
  });
  const bridge = await jsonFetch(`${fixture.base}/api/web/v1/extensions/bridge`, {
    method: "POST", headers: jsonHeaders, body: JSON.stringify({
      type: "wuxianpi_bridge_request", requestId: "bridge-1", extensionId: "demo", nonce: nonce.data.nonce,
      method: "assistant.get", params: {},
    }),
  });
  assert.equal(bridge.data.ok, true);
  assert.equal(bridge.data.result.id, "copied");
});

test("Package functional assistant bindings and Workspace deletion match the fixed Web contract", { timeout: 30_000 }, async (t) => {
  const fixture = await startFixture(t, "integration-contract");
  await jsonFetch(`${fixture.base}/api/web/v1/workspaces`, {
    method: "POST", headers: jsonHeaders,
    body: JSON.stringify({ id: "temporary", name: "Temporary", rootCwd: fixture.root }),
  });
  const removed = await jsonFetch(`${fixture.base}/api/web/v1/workspaces/temporary`, {
    method: "DELETE", headers: jsonHeaders,
  });
  assert.deepEqual(removed.data, { removed: true });
  const removedAgain = await jsonFetch(`${fixture.base}/api/web/v1/workspaces/temporary`, {
    method: "DELETE", headers: jsonHeaders,
  });
  assert.deepEqual(removedAgain.data, { removed: false });

  const malformed = await fetch(`${fixture.base}/api/web/v1/packages/bindings/wuxianpi`, {
    method: "PUT", headers: jsonHeaders,
    body: JSON.stringify({ enabledContributionIds: [], functionalAssistants: [] }),
  });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error.code, "invalid_payload");

  const forwarded = await fetch(`${fixture.base}/api/web/v1/packages/bindings/wuxianpi`, {
    method: "PUT", headers: jsonHeaders,
    body: JSON.stringify({
      enabledContributionIds: [],
      functionalAssistants: { "io.test.missing/assistant.functional": { sharingMode: "isolated" } },
    }),
  });
  assert.equal(forwarded.status, 400);
  assert.equal((await forwarded.json()).error.code, "functional_assistant_unbound");
});

const jsonHeaders = { "content-type": "application/json" };
const ONE_PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

async function startFixture(t, name) {
  const root = await mkdtemp(join(tmpdir(), `wuxianpi-${name}-`));
  const agentDir = join(root, "agent");
  const mcpConfigPath = join(root, "mcp", "mcp.json");
  const server = createRuntimeServer({ host: "127.0.0.1", port: 0, agentDir, mcpConfigPath, idleTimeoutMs: 0 });
  const address = await server.start();
  t.after(async () => {
    await server.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  return { root, agentDir, mcpConfigPath, server, base: `http://127.0.0.1:${address.port}` };
}

async function jsonFetch(url, init) {
  const response = await fetch(url, init);
  const body = await response.json();
  assert.equal(response.ok, true, JSON.stringify(body));
  return body;
}
