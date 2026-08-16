import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { WuxianPiPackageManager } from "../dist/package-manager.js";
import { createRuntimeServer } from "../dist/server.js";

const PACKAGE_ROOT = fileURLToPath(new URL("../builtin-packages/marketplace", import.meta.url));
const PACKAGE_ID = "com.wuxianpi.builtin.marketplace";
const CONTEXT_ID = `${PACKAGE_ID}/context.marketplace`;
const SKILL_ID = `${PACKAGE_ID}/skill.marketplace`;

test("bundled Marketplace Package makes market knowledge available to every assistant", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "wuxianpi-marketplace-package-"));
  const manager = new WuxianPiPackageManager({ agentDir: join(root, "agent"), rootDir: join(root, "packages") });
  t.after(() => rm(root, { recursive: true, force: true }));

  await manager.ensureBundledPackage(PACKAGE_ROOT);

  const state = await manager.store.read();
  assert.equal(state.packages[PACKAGE_ID].sourceKind, "bundled");
  assert.equal(state.contributions[CONTEXT_ID].enabled, true);
  assert.equal(state.contributions[SKILL_ID].enabled, true);

  const resources = await manager.resolveAssistantResources("fresh-assistant");
  assert.equal(resources.skillPaths.length, 1);
  assert.match(resources.skillPaths[0], /skills\/marketplace$/);
  assert.match(resources.appendSystemPrompt.join("\n"), /wuxianpihub\.webefficacy\.com/);
  assert.match(resources.appendSystemPrompt.join("\n"), /主菜单 → WuxianPi 市场/);

  const skill = await readFile(join(PACKAGE_ROOT, "skills", "marketplace", "SKILL.md"), "utf8");
  assert.match(skill, /name: wuxianpi-marketplace/);
  assert.match(skill, /不得静默安装/);
  assert.match(skill, /通常应绑定当前助手/);
});

test("fresh Runtime startup automatically installs the bundled Marketplace Package", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "wuxianpi-marketplace-startup-"));
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
  const response = await fetch(`http://127.0.0.1:${address.port}/api/web/v1/packages`);
  const body = await response.json();
  assert.equal(response.ok, true, JSON.stringify(body));
  assert.equal(body.data.packages.some((item) => item.packageId === PACKAGE_ID && item.sourceKind === "bundled"), true);
});
