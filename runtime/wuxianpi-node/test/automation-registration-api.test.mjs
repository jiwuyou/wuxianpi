import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRuntimeServer } from "../dist/server.js";

test("automation-registration.v1 separates owner setup, user management, and program bearer calls", { timeout: 30_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "wuxianpi-automation-api-"));
  const agentDir = join(root, "agent");
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });
  const server = createRuntimeServer({ host: "127.0.0.1", port: 0, agentDir, idleTimeoutMs: 0 });
  const address = await server.start();
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => { await server.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); });
  const identity = await server.registry.create(root);
  const slot = await server.registry.getOrOpen(identity.sessionId);
  slot.modelStatus = { state: "ready", provider: "test", modelId: "test" };
  const session = slot.runtime.session;
  session.sendCustomMessage = async (message, options) => {
    session.agent.state.messages.push({ role: "custom", customType: message.customType, content: message.content, display: message.display, details: message.details, timestamp: Date.now() });
    session.sessionManager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
    if (options?.triggerTurn) {
      const assistant = { role: "assistant", content: [{ type: "text", text: "日报完成" }], api: "openai-responses", provider: "test", model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() };
      session.agent.state.messages.push(assistant); session.sessionManager.appendMessage(assistant);
    }
  };
  const ownerToken = (await readFile(join(agentDir, "wuxianpi", "automation-owner.token"), "utf8")).trim();
  const headers = { "content-type": "application/json" };
  const pending = await jsonFetch(`${base}/api/web/v1/automations`, { method: "POST", headers, body: JSON.stringify({
    id: "daily-news", title: "每日 AI 日报", applicantConversationId: identity.sessionId,
    reason: "整理候选新闻", projectRoot, target: { kind: "existing", conversationId: identity.sessionId },
    rateLimit: { maxCalls: 2, windowSeconds: 86_400 }, expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  }) });
  assert.equal(pending.status, 201); assert.equal(pending.body.data.automation.status, "pending");
  const enabled = await jsonFetch(`${base}/api/web/v1/automations/daily-news/approve`, { method: "POST", headers });
  assert.equal(enabled.body.data.automation.status, "active");
  const credentialPath = enabled.body.data.automation.credentialPath;
  assert.equal(typeof credentialPath, "string");
  const token = (await readFile(credentialPath, "utf8")).trim();
  const turn = await jsonFetch(`${base}/api/automation/v1/turns`, {
    method: "POST", headers: { ...headers, authorization: `Bearer ${token}` },
    body: JSON.stringify({ registrationId: "daily-news", runId: "1", conversationId: identity.sessionId, message: "生成日报", idempotencyKey: "1" }),
  });
  assert.equal(turn.status, 202);
  const completed = await jsonFetch(`${base}/api/automation/v1/turns/${turn.body.data.turn.turnId}?waitMs=1000`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(completed.body.data.turn.status, "succeeded");
  const stopped = await jsonFetch(`${base}/api/web/v1/automations/daily-news/stop`, { method: "POST", headers });
  assert.equal(stopped.body.data.automation.status, "revoked");
  const denied = await jsonFetch(`${base}/api/automation/v1/turns`, {
    method: "POST", headers: { ...headers, authorization: `Bearer ${token}` },
    body: JSON.stringify({ registrationId: "daily-news", runId: "2", message: "再来一次", idempotencyKey: "2" }),
  });
  assert.equal(denied.status, 403);
  const ownerList = await jsonFetch(`${base}/api/automation/v1/registrations`, { headers: { authorization: `Bearer ${ownerToken}` } });
  assert.equal(ownerList.body.data.automations[0].status, "revoked");
});

async function jsonFetch(url, options) { const response = await fetch(url, options); return { status: response.status, body: await response.json() }; }
