import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFunctionalAssistantStateTool } from "../dist/functional-assistant-tool.js";
import { FunctionalAssistantStorage } from "../dist/functional-assistant-storage.js";
import { SessionRegistry } from "../dist/session-registry.js";
import { createRuntimeServer } from "../dist/server.js";

test("same cwd keeps Profile resources isolated and leaves SDK sessions unbound", async () => {
  const root = await mkdtemp(join(tmpdir(), "wuxianpi-profile-isolation-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "shared-worktree");
  await mkdir(cwd, { recursive: true });
  await mkdir(join(agentDir, "wuxianpi"), { recursive: true });
  await writeFile(join(agentDir, "wuxianpi", "USER.md"), "User: shared-user\n");
  await Promise.all([
    writeAssistant(agentDir, "alpha", "Alpha identity", "Alpha memory"),
    writeAssistant(agentDir, "beta", "Beta identity", "Beta memory"),
  ]);
  const storage = new FunctionalAssistantStorage(join(agentDir, "functional-state"));
  const resources = async (assistantId) => packageResources(assistantId, storage);
  const registry = new SessionRegistry(undefined, {
    agentDir,
    idleTimeoutMs: 0,
    assistantResourcesResolver: resources,
    assistantToolsResolver: async () => ["read"],
  });
  try {
    const alpha = await registry.create({ assistantId: "alpha", cwd });
    const beta = await registry.create({ assistantId: "beta", cwd });
    const unbound = await registry.create(cwd);
    assert.deepEqual(
      [alpha.assistantId, beta.assistantId, unbound.assistantId],
      ["alpha", "beta", null],
    );
    assert.equal(unbound.ownershipState, "unbound");

    const alphaSlot = await registry.getOrOpen(alpha.sessionId);
    const betaSlot = await registry.getOrOpen(beta.sessionId);
    assert.match(alphaSlot.runtime.session.systemPrompt, /Alpha identity/);
    assert.match(alphaSlot.runtime.session.systemPrompt, /Package context for alpha/);
    assert.doesNotMatch(alphaSlot.runtime.session.systemPrompt, /Beta identity/);
    assert.match(betaSlot.runtime.session.systemPrompt, /Beta identity/);
    assert.doesNotMatch(betaSlot.runtime.session.systemPrompt, /Alpha identity/);
    assert.equal(alphaSlot.runtime.session.getAllTools().some((tool) => tool.name === "functional_assistant_state"), true);
    const appliedTools = await registry.setAssistantTools(alpha.sessionId, ["read"]);
    assert.deepEqual(appliedTools.activeToolNames, ["read", "functional_assistant_state"]);
    assert.equal(appliedTools.activeToolNames.includes("bash"), false);

    const alphaRows = await registry.list({ all: true, assistantId: "alpha", offset: 0, limit: 100 });
    assert.equal(alphaRows.sessions.some((session) => session.sessionId === alpha.sessionId), true);
    assert.equal(alphaRows.sessions.some((session) => session.sessionId === beta.sessionId), false);
  } finally {
    await registry.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("Workspace context, new session, fork, and restart preserve immutable ownership", async () => {
  const root = await mkdtemp(join(tmpdir(), "wuxianpi-profile-lifecycle-"));
  const agentDir = join(root, "agent");
  const workspaceRoot = join(root, "workspace");
  const childCwd = join(workspaceRoot, "project");
  await mkdir(childCwd, { recursive: true });
  await writeAssistant(agentDir, "alpha", "Alpha identity", "Alpha memory");
  const makeRegistry = () => new SessionRegistry(undefined, { agentDir, idleTimeoutMs: 0 });
  let registry = makeRegistry();
  let restartPath;
  let restartSessionId;
  try {
    await registry.createWorkspace({
      id: "work-alpha",
      name: "Alpha Workspace",
      rootCwd: workspaceRoot,
      instructions: "Workspace instruction: stay in alpha.",
      memory: "Workspace memory: build 42.",
    });
    const created = await registry.create({ assistantId: "alpha", workspaceId: "work-alpha", cwd: childCwd });
    const initialSlot = await registry.getOrOpen(created.sessionId);
    assert.match(initialSlot.runtime.session.systemPrompt, /Workspace instruction: stay in alpha/);
    assert.match(initialSlot.runtime.session.systemPrompt, /Workspace memory: build 42/);
    assert.equal(created.workspaceName, "Alpha Workspace");

    persistTurn(initialSlot, "first question", "first answer");
    const oldSessionId = created.sessionId;
    const next = await registry.newSession(oldSessionId);
    assert.equal(next.assistantId, "alpha");
    assert.equal(next.workspaceId, "work-alpha");
    assert.equal(registry.binding(next.sessionId).inheritedFromSessionId, oldSessionId);

    const nextSlot = await registry.getOrOpen(next.sessionId);
    const userEntryId = persistTurn(nextSlot, "fork this", "forked answer");
    const forked = await registry.fork(next.sessionId, userEntryId);
    assert.equal(forked.assistantId, "alpha");
    assert.equal(forked.workspaceId, "work-alpha");
    assert.equal(registry.binding(forked.sessionId).inheritedFromSessionId, next.sessionId);
    const forkedSlot = await registry.getOrOpen(forked.sessionId);
    persistTurn(forkedSlot, "persist after fork", "ready for restart");
    restartPath = forkedSlot.runtime.session.sessionFile;
    restartSessionId = forked.sessionId;
    assert.ok(restartPath);
  } finally {
    await registry.dispose();
  }

  registry = makeRegistry();
  try {
    const reopened = await registry.open(restartPath);
    assert.equal(reopened.sessionId, restartSessionId);
    assert.equal(reopened.assistantId, "alpha");
    assert.equal(reopened.workspaceId, "work-alpha");
    assert.equal(reopened.workspaceName, "Alpha Workspace");
    assert.match((await registry.state(reopened.sessionId)).systemPrompt, /Alpha identity/);
  } finally {
    await registry.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("Web Workspace API creates bound sessions and rejects cwd escape", { timeout: 30_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "wuxianpi-workspace-api-"));
  const agentDir = join(root, "agent");
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  const server = createRuntimeServer({ host: "127.0.0.1", port: 0, agentDir, idleTimeoutMs: 0 });
  const address = await server.start();
  const base = `http://127.0.0.1:${address.port}/api/web/v1`;
  t.after(async () => {
    await server.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });

  const createdWorkspace = await jsonFetch(`${base}/workspaces`, {
    method: "POST", headers: jsonHeaders, body: JSON.stringify({
      id: "demo", name: "Demo Workspace", rootCwd: workspaceRoot,
      instructions: "Workspace API instruction", memory: "Workspace API memory",
    }),
  });
  assert.equal(createdWorkspace.data.workspace.name, "Demo Workspace");
  assertWorkspaceTimestamps(createdWorkspace.data.workspace);
  const createdAt = createdWorkspace.data.workspace.createdAt;

  const detail = await jsonFetch(`${base}/workspaces/demo`);
  assert.equal(detail.data.workspace.createdAt, createdAt);
  assertWorkspaceTimestamps(detail.data.workspace);

  const createdSession = await jsonFetch(`${base}/sessions`, {
    method: "POST", headers: jsonHeaders,
    body: JSON.stringify({ assistantId: "wuxianpi", workspaceId: "demo" }),
  });
  assert.equal(createdSession.data.cwd, workspaceRoot);
  assert.equal(createdSession.data.workspaceName, "Demo Workspace");
  const snapshot = await jsonFetch(`${base}/sessions/${createdSession.data.sessionId}/snapshot`);
  assert.match(snapshot.data.state.systemPrompt, /Workspace API instruction/);

  const listed = await jsonFetch(`${base}/workspaces`);
  assert.equal(listed.data.workspaces[0].memory, "Workspace API memory\n");
  assert.equal(listed.data.workspaces[0].createdAt, createdAt);
  assertWorkspaceTimestamps(listed.data.workspaces[0]);
  const patched = await jsonFetch(`${base}/workspaces/demo`, {
    method: "PATCH", headers: jsonHeaders, body: JSON.stringify({ memory: "Updated memory" }),
  });
  assert.equal(patched.data.workspace.memory, "Updated memory\n");
  assert.equal(patched.data.workspace.createdAt, createdAt);
  assertWorkspaceTimestamps(patched.data.workspace);

  const escaped = await fetch(`${base}/sessions`, {
    method: "POST", headers: jsonHeaders,
    body: JSON.stringify({ assistantId: "wuxianpi", workspaceId: "demo", cwd: root }),
  });
  assert.equal(escaped.status, 409);
  assert.equal((await escaped.json()).error.code, "session_workspace_cwd_mismatch");

  const missingAssistant = await fetch(`${base}/sessions`, {
    method: "POST", headers: jsonHeaders, body: JSON.stringify({ cwd: workspaceRoot }),
  });
  assert.equal(missingAssistant.status, 400);
  assert.equal((await missingAssistant.json()).error.code, "invalid_payload");
});

test("session rebind preserves history, reloads scope, rejects busy turns, and survives restart", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "wuxianpi-session-rebind-"));
  const agentDir = join(root, "agent");
  const alphaRoot = join(root, "alpha-workspace");
  const betaRoot = join(root, "beta-workspace");
  await Promise.all([mkdir(alphaRoot, { recursive: true }), mkdir(betaRoot, { recursive: true })]);
  await Promise.all([
    writeAssistant(agentDir, "alpha", "Alpha identity", "Alpha memory"),
    writeAssistant(agentDir, "beta", "Beta identity", "Beta memory"),
  ]);
  const makeRegistry = () => new SessionRegistry(undefined, { agentDir, idleTimeoutMs: 0 });
  let registry = makeRegistry();
  let sessionPath;
  let sessionId;
  try {
    await registry.createWorkspace({ id: "alpha-space", name: "Alpha", rootCwd: alphaRoot, instructions: "Alpha workspace" });
    await registry.createWorkspace({ id: "beta-space", name: "Beta", rootCwd: betaRoot, instructions: "Beta workspace" });
    const created = await registry.create({ assistantId: "alpha", workspaceId: "alpha-space", cwd: alphaRoot });
    const slot = await registry.getOrOpen(created.sessionId);
    persistTurn(slot, "keep this history", "history kept");
    sessionPath = slot.runtime.session.sessionFile;
    sessionId = created.sessionId;
    slot.isRunning = true;
    await assert.rejects(() => registry.rebind(sessionId, {
      assistantId: "beta", workspaceId: "beta-space", cwd: betaRoot, expectedRevision: 1,
    }), (error) => error.code === "session_busy");
    slot.isRunning = false;
    const rebound = await registry.rebind(sessionId, {
      assistantId: "beta", workspaceId: "beta-space", cwd: betaRoot, expectedRevision: 1, reason: "test",
    });
    assert.equal(rebound.sessionId, sessionId);
    assert.equal(rebound.bindingRevision, 2);
    assert.equal(rebound.cwd, betaRoot);
    const reboundSlot = await registry.getOrOpen(sessionId);
    assert.equal(reboundSlot.runtime.session.sessionFile, sessionPath);
    assert.equal(reboundSlot.runtime.session.messages.some((message) => message.role === "user" && message.content === "keep this history"), true);
    assert.match(reboundSlot.runtime.session.systemPrompt, /Beta identity/);
    assert.match(reboundSlot.runtime.session.systemPrompt, /Beta workspace/);
    assert.doesNotMatch(reboundSlot.runtime.session.systemPrompt, /Alpha workspace/);
    await assert.rejects(() => registry.rebind(sessionId, {
      assistantId: "alpha", workspaceId: "alpha-space", cwd: alphaRoot, expectedRevision: 1,
    }), (error) => error.code === "session_binding_revision_conflict");
  } finally {
    await registry.dispose();
  }
  registry = makeRegistry();
  try {
    const reopened = await registry.open(sessionPath);
    assert.equal(reopened.sessionId, sessionId);
    assert.equal(reopened.assistantId, "beta");
    assert.equal(reopened.workspaceId, "beta-space");
    assert.equal(reopened.cwd, betaRoot);
  } finally {
    await registry.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("session rebind restores the previous binding and Runtime when reconstruction fails", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "wuxianpi-session-rebind-rollback-"));
  const agentDir = join(root, "agent");
  const alphaRoot = join(root, "alpha");
  const betaRoot = join(root, "beta");
  await Promise.all([mkdir(alphaRoot, { recursive: true }), mkdir(betaRoot, { recursive: true })]);
  await Promise.all([
    writeAssistant(agentDir, "alpha", "Alpha identity", "Alpha memory"),
    writeAssistant(agentDir, "beta", "Beta identity", "Beta memory"),
  ]);
  let betaResourceLoads = 0;
  const registry = new SessionRegistry(undefined, {
    agentDir,
    idleTimeoutMs: 0,
    assistantResourcesResolver: async (assistantId) => {
      if (assistantId === "beta" && ++betaResourceLoads === 2) throw new Error("rebuild failed");
      return emptyResources();
    },
  });
  t.after(async () => { await registry.dispose(); await rm(root, { recursive: true, force: true }); });
  await registry.createWorkspace({ id: "alpha-space", name: "Alpha", rootCwd: alphaRoot });
  await registry.createWorkspace({ id: "beta-space", name: "Beta", rootCwd: betaRoot });
  const created = await registry.create({ assistantId: "alpha", workspaceId: "alpha-space", cwd: alphaRoot });
  await assert.rejects(() => registry.rebind(created.sessionId, {
    assistantId: "beta", workspaceId: "beta-space", cwd: betaRoot, expectedRevision: 1,
  }), /rebuild failed/);
  const restored = await registry.scope(created.sessionId);
  assert.equal(restored.assistantId, "alpha");
  assert.equal(restored.workspaceId, "alpha-space");
  assert.equal(restored.cwd, alphaRoot);
  assert.equal(restored.bindingRevision, 1);
  assert.match((await registry.state(created.sessionId)).systemPrompt, /Alpha identity/);
});

async function writeAssistant(agentDir, id, identity, memory) {
  const directory = join(agentDir, "assistants", id);
  await mkdir(join(directory, ".pi", "skills"), { recursive: true });
  await mkdir(join(directory, ".pi", "extensions"), { recursive: true });
  await Promise.all([
    writeFile(join(directory, "assistant.json"), JSON.stringify({ schemaVersion: 1, name: id })),
    writeFile(join(directory, "AGENTS.md"), `${identity}\n`),
    writeFile(join(directory, "MEMORY.md"), `${memory}\n`),
  ]);
}

function packageResources(assistantId, storage) {
  if (!assistantId) return emptyResources();
  const functionId = `functional.${assistantId}`;
  return emptyResources({
    appendSystemPrompt: [`Package context for ${assistantId}`],
    functionalAssistants: [{
      functionId, packageId: "test.package", name: `Function ${assistantId}`, sharingMode: "hybrid",
      defaultBindingIds: [], resolvedContributionIds: [], sharedStatePath: "/tmp/shared", profileStatePath: "/tmp/profile",
    }],
    customTools: [createFunctionalAssistantStateTool({
      assistantId,
      storage,
      bindings: [{ functionId, sharingMode: "hybrid" }],
    })],
  });
}

function emptyResources(overrides = {}) {
  return {
    extensionPaths: [], skillPaths: [], promptPaths: [], themePaths: [], appendSystemPrompt: [],
    mcpServerIds: [], webExtensionIds: [], resolvedContributionIds: [], functionalAssistants: [], customTools: [],
    experiences: [],
    ...overrides,
  };
}

function persistTurn(slot, userText, assistantText) {
  slot.runtime.session.sessionManager.appendMessage({ role: "user", content: userText, timestamp: Date.now() });
  const userEntryId = slot.runtime.session.sessionManager.getLeafId();
  slot.runtime.session.sessionManager.appendMessage({
    role: "assistant", content: [{ type: "text", text: assistantText }], api: "openai-responses",
    provider: "openai", model: "seed", usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    }, stopReason: "stop", timestamp: Date.now(),
  });
  assert.ok(userEntryId);
  return userEntryId;
}

const jsonHeaders = { "content-type": "application/json" };

async function jsonFetch(url, init) {
  const response = await fetch(url, init);
  const body = await response.json();
  assert.equal(response.ok, true, JSON.stringify(body));
  return body;
}

function assertWorkspaceTimestamps(workspace) {
  assert.equal(typeof workspace.createdAt, "string");
  assert.equal(typeof workspace.updatedAt, "string");
  assert.equal(Number.isNaN(Date.parse(workspace.createdAt)), false);
  assert.equal(Number.isNaN(Date.parse(workspace.updatedAt)), false);
}
