import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AutomationTurnService } from "../dist/automation-turn-service.js";
import { AutomationTurnStore } from "../dist/automation-turn-store.js";

function future(days = 30) { return new Date(Date.now() + days * 86_400_000).toISOString(); }

test("automation registration requires approval, scopes the conversation, and counts idempotent turns once", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "wuxianpi-automation-registration-"));
  const projectRoot = join(root, "project");
  const artifact = join(projectRoot, "candidate.json");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(artifact, "[]");
  const calls = [];
  const registry = {
    async assertAutomationConversation(id) { assert.equal(id, "session-1"); },
    async createAutomationConversation() { return { conversationId: "created-session" }; },
    async appendAutomationMessage(input) { calls.push({ kind: "message", input }); return { entryId: "entry" }; },
    async runAutomationTurn(input) { input.onStarted(); calls.push({ kind: "turn", input }); return { finalLeafId: "leaf", assistantText: "完成" }; },
  };
  const store = new AutomationTurnStore({ path: join(root, "automation.sqlite") });
  const service = new AutomationTurnService(store, registry, { credentialDirectory: join(root, "credentials") });
  t.after(async () => { await service.close().catch(() => undefined); await rm(root, { recursive: true, force: true }); });

  const pending = await service.requestRegistration({
    id: "daily-news", title: "每日 AI 日报", applicantConversationId: "session-1",
    reason: "整理候选新闻并生成日报", projectRoot, rateLimit: { maxCalls: 2, windowSeconds: 86_400 }, expiresAt: future(),
  });
  assert.equal(pending.status, "pending");
  assert.equal(pending.credentialPath, null);
  await assert.rejects(() => service.triggerTurn({ registrationToken: "none", registrationId: "daily-news", runId: "1", message: "x", idempotencyKey: "1" }), /Invalid automation credential/);

  const enabled = await service.approveRegistration("daily-news");
  assert.equal(enabled.status, "active");
  const token = (await readFile(enabled.credentialPath, "utf8")).trim();
  const request = { registrationToken: token, registrationId: "daily-news", runId: "1", conversationId: "session-1", message: "生成日报", artifactRefs: ["candidate.json"], idempotencyKey: "daily-news:1" };
  const [first, duplicate] = await Promise.all([service.triggerTurn(request), service.triggerTurn(request)]);
  assert.equal(first.turnId, duplicate.turnId);
  await service.getTurn(first.turnId, token, 1_000);
  assert.equal(calls.filter((call) => call.kind === "turn").length, 1);
  assert.deepEqual(calls.find((call) => call.kind === "turn").input.artifactRefs, [artifact]);
  assert.equal(service.getRegistration("daily-news").rateUsage.used, 1);
  await assert.rejects(() => service.triggerTurn({ ...request, idempotencyKey: "daily-news:2", conversationId: "session-2" }), (error) => error.code === "automation_scope_mismatch");
  await assert.rejects(() => service.triggerTurn({ ...request, idempotencyKey: "daily-news:2", artifactRefs: [root] }), (error) => error.code === "artifact_outside_project_root");
  await service.triggerTurn({ ...request, idempotencyKey: "daily-news:2", runId: "2" });
  await assert.rejects(() => service.triggerTurn({ ...request, idempotencyKey: "daily-news:3", runId: "3" }), (error) => error.code === "automation_rate_limited" && Boolean(error.details.nextAllowedAt));
  assert.equal((await service.updateRegistration("daily-news", { rateLimit: { maxCalls: 4, windowSeconds: 86_400 } })).status, "pending");
  const reenabled = await service.approveRegistration("daily-news");
  const refreshedToken = (await readFile(reenabled.credentialPath, "utf8")).trim();
  assert.notEqual(refreshedToken, token);
  const paused = service.pauseRegistration("daily-news");
  assert.equal(paused.status, "paused");
  await assert.rejects(() => service.triggerTurn({ ...request, registrationToken: refreshedToken, idempotencyKey: "paused" }), (error) => error.code === "automation_paused");
  assert.equal(service.resumeRegistration("daily-news").status, "active");
  assert.equal((await service.revokeRegistration("daily-news")).status, "revoked");
  await assert.rejects(() => service.triggerTurn({ ...request, registrationToken: refreshedToken, idempotencyKey: "revoked" }), (error) => error.code === "automation_revoked");
});

test("per-run automation creates a bounded new conversation for each accepted turn", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "wuxianpi-automation-per-run-"));
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });
  const created = [];
  const registry = {
    async assertAutomationConversation() {},
    async createAutomationConversation(input) { created.push(input); return { conversationId: `session-${created.length}` }; },
    async appendAutomationMessage() { return { entryId: "entry" }; },
    async runAutomationTurn(input) { input.onStarted(); return { finalLeafId: "leaf", assistantText: input.conversationId }; },
  };
  const store = new AutomationTurnStore({ path: join(root, "automation.sqlite") });
  const service = new AutomationTurnService(store, registry, { credentialDirectory: join(root, "credentials") });
  t.after(async () => { await service.close().catch(() => undefined); await rm(root, { recursive: true, force: true }); });
  const pending = await service.requestRegistration({
    id: "check", title: "服务器巡检", applicantConversationId: "applicant", reason: "每次检查使用隔离对话",
    projectRoot, target: { kind: "new", mode: "per-run", assistantId: "wuxianpi", workspaceId: null, cwd: projectRoot },
    rateLimit: { maxCalls: 5, windowSeconds: 86_400 }, expiresAt: future(),
  });
  const enabled = await service.approveRegistration(pending.id);
  const token = (await readFile(enabled.credentialPath, "utf8")).trim();
  const turn = await service.triggerTurn({ registrationToken: token, registrationId: "check", runId: "1", message: "检查", idempotencyKey: "1" });
  await service.getTurn(turn.turnId, token, 1_000);
  assert.equal(created.length, 1);
  assert.equal(service.getRegistration("check").targetConversationId, null);
});
