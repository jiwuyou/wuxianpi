import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { ProfileStateStore } from "../dist/profile-state-store.js";

test("Profile state persists explicit bindings and permits the same cwd for different assistants", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "wuxianpi-profile-state-"));
  const databasePath = join(root, "state", "profile.sqlite");
  t.after(() => rm(root, { recursive: true, force: true }));

  let tick = 0;
  const store = new ProfileStateStore({ path: databasePath, now: () => new Date(1_000 + tick++ * 1_000) });
  store.createWorkspace({ id: "shared-project", name: "Shared project", rootCwd: join(root, "project") });
  const first = store.createBinding({
    sessionId: "session-a", assistantId: "assistant-a", workspaceId: "shared-project", cwd: join(root, "project"),
  });
  const repeated = store.createBinding({
    sessionId: "session-a", assistantId: "assistant-a", workspaceId: "shared-project", cwd: join(root, "project"),
  });
  const second = store.createBinding({
    sessionId: "session-b", assistantId: "assistant-b", workspaceId: "shared-project", cwd: join(root, "project"),
  });
  assert.deepEqual(repeated, first);
  assert.equal(second.cwd, first.cwd);
  assert.notEqual(second.assistantId, first.assistantId);
  assert.equal(store.listBindings({ cwd: join(root, "project") }).length, 2);
  await assert.rejects(async () => store.createBinding({
    sessionId: "session-a", assistantId: "assistant-b", workspaceId: "shared-project", cwd: join(root, "project"),
  }), (error) => error.code === "session_binding_conflict");
  store.close();

  const reopened = new ProfileStateStore({ path: databasePath });
  t.after(() => reopened.close());
  assert.equal(reopened.getBinding("session-a").assistantId, "assistant-a");
  assert.equal(reopened.getWorkspace("shared-project").name, "Shared project");
});

test("binding inheritance is explicit and reconciliation cannot rewrite authoritative ownership", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "wuxianpi-profile-inherit-"));
  const store = new ProfileStateStore({ path: join(root, "state.sqlite") });
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  store.createWorkspace({ id: "project", name: "Project", rootCwd: join(root, "project") });
  store.createBinding({ sessionId: "source", assistantId: "main", workspaceId: "project", cwd: join(root, "project") });
  const fork = store.inheritBinding({ sourceSessionId: "source", targetSessionId: "fork" });
  assert.equal(fork.assistantId, "main");
  assert.equal(fork.workspaceId, "project");
  assert.equal(fork.inheritedFromSessionId, "source");

  assert.equal(store.reconcileBinding({
    sessionId: "fork", assistantId: "main", workspaceId: "project", cwd: join(root, "project"), inheritedFromSessionId: "source",
  }).status, "unchanged");
  await assert.rejects(async () => store.reconcileBinding({
    sessionId: "fork", assistantId: "repair", workspaceId: null, cwd: join(root, "repair"), inheritedFromSessionId: "source",
  }), (error) => error.code === "session_binding_conflict");
  const unchanged = store.getBinding("fork");
  assert.equal(unchanged.assistantId, "main");
  assert.equal(unchanged.workspaceId, "project");
  assert.equal(unchanged.cwd, join(root, "project"));
  assert.equal(unchanged.inheritedFromSessionId, "source");
  assert.equal(store.removeBinding("fork"), true);
  assert.equal(store.removeBinding("fork"), false);
});

test("workspace bindings accept only the root or real descendant paths", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "wuxianpi-profile-containment-"));
  const store = new ProfileStateStore({ path: join(root, "state.sqlite") });
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const workspaceRoot = join(root, "project");
  store.createWorkspace({ id: "project", name: "Project", rootCwd: workspaceRoot });
  assert.equal(store.createBinding({
    sessionId: "root", assistantId: "main", workspaceId: "project", cwd: workspaceRoot,
  }).cwd, workspaceRoot);
  assert.equal(store.createBinding({
    sessionId: "child", assistantId: "main", workspaceId: "project", cwd: join(workspaceRoot, "src", "module"),
  }).cwd, join(workspaceRoot, "src", "module"));
  await assert.rejects(async () => store.createBinding({
    sessionId: "sibling-prefix", assistantId: "main", workspaceId: "project", cwd: `${workspaceRoot}-copy`,
  }), (error) => error.code === "session_workspace_cwd_mismatch");
  await assert.rejects(async () => store.createBinding({
    sessionId: "unrelated", assistantId: "main", workspaceId: "project", cwd: join(root, "elsewhere"),
  }), (error) => error.code === "session_workspace_cwd_mismatch");
  assert.equal(store.createBinding({
    sessionId: "unscoped", assistantId: "main", workspaceId: null, cwd: join(root, "elsewhere"),
  }).workspaceId, null);
});

test("two store instances tolerate repeated writes to the same SQLite state", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "wuxianpi-profile-repeat-"));
  const path = join(root, "state.sqlite");
  const first = new ProfileStateStore({ path });
  const second = new ProfileStateStore({ path });
  t.after(async () => { first.close(); second.close(); await rm(root, { recursive: true, force: true }); });
  first.createWorkspace({ id: "project", name: "Project", rootCwd: join(root, "project") });
  second.createWorkspace({ id: "project", name: "Project", rootCwd: join(root, "project") });
  first.createBinding({ sessionId: "session", assistantId: "main", workspaceId: "project", cwd: join(root, "project") });
  second.createBinding({ sessionId: "session", assistantId: "main", workspaceId: "project", cwd: join(root, "project") });
  assert.equal(second.listBindings().length, 1);
});

test("binding revisions support optimistic rebind and migrate schema v1", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "wuxianpi-profile-rebind-"));
  const path = join(root, "state.sqlite");
  await mkdir(root, { recursive: true });
  const database = new DatabaseSync(path);
  database.exec(`
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, root_cwd TEXT NOT NULL, archived INTEGER NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE session_bindings (
      session_id TEXT PRIMARY KEY, assistant_id TEXT NOT NULL, workspace_id TEXT,
      cwd TEXT NOT NULL, inherited_from_session_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    INSERT INTO workspaces VALUES ('one', 'One', '${join(root, "one")}', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT INTO workspaces VALUES ('two', 'Two', '${join(root, "two")}', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT INTO session_bindings VALUES ('session', 'alpha', 'one', '${join(root, "one")}', NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    PRAGMA user_version = 1;
  `);
  database.close();

  const store = new ProfileStateStore({ path });
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  assert.equal(store.getBinding("session").bindingRevision, 1);
  const rebound = store.rebind({
    sessionId: "session", assistantId: "beta", workspaceId: "two", cwd: join(root, "two"), expectedRevision: 1,
  });
  assert.equal(rebound.bindingRevision, 2);
  assert.equal(rebound.assistantId, "beta");
  await assert.rejects(async () => store.rebind({
    sessionId: "session", assistantId: "alpha", workspaceId: "one", cwd: join(root, "one"), expectedRevision: 1,
  }), (error) => error.code === "session_binding_revision_conflict");
  assert.equal(store.getBinding("session").bindingRevision, 2);
});
