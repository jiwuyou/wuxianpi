import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionRegistry } from "../dist/session-registry.js";

test("SessionRegistry persists automation messages and serializes turns", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "wuxianpi-automation-session-"));
  const registry = new SessionRegistry(undefined, { agentDir: join(root, "agent"), idleTimeoutMs: 0 });
  t.after(async () => { await registry.dispose(); await rm(root, { recursive: true, force: true }); });
  const identity = await registry.create(root);
  const slot = await registry.getOrOpen(identity.sessionId);
  slot.modelStatus = { state: "ready", provider: "test", modelId: "test" };
  const session = slot.runtime.session;
  const pending = [];
  let active = 0;
  let maximumActive = 0;
  session.sendCustomMessage = async (message, options) => {
    const custom = { role: "custom", customType: message.customType, content: message.content, display: message.display, details: message.details, timestamp: Date.now() };
    session.agent.state.messages.push(custom);
    session.sessionManager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
    if (!options?.triggerTurn) return;
    active += 1; maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => pending.push(resolve));
    const assistant = { role: "assistant", content: [{ type: "text", text: `answer-${message.details.runId}` }], api: "openai-responses", provider: "test", model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() };
    session.agent.state.messages.push(assistant); session.sessionManager.appendMessage(assistant); active -= 1;
  };
  const common = { registrationId: "daily-news", registrationTitle: "每日 AI 日报", conversationId: identity.sessionId, message: "生成日报", artifactRefs: [] };
  const first = registry.runAutomationTurn({ ...common, runId: "one", idempotencyKey: "one", signal: new AbortController().signal, onStarted() {} });
  const second = registry.runAutomationTurn({ ...common, runId: "two", idempotencyKey: "two", signal: new AbortController().signal, onStarted() {} });
  await waitUntil(() => pending.length === 1); pending.shift()();
  await waitUntil(() => pending.length === 1); pending.shift()();
  const results = await Promise.all([first, second]);
  assert.deepEqual(results.map((result) => result.assistantText), ["answer-one", "answer-two"]);
  assert.equal(maximumActive, 1);
  const messages = (await registry.messages(identity.sessionId)).messages.filter((message) => message.role === "custom");
  assert.equal(messages.length, 2); assert.equal(messages[0].details.registrationId, "daily-news"); assert.equal(messages[0].details.kind, "turn");
});

async function waitUntil(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) { if (Date.now() >= deadline) throw new Error("condition timed out"); await new Promise((resolve) => setTimeout(resolve, 10)); }
}
