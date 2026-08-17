import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createMarketplaceTools } from "../dist/marketplace-tool.js";

const PACKAGE_ID = "io.deepseek.dsh";

function fixture(overrides = {}) {
  let installCalls = 0;
  const sourcePath = overrides.sourcePath;
  return {
    get installCalls() { return installCalls; },
    host: {
      async search() {
        return {
          packages: [{ id: PACKAGE_ID, name: "DeepSeek Harness for OpenHouse", summary: "Solution", categories: ["solution"], latestReleaseId: "rel-1" }],
          nextCursor: null,
        };
      },
      async packageDetail() {
        return { package: { id: PACKAGE_ID, name: "DeepSeek Harness for OpenHouse", summary: "Solution", categories: ["solution"], latestReleaseId: "rel-1" } };
      },
      async releases() {
        return { releases: [{ releaseId: "rel-1", version: "0.2.0", approvedCommit: "a".repeat(40), status: "approved" }] };
      },
      async installPlan() {
        return {
          schemaVersion: 1,
          packageId: PACKAGE_ID,
          releaseId: "rel-1",
          version: "0.2.0",
          approvedCommit: "a".repeat(40),
          manifestPath: "wuxianpi-package.json",
          manifestDigest: "b".repeat(64),
          gitSources: [{ kind: "github", url: "https://github.com/jiwuyou/deepseek-harness-openhouse", priority: 100 }],
          artifacts: [],
          compatibility: { hostCapabilities: [], packages: [] },
          verification: { status: "passed", checks: [] },
          revoked: false,
        };
      },
      async install() {
        installCalls += 1;
        return { package: { packageId: PACKAGE_ID }, sourceUrl: "https://github.com/jiwuyou/deepseek-harness-openhouse" };
      },
      async installedDetail() {
        if (!sourcePath) throw new Error("not installed");
        return {
          packageId: PACKAGE_ID,
          name: "DeepSeek Harness for OpenHouse",
          version: "0.2.0",
          manifest: { categories: ["solution"] },
          location: {
            packageRoot: join(sourcePath, ".."),
            sourcePath,
            activeRevisionPath: join(sourcePath, "..", "revisions", "active"),
            dataPath: join(sourcePath, "..", "data"),
            logsPath: join(sourcePath, "..", "logs"),
          },
        };
      },
    },
  };
}

function tool(tools, name) {
  const found = tools.find((item) => item.name === name);
  assert.ok(found, `missing tool ${name}`);
  return found;
}

test("search_marketplace returns compact current marketplace results", async () => {
  const setup = fixture();
  const tools = createMarketplaceTools(setup.host);
  const result = await tool(tools, "search_marketplace").execute("search-1", { query: "DeepSeek" }, undefined, undefined, {});
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.packages[0].id, PACKAGE_ID);
  assert.deepEqual(parsed.packages[0].categories, ["solution"]);
});

test("install_marketplace_package does not install when confirmation is cancelled", async () => {
  const setup = fixture();
  const tools = createMarketplaceTools(setup.host);
  const result = await tool(tools, "install_marketplace_package").execute(
    "install-1",
    { packageId: PACKAGE_ID },
    undefined,
    undefined,
    { ui: { confirm: async () => false } },
  );
  assert.equal(setup.installCalls, 0);
  assert.match(result.content[0].text, /取消/);
});

test("install_marketplace_package returns the local solution README path", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "wuxianpi-marketplace-solution-"));
  const sourcePath = join(root, "source");
  await mkdir(sourcePath, { recursive: true });
  await writeFile(join(sourcePath, "README.md"), "# Solution\n");
  t.after(() => rm(root, { recursive: true, force: true }));

  const setup = fixture({ sourcePath });
  const tools = createMarketplaceTools(setup.host);
  const result = await tool(tools, "install_marketplace_package").execute(
    "install-2",
    { packageId: PACKAGE_ID },
    undefined,
    undefined,
    { ui: { confirm: async () => true } },
  );
  assert.equal(setup.installCalls, 1);
  assert.match(result.content[0].text, new RegExp(sourcePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(result.content[0].text, /README\.md/);
  assert.equal(result.details.wuxianpiMarketplace.nextAction.entryPath, join(sourcePath, "README.md"));
  assert.equal(result.details.wuxianpiMarketplace.nextAction.entryExists, true);
});
