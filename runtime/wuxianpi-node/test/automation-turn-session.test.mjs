import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AutomationTurnService } from "../dist/automation-turn-service.js";
import { AutomationTurnStore } from "../dist/automation-turn-store.js";
import { SessionRegistry } from "../dist/session-registry.js";

test("SessionRegistry persists automation input as custom messages and serializes turns", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "wuxianpi-automation-session-"));
  const registry = new SessionRegistry(undefined, { agentDir: join(root, "agent"), idleTimeoutMs: 0 });
  t.after(async () => {
    await registry.dispose();
    await rm(root, { recursive: true, force: true });
  });
  const identity = await registry.create(root);
  const slot = await registry.getOrOpen(identity.sessionId);
  slot.modelStatus = { state: "ready", provider: "test", modelId: "test" };
  const session = slot.runtime.session;
  const pending = [];
  let active = 0;
  let maximumActive = 0;
  session.sendCustomMessage = async (message, options) => {
    const custom = {
      role: "custom",
      customType: message.customType,
      content: message.content,
      display: message.display,
      details: message.details,
      timestamp: Date.now(),
    };
    session.agent.state.messages.push(custom);
    session.sessionManager.appendCustomMessageEntry(
      message.customType,
      message.content,
      message.display,
      message.details,
    );
    if (!options?.triggerTurn) return;
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => pending.push(resolve));
    const assistant = assistantMessage(`answer-${message.details.runId}`);
    session.agent.state.messages.push(assistant);
    session.sessionManager.appendMessage(assistant);
    active -= 1;
  };

  const common = {
    taskId: "daily-news",
    conversationId: identity.sessionId,
    message: "请生成日报",
    artifactRefs: [],
  };
  const starts = [];
  const first = registry.runAutomationTurn({
    ...common, runId: "one", idempotencyKey: "one", signal: new AbortController().signal,
    onStarted: () => starts.push("one"),
  });
  const second = registry.runAutomationTurn({
    ...common, runId: "two", idempotencyKey: "two", signal: new AbortController().signal,
    onStarted: () => starts.push("two"),
  });

  await waitUntil(() => pending.length === 1);
  assert.deepEqual(starts, ["one"]);
  pending.shift()();
  await waitUntil(() => pending.length === 1 && starts.length === 2);
  pending.shift()();
  const results = await Promise.all([first, second]);
  assert.deepEqual(results.map((result) => result.assistantText), ["answer-one", "answer-two"]);
  assert.equal(maximumActive, 1);

  const messages = (await registry.messages(identity.sessionId)).messages;
  const automationMessages = messages.filter((message) => message.role === "custom");
  assert.equal(automationMessages.length, 2);
  assert.equal(messages.some((message) => message.role === "user"), false);
  assert.equal(automationMessages[0].customType, "wuxianpi.automation-turn");
  assert.equal(automationMessages[0].details.source, "automation");
  assert.equal(automationMessages[0].details.kind, "turn");

  const appended = await registry.appendAutomationMessage({
    ...common, runId: "notice", message: "任务已完成", idempotencyKey: "notice",
  });
  assert.equal(typeof appended.entryId, "string");
  const entries = session.sessionManager.getEntries();
  const last = entries.at(-1);
  assert.equal(last.type, "custom_message");
  assert.equal(last.details.kind, "message");
});

test("cancelling a queued automation turn does not abort the active turn in the same session", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "wuxianpi-automation-queued-cancel-"));
  const registry = new SessionRegistry(undefined, { agentDir: join(root, "agent"), idleTimeoutMs: 0 });
  t.after(async () => {
    await registry.dispose();
    await rm(root, { recursive: true, force: true });
  });
  const identity = await registry.create(root);
  const slot = await registry.getOrOpen(identity.sessionId);
  slot.modelStatus = { state: "ready", provider: "test", modelId: "test" };
  const session = slot.runtime.session;
  let releaseActive;
  let abortCalls = 0;
  session.abort = async () => { abortCalls += 1; };
  session.sendCustomMessage = async (message) => {
    const custom = {
      role: "custom",
      customType: message.customType,
      content: message.content,
      display: message.display,
      details: message.details,
      timestamp: Date.now(),
    };
    session.agent.state.messages.push(custom);
    session.sessionManager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
    await new Promise((resolve) => { releaseActive = resolve; });
    const assistant = assistantMessage("first-complete");
    session.agent.state.messages.push(assistant);
    session.sessionManager.appendMessage(assistant);
  };
  const common = {
    taskId: "task",
    conversationId: identity.sessionId,
    message: "run",
    artifactRefs: [],
  };
  const first = registry.runAutomationTurn({
    ...common, runId: "one", idempotencyKey: "one", signal: new AbortController().signal, onStarted() {},
  });
  const queuedController = new AbortController();
  const queued = registry.runAutomationTurn({
    ...common, runId: "two", idempotencyKey: "two", signal: queuedController.signal, onStarted() {},
  });
  const queuedResult = assert.rejects(queued, (error) => error.code === "automation_turn_cancelled");
  await waitUntil(() => typeof releaseActive === "function");
  queuedController.abort();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(abortCalls, 0);
  releaseActive();
  assert.equal((await first).assistantText, "first-complete");
  await queuedResult;
  assert.equal(abortCalls, 0);
});

test("AutomationTurnService shutdown removes a queued session turn", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "wuxianpi-automation-shutdown-"));
  const agentDir = join(root, "agent");
  const taskRoot = join(root, "task");
  const databasePath = join(root, "automation.sqlite");
  await mkdir(taskRoot, { recursive: true });
  const registry = new SessionRegistry(undefined, { agentDir, idleTimeoutMs: 0 });
  const store = new AutomationTurnStore({ path: databasePath });
  const service = new AutomationTurnService(store, registry);
  t.after(async () => {
    await service.close().catch(() => undefined);
    await registry.dispose().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  const identity = await registry.create(root);
  const slot = await registry.getOrOpen(identity.sessionId);
  slot.modelStatus = { state: "ready", provider: "test", modelId: "test" };
  let releaseBlocker;
  const blocker = registry.run(identity.sessionId, () => new Promise((resolve) => { releaseBlocker = resolve; }));
  await waitUntil(() => typeof releaseBlocker === "function");
  const binding = await service.createBinding({ taskId: "queued", conversationId: identity.sessionId, taskRoot });
  const turn = await service.triggerTurn({
    taskToken: binding.taskToken,
    taskId: "queued",
    runId: "run-1",
    message: "queued turn",
    idempotencyKey: "queued-1",
  });
  await waitUntil(() => store.getTurn(turn.turnId)?.status === "queued");

  await Promise.race([
    service.close(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("service shutdown timed out")), 1_000)),
  ]);
  releaseBlocker();
  await blocker;
  const reopenedStore = new AutomationTurnStore({ path: databasePath });
  assert.equal(reopenedStore.getTurn(turn.turnId).status, "interrupted");
  reopenedStore.close();
  assert.equal(
    (await registry.messages(identity.sessionId)).messages.some((message) => message.details?.runId === "run-1"),
    false,
  );
});

function assistantMessage(text) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-responses",
    provider: "test",
    model: "test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

async function waitUntil(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
