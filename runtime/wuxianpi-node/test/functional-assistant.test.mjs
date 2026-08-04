import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FunctionalAssistantStorage } from "../dist/functional-assistant-storage.js";
import { createFunctionalAssistantStateTool } from "../dist/functional-assistant-tool.js";

const functionId = "io.test.coaches/assistant.english";

test("isolated functional assistant state is separated by main assistant", async () => {
  const storage = await createStorage();
  await storage.write(access("alpha", "isolated", { path: "progress/current.md", content: "alpha\n" }));
  await storage.write(access("beta", "isolated", { path: "progress/current.md", content: "beta\n" }));

  assert.equal((await storage.read(access("alpha", "isolated", { path: "progress/current.md" }))).content, "alpha\n");
  assert.equal((await storage.read(access("beta", "isolated", { path: "progress/current.md" }))).content, "beta\n");
  await assert.rejects(
    () => storage.write(access("alpha", "isolated", { path: "shared.md", content: "denied", scope: "shared" })),
    (error) => error.code === "functional_assistant_scope_denied",
  );
});

test("hybrid state reads profile overrides before shared state and merges listings", async () => {
  const storage = await createStorage();
  await storage.write(access("alpha", "hybrid", { path: "memory/rules.md", content: "shared rule\n", scope: "shared" }));
  await storage.write(access("alpha", "hybrid", { path: "memory/common.md", content: "shared common\n", scope: "shared" }));
  await storage.write(access("alpha", "hybrid", { path: "memory/rules.md", content: "alpha correction\n" }));

  const alpha = await storage.read(access("alpha", "hybrid", { path: "memory/rules.md" }));
  const beta = await storage.read(access("beta", "hybrid", { path: "memory/rules.md" }));
  assert.equal(alpha.scope, "profile");
  assert.equal(alpha.content, "alpha correction\n");
  assert.equal(beta.scope, "shared");
  assert.equal(beta.content, "shared rule\n");

  const listing = await storage.list(access("alpha", "hybrid", { path: "memory" }));
  assert.deepEqual(listing.entries.map(({ name, scope }) => ({ name, scope })), [
    { name: "common.md", scope: "shared" },
    { name: "rules.md", scope: "profile" },
  ]);
});

test("functional assistant state tool denies unbound functionIds and returns JSON-safe results", async () => {
  const storage = await createStorage();
  const tool = createFunctionalAssistantStateTool({
    assistantId: "alpha",
    storage,
    bindings: [{ functionId, sharingMode: "hybrid" }],
  });
  await assert.rejects(
    () => execute(tool, { operation: "list", functionId: "io.test.coaches/assistant.leetcode" }),
    (error) => error.code === "functional_assistant_unbound",
  );
  await assert.rejects(
    () => execute(tool, { operation: "write", functionId, path: "../escape.md", content: "no" }),
    (error) => error.code === "invalid_functional_assistant_state_path",
  );

  const written = await execute(tool, { operation: "write", functionId, path: "memory/note.md", content: "你好\n" });
  const read = await execute(tool, { operation: "read", functionId, path: "memory/note.md" });
  assert.doesNotThrow(() => JSON.stringify(written.details));
  assert.doesNotThrow(() => JSON.stringify(read.details));
  assert.match(read.content[0].text, /你好/);
  assert.equal(read.details.wuxianpiFunctionalAssistantState.scope, "profile");
});

async function createStorage() {
  return new FunctionalAssistantStorage(await mkdtemp(join(tmpdir(), "wuxianpi-functional-state-")));
}

function access(assistantId, sharingMode, extra) {
  return { functionId, assistantId, sharingMode, ...extra };
}

function execute(tool, params) {
  return tool.execute("tool-call", params, undefined, undefined, {});
}
