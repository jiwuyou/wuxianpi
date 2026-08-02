import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRuntimeServer } from "../dist/server.js";
import { createCardSpec, EXECUTABLE_CARD_DETAILS_KEY } from "../dist/executable-card.js";

const jsonHeaders = { "content-type": "application/json" };

test("executable card persists in a session and runs a process workflow", { timeout: 30_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "wuxianpi-card-"));
  const server = createRuntimeServer({ host: "127.0.0.1", port: 0, agentDir: join(root, "agent"), idleTimeoutMs: 0 });
  const address = await server.start();
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await server.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });

  const identity = await server.registry.create(root);
  const slot = await server.registry.getOrOpen(identity.sessionId);
  assert.ok(slot.runtime.session.getToolDefinition("present_executable_card"));
  assert.equal(slot.runtime.session.getActiveToolNames().includes("present_executable_card"), true);
  const spec = createCardSpec({
    title: "Echo value",
    fields: [{ id: "value", type: "text", label: "Value", required: true }],
    workflow: {
      type: "process",
      command: process.execPath,
      args: ["-e", "process.stdout.write(process.argv[1])", "$field.value"],
    },
  });
  slot.runtime.session.sessionManager.appendMessage({
    role: "toolResult",
    toolCallId: "card-call",
    toolName: "present_executable_card",
    content: [{ type: "text", text: "Card ready" }],
    details: { [EXECUTABLE_CARD_DETAILS_KEY]: spec },
    isError: false,
    timestamp: Date.now(),
  });

  let snapshot = await jsonFetch(`${base}/api/web/v1/sessions/${identity.sessionId}/snapshot`);
  assert.equal(snapshot.data.cards.length, 1);
  assert.equal(snapshot.data.cards[0].state, "draft");

  const submitted = await jsonFetch(`${base}/api/web/v1/sessions/${identity.sessionId}/cards/${spec.cardId}/submit`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ requestId: "request-1", workflowDigest: spec.workflowDigest, values: { value: "hello card" } }),
  });
  assert.equal(submitted.data.state, "success");
  assert.equal(submitted.data.result.stdout, "hello card");

  const duplicate = await jsonFetch(`${base}/api/web/v1/sessions/${identity.sessionId}/cards/${spec.cardId}/submit`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ requestId: "request-1", workflowDigest: spec.workflowDigest, values: { value: "changed" } }),
  });
  assert.equal(duplicate.data.result.stdout, "hello card");

  snapshot = await jsonFetch(`${base}/api/web/v1/sessions/${identity.sessionId}/snapshot`);
  assert.equal(snapshot.data.cards[0].state, "success");
  assert.equal(snapshot.data.cards[0].values.value, "hello card");
  assert.equal(snapshot.data.sessionEntries.filter((entry) => entry.customType === "wuxianpi.executable-card-submission").length, 1);
  assert.equal(snapshot.data.sessionEntries.filter((entry) => entry.customType === "wuxianpi.executable-card-result").length, 1);
});

test("running card execution can be cancelled", { timeout: 20_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "wuxianpi-card-cancel-"));
  const server = createRuntimeServer({ host: "127.0.0.1", port: 0, agentDir: join(root, "agent"), idleTimeoutMs: 0 });
  const address = await server.start();
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await server.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  const identity = await server.registry.create(root);
  const slot = await server.registry.getOrOpen(identity.sessionId);
  const spec = createCardSpec({
    title: "Long task",
    fields: [],
    workflow: { type: "process", command: process.execPath, args: ["-e", "setTimeout(() => {}, 10000)"] },
  });
  slot.runtime.session.sessionManager.appendMessage({
    role: "toolResult", toolCallId: "cancel-call", toolName: "present_executable_card",
    content: [{ type: "text", text: "Card ready" }], details: { [EXECUTABLE_CARD_DETAILS_KEY]: spec },
    isError: false, timestamp: Date.now(),
  });

  const submitted = fetch(`${base}/api/web/v1/sessions/${identity.sessionId}/cards/${spec.cardId}/submit`, {
    method: "POST", headers: jsonHeaders,
    body: JSON.stringify({ requestId: "cancel-request", workflowDigest: spec.workflowDigest, values: {} }),
  }).then(async (response) => ({ response, body: await response.json() }));
  await waitFor(async () => {
    const snapshot = await jsonFetch(`${base}/api/web/v1/sessions/${identity.sessionId}/snapshot`);
    return snapshot.data.cards[0]?.state === "running";
  });
  const cancelled = await jsonFetch(`${base}/api/web/v1/sessions/${identity.sessionId}/cards/${spec.cardId}/cancel`, {
    method: "POST", headers: jsonHeaders, body: "{}",
  });
  assert.equal(cancelled.data.cancelling, true);
  const completed = await submitted;
  assert.equal(completed.response.ok, true);
  assert.equal(completed.body.data.state, "cancelled");
});

test("card submission rejects a modified workflow digest", { timeout: 20_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "wuxianpi-card-digest-"));
  const server = createRuntimeServer({ host: "127.0.0.1", port: 0, agentDir: join(root, "agent"), idleTimeoutMs: 0 });
  const address = await server.start();
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await server.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  const identity = await server.registry.create(root);
  const slot = await server.registry.getOrOpen(identity.sessionId);
  const spec = createCardSpec({ title: "Digest", fields: [], workflow: { type: "shell", script: "true" } });
  slot.runtime.session.sessionManager.appendMessage({
    role: "toolResult", toolCallId: "digest-call", toolName: "present_executable_card",
    content: [{ type: "text", text: "Card ready" }], details: { [EXECUTABLE_CARD_DETAILS_KEY]: spec },
    isError: false, timestamp: Date.now(),
  });
  const response = await fetch(`${base}/api/web/v1/sessions/${identity.sessionId}/cards/${spec.cardId}/submit`, {
    method: "POST", headers: jsonHeaders,
    body: JSON.stringify({ requestId: "request-2", workflowDigest: "sha256-wrong", values: {} }),
  });
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.error.code, "card_workflow_mismatch");
});

async function waitFor(predicate) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for condition");
}

async function jsonFetch(url, init) {
  const response = await fetch(url, init);
  const body = await response.json();
  assert.equal(response.ok, true, JSON.stringify(body));
  return body;
}
