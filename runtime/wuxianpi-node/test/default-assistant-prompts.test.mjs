import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRuntimeServer } from "../dist/server.js";

const EXPECTED_PROMPTS = [
  "帮我整理今天的任务",
  "帮我安装一个 AI 工具",
  "我想用 OpenHouse 实现一个想法",
  "帮我完成一个复杂任务",
];

test("fresh Runtime creates the default Assistant with product starter prompts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "wuxianpi-default-prompts-"));
  const server = createRuntimeServer({
    host: "127.0.0.1",
    port: 0,
    agentDir: join(root, "agent"),
    packageManagerRoot: join(root, "packages"),
    maintenanceRoot: join(root, "maintenance"),
    idleTimeoutMs: 0,
  });
  t.after(async () => {
    await server.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });

  const address = await server.start();
  const response = await fetch(`http://127.0.0.1:${address.port}/api/web/v1/assistants/wuxianpi`);
  const body = await response.json();
  assert.equal(response.ok, true, JSON.stringify(body));
  assert.deepEqual(body.data.assistant.manifest.starterPrompts, EXPECTED_PROMPTS);
});
