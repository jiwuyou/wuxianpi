import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AutomationTurnService } from "../dist/automation-turn-service.js";
import { AutomationTurnStore } from "../dist/automation-turn-store.js";

test("AutomationTurnService persists scoped bindings, enforces idempotency, and canonicalizes artifacts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "wuxianpi-automation-service-"));
  const taskRoot = join(root, "task");
  const artifact = join(taskRoot, "artifacts", "candidates.json");
  const outside = join(root, "outside.txt");
  await mkdir(join(taskRoot, "artifacts"), { recursive: true });
  await writeFile(artifact, "[]");
  await writeFile(outside, "private");
  await symlink(outside, join(taskRoot, "artifacts", "escape.txt"));

  const calls = [];
  const registry = {
    async assertAutomationConversation(conversationId) { assert.equal(conversationId, "session-1"); },
    async appendAutomationMessage(input) { calls.push({ type: "message", input }); return { entryId: "entry-1" }; },
    async runAutomationTurn(input) {
      input.onStarted();
      calls.push({ type: "turn", input });
      return { finalLeafId: "leaf-1", assistantText: "日报完成" };
    },
  };
  const store = new AutomationTurnStore({ path: join(root, "automation.sqlite") });
  const service = new AutomationTurnService(store, registry);
  t.after(async () => {
    await service.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });

  const created = await service.createBinding({ taskId: "daily-news", conversationId: "session-1", taskRoot });
  assert.equal(created.binding.taskRoot, taskRoot);
  assert.equal("tokenHash" in created.binding, false);
  assert.notEqual(store.getBinding("daily-news").tokenHash, created.taskToken);

  const request = {
    taskToken: created.taskToken,
    taskId: "daily-news",
    runId: "run-2026-08-07",
    conversationId: "session-1",
    message: "整理候选新闻",
    artifactRefs: ["artifacts/candidates.json"],
    idempotencyKey: "daily-news:2026-08-07",
  };
  const [first, duplicate] = await Promise.all([service.triggerTurn(request), service.triggerTurn(request)]);
  assert.equal(duplicate.turnId, first.turnId);
  const completed = await service.getTurn(first.turnId, created.taskToken, 1_000);
  assert.equal(completed.status, "succeeded");
  assert.equal(completed.assistantText, "日报完成");
  assert.equal(calls.filter((call) => call.type === "turn").length, 1);
  assert.deepEqual(calls.find((call) => call.type === "turn").input.artifactRefs, [artifact]);

  await assert.rejects(
    service.getTurn(first.turnId, "wrong-token"),
    (error) => error.code === "automation_unauthorized",
  );
  await assert.rejects(
    service.triggerTurn({ ...request, idempotencyKey: "wrong-conversation", conversationId: "session-2" }),
    (error) => error.code === "automation_scope_mismatch",
  );
  await assert.rejects(
    service.triggerTurn({ ...request, idempotencyKey: "outside", artifactRefs: [outside] }),
    (error) => error.code === "artifact_outside_task_root",
  );
  await assert.rejects(
    service.triggerTurn({ ...request, idempotencyKey: "symlink", artifactRefs: ["artifacts/escape.txt"] }),
    (error) => error.code === "artifact_outside_task_root",
  );

  const revoked = service.revokeBinding("daily-news");
  assert.equal(typeof revoked.revokedAt, "string");
  await assert.rejects(
    service.appendMessage({ ...request, artifactRefs: [] }),
    (error) => error.code === "automation_unauthorized",
  );
});

