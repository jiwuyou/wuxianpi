import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { WuxianPiPackageManager } from "../dist/package-manager.js";
import { createRuntimeServer } from "../dist/server.js";

const PACKAGE_ROOT = fileURLToPath(new URL("../builtin-packages/task-manager", import.meta.url));
const TASK_EXTENSION_ID = "com.wuxianpi.builtin.tasks/web.tasks";
const TIMER_EXTENSION_ID = "com.wuxianpi.builtin.timer/web.timer";
const AUTOMATION_EXTENSION_ID = "com.wuxianpi.builtin.automation/web.control";

test("bundled Task Package stays enabled by default and preserves an explicit disable", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "wuxianpi-task-package-state-"));
  const manager = new WuxianPiPackageManager({ agentDir: join(root, "agent"), rootDir: join(root, "packages") });
  t.after(() => rm(root, { recursive: true, force: true }));
  await manager.ensureBundledPackage(PACKAGE_ROOT);
  let state = await manager.store.read();
  assert.equal(state.packages["com.wuxianpi.builtin.tasks"].sourceKind, "bundled");
  assert.equal(state.contributions[TASK_EXTENSION_ID].enabled, true);
  await manager.setContributionEnabled(TASK_EXTENSION_ID, false);
  await manager.ensureBundledPackage(PACKAGE_ROOT);
  state = await manager.store.read();
  assert.equal(state.contributions[TASK_EXTENSION_ID].enabled, false);
});

test("built-in Task, Timer, and Automation Packages load and expose package APIs", { timeout: 30_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "wuxianpi-task-runtime-"));
  const agentDir = join(root, "agent");
  const server = createRuntimeServer({ host: "127.0.0.1", port: 0, agentDir, idleTimeoutMs: 0 });
  const address = await server.start();
  const base = `http://127.0.0.1:${address.port}/api/web/v1`;
  t.after(async () => {
    await server.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });

  const extensions = await jsonFetch(`${base}/extensions`);
  const ids = extensions.data.extensions.map((extension) => extension.id);
  assert.equal(ids.includes(TASK_EXTENSION_ID), true);
  assert.equal(ids.includes(TIMER_EXTENSION_ID), true);
  assert.equal(ids.includes(AUTOMATION_EXTENSION_ID), true);

  const taskNonce = await issueNonce(base, TASK_EXTENSION_ID, "wuxianpi");
  const created = await bridge(base, taskNonce, TASK_EXTENSION_ID, "package.invoke", {
    namespace: "task.v1",
    method: "create",
    params: { title: "Automation design", workspaceName: "Automation design" },
  });
  assert.equal(created.title, "Automation design");
  assert.equal(created.workspaceName, "Automation design");
  assert.equal(Array.isArray(created.conversations), true);
  assert.equal(created.conversations.length, 1);
  const standalone = await jsonFetch(`${base}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ assistantId: "wuxianpi" }),
  });
  const openedConversationId = standalone.data.sessionId;

  const reboundNonce = await issueNonce(base, TASK_EXTENSION_ID, "wuxianpi", openedConversationId);
  const reboundTask = await bridge(base, reboundNonce, TASK_EXTENSION_ID, "package.invoke", {
    namespace: "task.v1",
    method: "create",
    params: { title: "Bound conversion", workspaceName: "Bound conversion", rebind: true, confirmed: true },
  });
  assert.equal(reboundTask.conversations[0].conversationId, openedConversationId);
  const reboundScope = await bridge(base, reboundNonce, TASK_EXTENSION_ID, "session.getScope");
  assert.equal(reboundScope.workspaceId, reboundTask.workspaceId);

  const index = JSON.parse(await readFile(join(created.workspaceRoot, ".wuxianpi", "tasks", "index.json"), "utf8"));
  assert.equal(index.schemaVersion, 2);
  assert.equal(index.tasks.some((task) => task.id === created.id), true);
  assert.equal(index.conversations.some((conversation) => conversation.conversationId === created.conversations[0].conversationId), true);

  const scheduled = await bridge(base, taskNonce, TASK_EXTENSION_ID, "package.invoke", {
    namespace: "task.v1",
    method: "createScheduledConversation",
    params: {
      taskId: created.id,
      title: "Automation design schedule",
      message: "Please continue the task.",
      schedule: { kind: "interval", seconds: 3600 },
      timezone: "UTC",
      policy: { mode: "select", purpose: "general", assistantId: "wuxianpi" },
    },
  });
  assert.equal(scheduled.action.kind, "scheduled_conversation");
  assert.equal(typeof scheduled.timer.id, "string");

  const timerNonce = await issueNonce(base, TIMER_EXTENSION_ID, "wuxianpi");
  const timers = await bridge(base, timerNonce, TIMER_EXTENSION_ID, "package.invoke", {
    namespace: "timer.v1",
    method: "list",
    params: {},
  });
  assert.equal(timers.timers.some((timer) => timer.id === scheduled.timer.id), true);
});

test("Task Pi Extension injects only the matching conversation memory reference", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "wuxianpi-task-context-"));
  const taskRoot = join(root, ".wuxianpi", "tasks", "task-one");
  await mkdir(taskRoot, { recursive: true });
  await writeFile(join(root, ".wuxianpi", "tasks", "index.json"), JSON.stringify({
    schemaVersion: 2,
    tasks: [{ id: "task-one", title: "Automation design", status: "active", workspaceId: "alpha-space", memoryRevision: 1 }],
    conversations: [{ taskId: "task-one", conversationId: "session-one", purpose: "general", origin: "user", status: "active" }],
  }));
  await writeFile(join(taskRoot, "MEMORY.md"), "# Task memory\n\nDecision: keep Runtime thin.\n");
  t.after(() => rm(root, { recursive: true, force: true }));

  let handler;
  const extension = await import(pathToFileURL(join(PACKAGE_ROOT, "extension", "task-context.mjs")).href);
  extension.default({ on: (event, callback) => { if (event === "before_agent_start") handler = callback; } });
  const matching = await handler({ systemPrompt: "base" }, {
    cwd: join(root, "src"), sessionManager: { getSessionId: () => "session-one" },
  });
  assert.match(matching.systemPrompt, /Automation design/);
  assert.match(matching.systemPrompt, /Task memory: .*MEMORY\.md/);
  assert.doesNotMatch(matching.systemPrompt, /keep Runtime thin/);
  const unrelated = await handler({ systemPrompt: "base" }, {
    cwd: root, sessionManager: { getSessionId: () => "session-two" },
  });
  assert.equal(unrelated, undefined);
});

async function issueNonce(base, extensionId, assistantId, sessionId) {
  const response = await jsonFetch(`${base}/extensions/nonce`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ extensionId, assistantId, sessionId }),
  });
  return response.data.nonce;
}

async function bridge(base, nonce, extensionId, method, params = {}) {
  const response = await fetch(`${base}/extensions/bridge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "wuxianpi_bridge_request",
      requestId: crypto.randomUUID(),
      extensionId,
      nonce,
      method,
      params,
    }),
  });
  const body = await response.json();
  assert.equal(response.ok, true, JSON.stringify(body));
  return body.data.result;
}

async function jsonFetch(url, init) {
  const response = await fetch(url, init);
  const body = await response.json();
  assert.equal(response.ok, true, JSON.stringify(body));
  return body;
}
