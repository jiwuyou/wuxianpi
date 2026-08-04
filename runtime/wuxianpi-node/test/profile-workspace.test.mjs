import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProfileStateStore } from "../dist/profile-state-store.js";
import { WorkspaceManager } from "../dist/workspace-manager.js";

test("Workspace CRUD keeps instructions and memory outside project files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "wuxianpi-workspace-"));
  const project = join(root, "external-project");
  const store = new ProfileStateStore({ path: join(root, "state.sqlite") });
  const manager = new WorkspaceManager({ stateStore: store, contextRoot: join(root, "managed-workspaces") });
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });

  const created = await manager.create({
    id: "coding", name: "Coding", rootCwd: project,
    instructions: "Use the repository conventions.", memory: "The build is slow.",
  });
  assert.equal(created.workspace.id, "coding");
  assert.equal(created.instructions, "Use the repository conventions.\n");
  await assert.rejects(() => access(join(project, "INSTRUCTIONS.md")), (error) => error.code === "ENOENT");
  assert.equal(await readFile(created.memoryPath, "utf8"), "The build is slow.\n");

  const updated = await manager.update("coding", {
    name: "Coding project", archived: true, instructions: "Run focused tests first.",
  });
  assert.equal(updated.workspace.name, "Coding project");
  assert.equal(updated.workspace.archived, true);
  assert.equal(updated.instructions, "Run focused tests first.\n");
  assert.deepEqual(manager.list(), []);
  assert.equal(manager.list({ includeArchived: true })[0].id, "coding");

  const reopened = new WorkspaceManager({ stateStore: store, contextRoot: join(root, "managed-workspaces") });
  assert.equal((await reopened.get("coding")).memory, "The build is slow.\n");
  assert.equal(await reopened.remove("coding"), true);
  assert.equal(await reopened.remove("coding"), false);
});

test("Workspace paths and identifiers are validated before writing", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "wuxianpi-workspace-path-"));
  const store = new ProfileStateStore({ path: join(root, "state.sqlite") });
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  assert.throws(() => new WorkspaceManager({ stateStore: store, contextRoot: "relative/context" }),
    (error) => error.code === "invalid_profile_path");
  const manager = new WorkspaceManager({ stateStore: store, contextRoot: join(root, "contexts") });
  await assert.rejects(() => manager.create({ id: "../escape", name: "Escape", rootCwd: join(root, "project") }),
    (error) => error.code === "invalid_profile_id");
  await assert.rejects(() => manager.create({ id: "relative", name: "Relative", rootCwd: "project" }),
    (error) => error.code === "invalid_profile_path");
  const workspace = await manager.create({
    id: "valid", name: "Valid", rootCwd: join(root, "project"), instructions: "Original instructions",
  });
  await assert.rejects(() => manager.update("valid", { rootCwd: "relative", instructions: "Must not be written" }),
    (error) => error.code === "invalid_profile_path");
  assert.equal(await readFile(workspace.instructionsPath, "utf8"), "Original instructions\n");
});