test("AutomationTurnService appends idempotent messages once and preserves uncertain outcomes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "wuxianpi-automation-message-"));
  const taskRoot = join(root, "task");
  await mkdir(taskRoot, { recursive: true });
  let appendCalls = 0;
  let releaseAppend;
  const registry = {
    async assertAutomationConversation() {},
    async appendAutomationMessage(input) {
      appendCalls += 1;
      if (input.message === "wait") {
        await new Promise((resolve) => { releaseAppend = resolve; });
      }
      if (input.message === "fail") throw new Error("append failed");
      return { entryId: `entry-${appendCalls}` };
    },
    async runAutomationTurn() { throw new Error("not expected"); },
  };
  const store = new AutomationTurnStore({ path: join(root, "automation.sqlite") });
  const service = new AutomationTurnService(store, registry);
  t.after(async () => {
    await service.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  const binding = await service.createBinding({ taskId: "notifier", conversationId: "session-1", taskRoot });
  const request = {
    taskToken: binding.taskToken,
    taskId: "notifier",
    runId: "run-1",
    message: "wait",
    idempotencyKey: "notice-1",
  };

  const firstPromise = service.appendMessage(request);
  await waitUntil(() => appendCalls === 1 && typeof releaseAppend === "function");
  let duplicateSettled = false;
  const duplicatePromise = service.appendMessage(request).finally(() => { duplicateSettled = true; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(duplicateSettled, false);
  releaseAppend();
  const [first, duplicate] = await Promise.all([firstPromise, duplicatePromise]);
  assert.equal(first.created, true);
  assert.equal(duplicate.created, false);
  assert.equal(first.message.status, "succeeded");
  assert.equal(duplicate.message.messageId, first.message.messageId);
  assert.equal(appendCalls, 1);

  const replay = await service.appendMessage(request);
  assert.equal(replay.created, false);
  assert.equal(replay.message.messageId, first.message.messageId);
  assert.equal(appendCalls, 1);

  const failedRequest = { ...request, runId: "run-2", message: "fail", idempotencyKey: "notice-2" };
  await assert.rejects(service.appendMessage(failedRequest), /append failed/);
  assert.equal(appendCalls, 2);
  await assert.rejects(
    service.appendMessage(failedRequest),
    (error) => error.code === "automation_message_failed" && error.details.originalError.message === "append failed",
  );
  assert.equal(appendCalls, 2);

  store.createOrGetMessage({
    messageId: "00000000-0000-4000-8000-000000000002",
    taskId: "notifier",
    runId: "run-3",
    conversationId: "session-1",
    idempotencyKey: "notice-3",
  });
  await assert.rejects(
    service.appendMessage({ ...request, runId: "run-3", message: "unknown", idempotencyKey: "notice-3" }),
    (error) => error.code === "automation_message_outcome_unknown",
  );
  assert.equal(appendCalls, 2);
});

test("AutomationTurnService cancels only its active turn and startup interrupts orphaned work", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "wuxianpi-automation-cancel-"));
  const taskRoot = join(root, "task");
  await mkdir(taskRoot, { recursive: true });
  let observedAbort = false;
  const registry = {
    async assertAutomationConversation() {},
    async appendAutomationMessage() { return { entryId: "entry" }; },
    async runAutomationTurn(input) {
      input.onStarted();
      await new Promise((resolve, reject) => {
        input.signal.addEventListener("abort", () => {
          observedAbort = true;
          reject(new Error("aborted"));
        }, { once: true });
      });
    },
  };
  const databasePath = join(root, "automation.sqlite");
  const firstStore = new AutomationTurnStore({ path: databasePath });
  const service = new AutomationTurnService(firstStore, registry);
  t.after(async () => {
    await service.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  const binding = await service.createBinding({ taskId: "watch", conversationId: "session-1", taskRoot });
  const turn = await service.triggerTurn({
    taskToken: binding.taskToken,
    taskId: "watch",
    runId: "run-1",
    message: "检查服务",
    idempotencyKey: "watch:1",
  });
  await waitUntil(() => firstStore.getTurn(turn.turnId)?.status === "running");
  const cancelled = service.cancelTurn(turn.turnId, binding.taskToken);
  assert.equal(cancelled.status, "cancelled");
  await waitUntil(() => observedAbort);

  const orphanId = "00000000-0000-4000-8000-000000000001";
  await service.close();

  const crashDatabasePath = join(root, "crashed.sqlite");
  const crashStore = new AutomationTurnStore({ path: crashDatabasePath });
  crashStore.createBinding({
    taskId: "orphan",
    conversationId: "session-1",
    taskRoot,
    tokenHash: "0".repeat(64),
  });
  crashStore.createOrGetTurn({
    turnId: orphanId,
    taskId: "orphan",
    runId: "run-orphan",
    conversationId: "session-1",
    idempotencyKey: "orphan:1",
  });
  crashStore.close();

  const reopenedStore = new AutomationTurnStore({ path: crashDatabasePath });
  const reopened = new AutomationTurnService(reopenedStore, {
    async assertAutomationConversation() {},
    async appendAutomationMessage() { return { entryId: "entry" }; },
    async runAutomationTurn() { throw new Error("not expected"); },
  });
  assert.equal(reopened.interruptedAtStartup, 1);
  assert.equal(reopenedStore.getTurn(orphanId).status, "interrupted");
  await reopened.close();
});

test("AutomationTurnService owns a shared database before startup recovery", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "wuxianpi-automation-owner-"));
  const taskRoot = join(root, "task");
  await mkdir(taskRoot, { recursive: true });
  let observedAbort = false;
  const registry = {
    async assertAutomationConversation() {},
    async appendAutomationMessage() { return { entryId: "entry" }; },
    async runAutomationTurn(input) {
      input.onStarted();
      await new Promise((resolve, reject) => input.signal.addEventListener("abort", () => {
        observedAbort = true;
        reject(new Error("aborted"));
      }, { once: true }));
    },
  };
  const databasePath = join(root, "automation.sqlite");
  const firstStore = new AutomationTurnStore({ path: databasePath });
  const first = new AutomationTurnService(firstStore, registry);
  t.after(async () => {
    await first.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  const binding = await first.createBinding({ taskId: "watch", conversationId: "session-1", taskRoot });
  const turn = await first.triggerTurn({
    taskToken: binding.taskToken,
    taskId: "watch",
    runId: "run-1",
    message: "watch",
    idempotencyKey: "watch-1",
  });
  await waitUntil(() => firstStore.getTurn(turn.turnId)?.status === "running");

  const secondStore = new AutomationTurnStore({ path: databasePath });
  assert.throws(
    () => new AutomationTurnService(secondStore, registry),
    (error) => error.code === "automation_runtime_owned",
  );
  assert.equal(firstStore.getTurn(turn.turnId).status, "running");

  await first.close();
  assert.equal(observedAbort, true);
  const reopenedStore = new AutomationTurnStore({ path: databasePath });
  const reopened = new AutomationTurnService(reopenedStore, registry);
  assert.equal(reopened.interruptedAtStartup, 0);
  assert.equal(reopenedStore.getTurn(turn.turnId).status, "interrupted");
  await reopened.close();
});

async function waitUntil(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
