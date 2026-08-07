import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRuntimeServer } from "../dist/server.js";

test("automation-turn.v1 exposes a bearer-only Runtime bridge without CORS", { timeout: 20_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "wuxianpi-automation-api-"));
  const agentDir = join(root, "agent");
  const taskRoot = join(root, "daily-news");
  await mkdir(taskRoot, { recursive: true });
  const server = createRuntimeServer({ host: "127.0.0.1", port: 0, agentDir, idleTimeoutMs: 0 });
  const address = await server.start();
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await server.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });

  const health = await jsonFetch(`${base}/health`);
  assert.equal(health.body.capabilities.automationTurn, 1);
  const ownerTokenPath = join(agentDir, "wuxianpi", "automation-owner.token");
  const ownerToken = (await readFile(ownerTokenPath, "utf8")).trim();
  assert.equal((await stat(ownerTokenPath)).mode & 0o777, 0o600);

  const identity = await server.registry.create(root);
  const slot = await server.registry.getOrOpen(identity.sessionId);
  slot.modelStatus = { state: "ready", provider: "test", modelId: "test" };
  const session = slot.runtime.session;
  let messageAppendCalls = 0;
  let releaseMessageAppend;
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
    if (!options?.triggerTurn) {
      if (message.content === "任务运行完成") {
        messageAppendCalls += 1;
        await new Promise((resolve) => { releaseMessageAppend = resolve; });
      }
      return;
    }
    const assistant = assistantMessage("今日摘要");
    session.agent.state.messages.push(assistant);
    session.sessionManager.appendMessage(assistant);
  };

  const unauthorizedOwner = await jsonFetch(`${base}/api/automation/v1/bindings`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer wrong" },
    body: JSON.stringify({ taskId: "daily-news", conversationId: identity.sessionId, taskRoot }),
  });
  assert.equal(unauthorizedOwner.response.status, 401);

  const bindingResponse = await jsonFetch(`${base}/api/automation/v1/bindings`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${ownerToken}`,
      origin: "https://untrusted.example",
    },
    body: JSON.stringify({ taskId: "daily-news", conversationId: identity.sessionId, taskRoot }),
  });
  assert.equal(bindingResponse.response.status, 201);
  assert.equal(bindingResponse.response.headers.get("access-control-allow-origin"), null);
  const taskToken = bindingResponse.body.data.taskToken;

  const turnRequest = {
    taskId: "daily-news",
    runId: "run-1",
    conversationId: identity.sessionId,
    message: "请生成今日摘要",
    artifactRefs: [],
    idempotencyKey: "daily-news:2026-08-07",
  };
  const first = await jsonFetch(`${base}/api/automation/v1/turns`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${taskToken}` },
    body: JSON.stringify(turnRequest),
  });
  assert.equal(first.response.status, 202);
  const duplicate = await jsonFetch(`${base}/api/automation/v1/turns`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${taskToken}` },
    body: JSON.stringify(turnRequest),
  });
  assert.equal(duplicate.body.data.turn.turnId, first.body.data.turn.turnId);

  const completed = await jsonFetch(
    `${base}/api/automation/v1/turns/${first.body.data.turn.turnId}?waitMs=1000`,
    { headers: { authorization: `Bearer ${taskToken}` } },
  );
  assert.equal(completed.body.data.turn.status, "succeeded");
  assert.equal(completed.body.data.turn.assistantText, "今日摘要");
  const messages = (await server.registry.messages(identity.sessionId)).messages;
  assert.equal(messages.some((message) => message.role === "user"), false);
  assert.equal(messages.find((message) => message.role === "custom").details.source, "automation");

  const messageRequest = {
    taskId: "daily-news",
    runId: "run-1",
    conversationId: identity.sessionId,
    message: "任务运行完成",
    artifactRefs: [],
    idempotencyKey: "daily-news:2026-08-07:completed",
  };
  const firstMessagePromise = jsonFetch(`${base}/api/automation/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${taskToken}` },
    body: JSON.stringify(messageRequest),
  });
  await waitUntil(() => messageAppendCalls === 1 && typeof releaseMessageAppend === "function");
  let duplicateSettled = false;
  const duplicateMessagePromise = jsonFetch(`${base}/api/automation/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${taskToken}` },
    body: JSON.stringify(messageRequest),
  }).finally(() => { duplicateSettled = true; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(duplicateSettled, false);
  releaseMessageAppend();
  const [firstMessage, duplicateMessage] = await Promise.all([firstMessagePromise, duplicateMessagePromise]);
  assert.equal(firstMessage.response.status, 201);
  assert.equal(duplicateMessage.response.status, 200);
  assert.equal(firstMessage.body.data.message.status, "succeeded");
  assert.equal(duplicateMessage.body.data.message.messageId, firstMessage.body.data.message.messageId);
  assert.equal(messageAppendCalls, 1);
  const appendedMessages = (await server.registry.messages(identity.sessionId)).messages
    .filter((message) => message.role === "custom" && message.details?.kind === "message");
  assert.equal(appendedMessages.length, 1);

  const revoked = await jsonFetch(`${base}/api/automation/v1/bindings/daily-news`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${ownerToken}` },
  });
  assert.equal(typeof revoked.body.data.binding.revokedAt, "string");
  const denied = await jsonFetch(
    `${base}/api/automation/v1/turns/${first.body.data.turn.turnId}`,
    { headers: { authorization: `Bearer ${taskToken}` } },
  );
  assert.equal(denied.response.status, 401);
});

async function jsonFetch(url, options) {
  const response = await fetch(url, options);
  return { response, body: await response.json() };
}

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
