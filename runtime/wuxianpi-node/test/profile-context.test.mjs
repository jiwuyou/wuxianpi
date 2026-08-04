import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProfileContextAssembler } from "../dist/profile-context.js";
import { ProfileStateStore } from "../dist/profile-state-store.js";
import { WorkspaceManager } from "../dist/workspace-manager.js";

test("Profile context has deterministic layer ordering and resource metadata", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "wuxianpi-profile-context-"));
  const agentDir = join(root, "agent");
  const assistantsRoot = join(agentDir, "assistants");
  const assistantRoot = join(assistantsRoot, "main");
  const sharedUserPath = join(agentDir, "wuxianpi", "USER.md");
  await mkdir(assistantRoot, { recursive: true });
  await mkdir(join(agentDir, "wuxianpi"), { recursive: true });
  await writeFile(sharedUserPath, "User prefers concise answers.\n");
  await writeFile(join(assistantRoot, "AGENTS.md"), "You are the main assistant.\n");
  await writeFile(join(assistantRoot, "MEMORY.md"), "Remember the ongoing product design.\n");
  const store = new ProfileStateStore({ path: join(root, "state.sqlite") });
  const workspaces = new WorkspaceManager({ stateStore: store, contextRoot: join(agentDir, "wuxianpi", "workspaces") });
  await workspaces.create({
    id: "product", name: "Product", rootCwd: join(root, "product"),
    instructions: "Follow product decisions.", memory: "The current milestone is Profile support.",
  });
  const assembler = new ProfileContextAssembler({ sharedUserPath, assistantsRoot, workspaceManager: workspaces });
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });

  const input = {
    assistantId: "main", workspaceId: "product",
    packageContexts: [
      { id: "io.example/z-package", title: "Z package", content: "Package Z context." },
      { id: "io.example/a-package", title: "A package", content: "Package A context." },
    ],
    functionalAssistantContexts: [
      { id: "io.example/english-coach", title: "English coach", content: "English coaching memory." },
    ],
  };
  const first = await assembler.assemble(input);
  const second = await assembler.assemble(input);
  assert.deepEqual(second, first);
  const expectedTitles = [
    "Shared user profile", "Assistant identity and behavior", "Assistant long-term memory",
    "Workspace instructions", "Workspace memory", "A package", "Z package", "English coach",
  ];
  assert.deepEqual(first.resources.map((resource) => resource.title), expectedTitles);
  assert.deepEqual(first.resources.map((resource) => resource.order), expectedTitles.map((_, index) => index));
  assert.equal(first.resources.every((resource) => /^[a-f0-9]{64}$/.test(resource.sha256)), true);
  let previous = -1;
  for (const title of expectedTitles) {
    const index = first.prompt.indexOf(`## ${title}`);
    assert.ok(index > previous, `${title} was out of order`);
    previous = index;
  }
});

test("Profile context rejects unsafe assistant and caller resource paths", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "wuxianpi-profile-context-path-"));
  const assistantsRoot = join(root, "assistants");
  await mkdir(join(assistantsRoot, "main"), { recursive: true });
  const store = new ProfileStateStore({ path: join(root, "state.sqlite") });
  const workspaces = new WorkspaceManager({ stateStore: store, contextRoot: join(root, "workspaces") });
  const assembler = new ProfileContextAssembler({
    sharedUserPath: join(root, "USER.md"), assistantsRoot, workspaceManager: workspaces,
  });
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  await assert.rejects(() => assembler.assemble({ assistantId: "../escape" }),
    (error) => error.code === "invalid_profile_id");
  await assert.rejects(() => assembler.assemble({
    assistantId: "main", packageContexts: [{ id: "package", content: "x", sourcePath: "relative.md" }],
  }), (error) => error.code === "invalid_profile_path");
});
