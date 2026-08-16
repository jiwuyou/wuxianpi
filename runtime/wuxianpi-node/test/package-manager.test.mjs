import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WuxianPiPackageManager } from "../dist/package-manager.js";
import { PackageArtifactManager } from "../dist/package-artifacts.js";
import { runBoundedCommand } from "../dist/package-build.js";
import { PackageExperienceManager } from "../dist/package-experience.js";
import { MarketClient } from "../dist/market-client.js";
import { validatePackageManifest } from "../dist/package-validator.js";
import { SessionRegistry } from "../dist/session-registry.js";
import { ServiceManagerClient } from "../dist/service-manager-client.js";
import { WebServices } from "../dist/web-services.js";

test("Package Manager falls back from GitHub to a true mirror and fetches only the approved commit", async () => {
  const root = await mkdtemp(join(tmpdir(), "wuxianpi-package-fallback-"));
  const repo = await createRepository(join(root, "upstream"), basicManifest("io.test.fallback"), {
    "skills/basic/SKILL.md": skill("fallback"),
  });
  const plan = installPlan(repo, [
    { kind: "github", url: join(root, "missing-github"), priority: 100 },
    { kind: "mirror", url: repo.path, priority: 80 },
  ]);
  const manager = createManager(root, new FakeMarket({ [plan.packageId]: plan }));
  const installed = await manager.install(plan.packageId);
  assert.equal(installed.sourceUrl, repo.path);
  assert.equal(installed.package.baseCommit, repo.commit);
  assert.equal(exec(repoSource(manager, plan.packageId), ["rev-parse", "HEAD"]), repo.commit);
  const detail = await manager.detail(plan.packageId);
  assert.deepEqual(detail.location, {
    packageRoot: join(root, "manager", "packages", plan.packageId),
    sourcePath: join(root, "manager", "packages", plan.packageId, "source"),
    activeRevisionPath: join(root, "manager", "packages", plan.packageId, "revisions", detail.activeRevisionId),
    dataPath: join(root, "manager", "packages", plan.packageId, "data"),
    logsPath: join(root, "manager", "packages", plan.packageId, "logs"),
  });
});

test("exact dependencies select an older immutable Hub release instead of the default plan", async () => {
  const root = await mkdtemp(join(tmpdir(), "wuxianpi-package-dependency-"));
  const dependencyId = "io.test.dependency";
  const dependency = await createRepository(join(root, "dependency"), basicManifest(dependencyId), {
    "skills/basic/SKILL.md": skill("dependency-v1"),
  });
  const olderPlan = installPlan(dependency);
  const dependencyV2Manifest = { ...basicManifest(dependencyId), version: "2.0.0" };
  await writeFile(join(dependency.path, "wuxianpi-package.json"), `${JSON.stringify(dependencyV2Manifest, null, 2)}\n`);
  await writeFile(join(dependency.path, "skills/basic/SKILL.md"), skill("dependency-v2"));
  const dependencyV2 = await commitRepository(dependency.path, "Dependency v2");
  const latestPlan = installPlan({ ...dependency, ...dependencyV2 });

  const parentId = "io.test.parent";
  const parentManifest = basicManifest(parentId);
  parentManifest.requires.packages = [{
    packageId: dependencyId,
    approvedCommit: olderPlan.approvedCommit,
    requiredContributionIds: [`${dependencyId}/skill.basic`],
  }];
  const parent = await createRepository(join(root, "parent"), parentManifest, { "skills/basic/SKILL.md": skill("parent") });
  const market = new FakeMarket({ [parentId]: installPlan(parent), [dependencyId]: latestPlan });
  market.releasePlans[dependencyId] = [latestPlan, olderPlan];
  const manager = createManager(root, market);
  await manager.install(parentId);
  assert.equal((await manager.detail(dependencyId)).baseCommit, olderPlan.approvedCommit);
});

test("MarketClient resolves an exact commit across paginated historical releases", async () => {
  const commit = "1".repeat(40);
  const digest = "2".repeat(64);
  const requests = [];
  const client = new MarketClient({
    baseUrl: "https://hub.example",
    fetchImpl: async (url) => {
      requests.push(String(url));
      const parsed = new URL(String(url));
      if (parsed.pathname.endsWith("/releases") && !parsed.searchParams.has("cursor")) {
        return Response.json({ packageId: "io.test.dep", releases: [], nextCursor: "older" });
      }
      if (parsed.pathname.endsWith("/releases")) {
        return Response.json({ packageId: "io.test.dep", releases: [{ releaseId: "rel-old", approvedCommit: commit, status: "approved" }], nextCursor: null });
      }
      return Response.json({
        schemaVersion: 1, packageId: "io.test.dep", releaseId: "rel-old", version: "1.0.0",
        approvedCommit: commit, manifestPath: "wuxianpi-package.json", manifestDigest: digest,
        gitSources: [{ kind: "github", url: "https://github.com/example/dep.git", priority: 100 }], artifacts: [],
        compatibility: { hostCapabilities: [], packages: [] }, verification: { status: "passed" }, revoked: false,
      });
    },
  });
  const plan = await client.installPlanForCommit("io.test.dep", commit);
  assert.equal(plan.releaseId, "rel-old");
  assert.equal(requests.some((url) => url.includes("cursor=older")), true);
  assert.equal(requests.at(-1).includes("releaseId=rel-old"), true);
});

test("a real three-way merge keeps conflicts in source and leaves the active revision unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "wuxianpi-package-conflict-"));
  const packageId = "io.test.conflict";
  const repo = await createRepository(join(root, "upstream"), basicManifest(packageId), {
    "skills/basic/SKILL.md": skill("conflict"),
    "shared.txt": "official v1\n",
  });
  const market = new FakeMarket({ [packageId]: installPlan(repo) });
  const manager = createManager(root, market);
  await manager.install(packageId);
  const source = repoSource(manager, packageId);
  const before = await manager.detail(packageId);
  await writeFile(join(source, "shared.txt"), "local correction\n");
  await manager.commitLocalChanges(packageId, "Local correction");
  const local = await manager.detail(packageId);
  assert.notEqual(local.activeRevisionId, before.activeRevisionId);

  await writeFile(join(repo.path, "shared.txt"), "official v2\n");
  const v2 = await commitRepository(repo.path, "Official v2");
  market.plans[packageId] = installPlan({ ...repo, ...v2 });
  await assert.rejects(() => manager.update(packageId), (error) => error.code === "merge_conflict");
  const after = await manager.detail(packageId);
  assert.equal(after.activeRevisionId, local.activeRevisionId);
  assert.equal(after.sourceStatus, "merge_conflict");
  assert.deepEqual(after.git.conflicts, ["shared.txt"]);
});

test("artifact SHA mismatch rejects activation", async () => {
  const root = await mkdtemp(join(tmpdir(), "wuxianpi-package-artifact-"));
  const packageId = "io.test.artifact";
  const good = Buffer.from("good");
  const artifact = {
    id: `${packageId}/artifact.binary`, fileName: "bin/tool", sha256: sha(good), sizeBytes: good.length,
    archive: "none", platforms: [{ os: "any", arch: "any" }],
    sources: [{ kind: "github-release", url: "https://example.invalid/tool", priority: 100 }],
  };
  const manifest = {
    ...basicManifest(packageId),
    build: { mode: "artifact", artifactIds: [artifact.id] },
    artifacts: [artifact],
  };
  const repo = await createRepository(join(root, "upstream"), manifest, { "skills/basic/SKILL.md": skill("artifact") });
  const plan = installPlan(repo);
  plan.artifacts = [artifact];
  const artifacts = new PackageArtifactManager({ fetchImpl: async () => new Response(Buffer.from("baad"), { status: 200 }) });
  const manager = createManager(root, new FakeMarket({ [packageId]: plan }), { artifacts });
  await assert.rejects(() => manager.install(packageId), (error) =>
    error.code === "artifact_download_failed" && JSON.stringify(error.details).includes("SHA-256 mismatch"));
  const detail = await manager.detail(packageId);
  assert.equal(detail.activeRevisionId, null);
  assert.equal(detail.sourceStatus, "build_failed");
});

test("failed update build preserves the previous active revision", async () => {
  const root = await mkdtemp(join(tmpdir(), "wuxianpi-package-build-"));
  const packageId = "io.test.build";
  const repo = await createRepository(join(root, "upstream"), basicManifest(packageId), { "skills/basic/SKILL.md": skill("build") });
  const market = new FakeMarket({ [packageId]: installPlan(repo) });
  const manager = createManager(root, market);
  await manager.install(packageId);
  const before = await manager.detail(packageId);
  const nextManifest = { ...basicManifest(packageId), version: "2.0.0", build: { mode: "local", commands: { build: { command: "exit 7", timeoutSeconds: 5 } } } };
  await writeFile(join(repo.path, "wuxianpi-package.json"), `${JSON.stringify(nextManifest, null, 2)}\n`);
  const v2 = await commitRepository(repo.path, "Broken v2");
  market.plans[packageId] = installPlan({ ...repo, ...v2 });
  await assert.rejects(() => manager.update(packageId), (error) => error.code === "package_command_failed");
  const after = await manager.detail(packageId);
  assert.equal(after.activeRevisionId, before.activeRevisionId);
  assert.equal(after.baseCommit, before.baseCommit);
  assert.equal(after.sourceStatus, "build_failed");
  assert.match(after.lastError.logPath, /logs/);
});

test("timed out Package commands terminate their entire process group", async () => {
  const root = await mkdtemp(join(tmpdir(), "wuxianpi-package-timeout-"));
  const marker = join(root, "descendant.txt");
  await assert.rejects(() => runBoundedCommand(root, {
    command: `(trap '' TERM; sleep 2; printf leaked > "${marker}") & wait`, timeoutSeconds: 1,
  }, join(root, "build.log")), (error) => error.code === "package_command_timeout");
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await assert.rejects(() => readFile(marker, "utf8"), (error) => error.code === "ENOENT");
});

test("mainstream experience updates track revisions, preserve local priority, and retain conflicts", async () => {
  const root = await mkdtemp(join(tmpdir(), "wuxianpi-package-experience-"));
  const packageId = "io.test.experience";
  const contributionId = `${packageId}/experience.main`;
  const responses = [
    { revision: "revision-1", content: "stable header\nbase value\nstable footer\n" },
    { revision: "revision-2", content: "stable header\nupdated value\nstable footer\n" },
    { revision: "revision-3", content: "stable header\nupdated value\nstable footer\n\nmainstream addition\n" },
  ];
  const experienceManager = new PackageExperienceManager({ fetchImpl: async () => Response.json(responses.shift()) });
  const manifest = {
    ...basicManifest(packageId),
    contributions: [{
      id: contributionId, type: "wuxianpi.experience", name: "Experience", basePath: "experience/base.md",
      experienceSpaceId: "experience.shared", mainstream: { type: "https-json", url: "https://example.com/mainstream.json" },
      updatePolicy: { strategy: "three-way-merge", priority: ["local-verified-correction", "mainstream", "package-base"], localCorrections: "preserve" },
      assistantSelectable: true,
    }],
  };
  const repo = await createRepository(join(root, "upstream"), manifest, { "experience/base.md": "Package base\n" });
  const manager = createManager(root, new FakeMarket({ [packageId]: installPlan(repo) }), { experienceManager });
  await manager.install(packageId);
  const first = await manager.updateExperience(contributionId);
  assert.equal(first.currentRevision, "revision-1");
  await writeFile(first.localCorrectionPath, "local correction\n");
  const second = await manager.updateExperience(contributionId);
  assert.equal(second.previousRevision, "revision-1");
  assert.equal(second.currentRevision, "revision-2");
  assert.match(await readFile(second.effectivePath, "utf8"), /local correction/);
  assert.match(await readFile(second.effectivePath, "utf8"), /updated/);
  const conflicted = await manager.updateExperience(contributionId);
  assert.equal(conflicted.status, "conflict");
  assert.equal(conflicted.currentRevision, "revision-2");
  assert.equal(conflicted.candidateRevision, "revision-3");
  assert.match(await readFile(conflicted.conflictPath, "utf8"), /<<<<<<<|>>>>>>>/);
  assert.equal(await readFile(conflicted.localCorrectionPath, "utf8"), "local correction\n");
});

test("local validation rejects invalid frozen child manifest types before activation", async () => {
  const root = await mkdtemp(join(tmpdir(), "wuxianpi-package-children-"));
  const packageId = "io.test.children";
  const fixtures = [
    [{ id: `${packageId}/web.main`, type: "wuxianpi.webExtension", name: "Web", manifest: "web.json", assistantSelectable: true }, { "web.json": { schemaVersion: 1, apiVersion: "1", id: "web", name: "Web", version: "1.0.0" } }],
    [{ id: `${packageId}/assistant.main`, type: "wuxianpi.assistantTemplate", name: "Assistant", manifest: "assistant.json", kind: "functional", defaultBindings: [] }, { "assistant.json": { name: "Assistant" } }],
    [{ id: `${packageId}/app.main`, type: "openhouse.app", name: "App", manifest: "app.json" }, { "app.json": { schemaVersion: 1, name: "App" } }],
    [{ id: `${packageId}/service.main`, type: "service-manager.service", name: "Service", manifest: "service.json" }, { "service.json": { schemaVersion: 1, id: "svc", service: { name: "svc", provider: "termux-process", command: "bad" } } }],
    [{ id: `${packageId}/mcp.main`, type: "mcp.server", name: "MCP", config: "mcp.json", assistantSelectable: true }, { "mcp.json": { id: "mcp", name: "MCP", transport: "streamable-http", url: "https://example.com/mcp", authentication: { type: "oauth" } } }],
  ];
  for (const [contribution, files] of fixtures) {
    const directory = join(root, contribution.type.replaceAll(".", "-"));
    await mkdir(directory, { recursive: true });
    for (const [name, value] of Object.entries(files)) await writeFile(join(directory, name), typeof value === "string" ? value : JSON.stringify(value));
    const manifest = { ...basicManifest(packageId), contributions: [contribution] };
    await assert.rejects(() => validatePackageManifest(directory, manifest), (error) => error.code.startsWith("invalid_"));
  }
});

test("assistant bindings resolve one installed Package without copying dependencies", async () => {
  const root = await mkdtemp(join(tmpdir(), "wuxianpi-package-binding-"));
  const packageId = "io.test.binding";
  const manifest = {
    ...basicManifest(packageId),
    contributions: [
      { id: `${packageId}/skill.ops`, type: "pi.skill", name: "Ops", path: "skills/ops", assistantSelectable: true },
      { id: `${packageId}/extension.ops`, type: "pi.extension", name: "Ops extension", path: "extensions/ops.ts", assistantSelectable: true },
      { id: `${packageId}/mcp.ops`, type: "mcp.server", name: "Ops MCP", config: "mcp/ops.json", assistantSelectable: true },
      {
        id: `${packageId}/experience.ops`, type: "wuxianpi.experience", name: "Ops experience",
        experienceSpaceId: "ops.shared", basePath: "experience/base.md",
        mainstream: { type: "https-json", url: "https://example.com/experience.json" },
        updatePolicy: { strategy: "three-way-merge", priority: ["local-verified-correction", "mainstream", "package-base"], localCorrections: "preserve" },
        assistantSelectable: true,
      },
    ],
  };
  const repo = await createRepository(join(root, "upstream"), manifest, {
    "skills/ops/SKILL.md": skill("ops"),
    "extensions/ops.ts": `export default function (pi) {
      pi.registerTool({
        name: "ops_package_tool",
        label: "Ops package tool",
        description: "Package-bound test tool",
        parameters: { type: "object", properties: {} },
        async execute() { return { content: [{ type: "text", text: "ok" }], details: {} }; },
      });
    }\n`,
    "mcp/ops.json": `${JSON.stringify({ id: "ops-mcp", name: "Ops MCP", transport: "streamable-http", url: "https://example.com/mcp", auth: false })}\n`,
    "experience/base.md": "Package experience\n",
  });
  const manager = createManager(root, new FakeMarket({ [packageId]: installPlan(repo) }));
  await manager.install(packageId);
  const ids = manifest.contributions.map((item) => item.id);
  await manager.setAssistantBinding("main", { enabledContributionIds: ids, experienceSpaces: { [`${packageId}/experience.ops`]: "ops.main-private" } });
  const resources = await manager.resolveAssistantResources("main");
  assert.equal(resources.extensionPaths.length, 1);
  assert.equal(resources.skillPaths.length, 1);
  assert.deepEqual(resources.mcpServerIds, ["ops-mcp"]);
  assert.equal(resources.experiences[0].experienceSpaceId, "ops.main-private");
  assert.match(resources.appendSystemPrompt.join("\n"), /Package experience/);
  assert.equal(resources.extensionPaths[0].includes("/revisions/"), true);
  assert.equal(resources.extensionPaths[0].includes("/assistants/main/"), false);

  const registry = new SessionRegistry(undefined, {
    agentDir: join(root, "agent"), idleTimeoutMs: 0,
    assistantResourcesResolver: async () => manager.resolveAssistantResources("main"),
  });
  try {
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    const session = await registry.create(workspace);
    const commands = await registry.commands(session.sessionId);
    assert.equal(commands.commands.some((command) => command.name === "skill:ops"), true);
    const tools = await registry.tools(session.sessionId);
    assert.equal(tools.tools.some((tool) => tool.name === "ops_package_tool"), true);
    assert.equal(tools.activeToolNames.includes("ops_package_tool"), true);
  } finally {
    await registry.dispose();
  }
});

test("functional assistant templates expand deduplicated bindings and preserve state across Package updates", async () => {
  const root = await mkdtemp(join(tmpdir(), "wuxianpi-functional-package-"));
  const packageId = "io.test.functional";
  const skillId = `${packageId}/skill.ops`;
  const contextId = `${packageId}/context.ops`;
  const functionId = `${packageId}/assistant.ops`;
  const secondFunctionId = `${packageId}/assistant.audit`;
  const thirdFunctionId = `${packageId}/assistant.report`;
  const manifest = {
    ...basicManifest(packageId),
    categories: ["assistant", "skill"],
    contributions: [
      { id: skillId, type: "pi.skill", name: "Ops", path: "skills/ops", assistantSelectable: true },
      { id: contextId, type: "wuxianpi.context", name: "Ops context", path: "context.md", format: "markdown", assistantSelectable: true },
      {
        id: functionId,
        type: "wuxianpi.assistantTemplate",
        name: "Ops helper",
        description: "Stateful operations helper",
        manifest: "assistant.json",
        kind: "functional",
        defaultBindings: [skillId, contextId, skillId],
      },
      {
        id: secondFunctionId,
        type: "wuxianpi.assistantTemplate",
        name: "Audit helper",
        manifest: "assistant.json",
        kind: "functional",
        defaultBindings: [skillId],
      },
      {
        id: thirdFunctionId,
        type: "wuxianpi.assistantTemplate",
        name: "Report helper",
        manifest: "assistant.json",
        kind: "functional",
        defaultBindings: [contextId],
      },
    ],
  };
  const repo = await createRepository(join(root, "upstream"), manifest, {
    "skills/ops/SKILL.md": skill("ops"),
    "context.md": "Operations context v1\n",
    "assistant.json": JSON.stringify({
      schemaVersion: 1,
      name: "Ops helper",
      description: "Stateful operations helper",
      greeting: "What should we operate?",
      model: "inherit",
      thinkingLevel: "inherit",
    }),
  });
  const market = new FakeMarket({ [packageId]: installPlan(repo) });
  const manager = createManager(root, market);
  await manager.install(packageId);
  const binding = await manager.setAssistantBinding("main", {
    enabledContributionIds: [functionId, secondFunctionId, skillId],
    functionalAssistants: {
      [functionId]: { sharingMode: "isolated" },
      [secondFunctionId]: { sharingMode: "shared" },
    },
  });
  assert.deepEqual(binding.functionalAssistants, {
    [functionId]: { sharingMode: "isolated" },
    [secondFunctionId]: { sharingMode: "shared" },
  });
  const ordinaryUpdate = await manager.setAssistantBinding("main", {
    enabledContributionIds: [functionId, secondFunctionId, skillId, contextId],
  });
  assert.deepEqual(ordinaryUpdate.functionalAssistants, {
    [functionId]: { sharingMode: "isolated" },
    [secondFunctionId]: { sharingMode: "shared" },
  });
  const addedFunctionalAssistant = await manager.setAssistantBinding("main", {
    enabledContributionIds: [functionId, secondFunctionId, thirdFunctionId, skillId, contextId],
  });
  assert.deepEqual(addedFunctionalAssistant.functionalAssistants, {
    [functionId]: { sharingMode: "isolated" },
    [secondFunctionId]: { sharingMode: "shared" },
    [thirdFunctionId]: { sharingMode: "hybrid" },
  });

  const resources = await manager.resolveAssistantResources("main");
  assert.equal(resources.skillPaths.length, 1);
  assert.equal(resources.appendSystemPrompt.filter((value) => value.includes("Operations context v1")).length, 1);
  assert.deepEqual(resources.resolvedContributionIds.sort(), [contextId, functionId, secondFunctionId, thirdFunctionId, skillId].sort());
  assert.equal(resources.functionalAssistants.length, 3);
  assert.equal(resources.functionalAssistants.find((item) => item.functionId === functionId).sharingMode, "isolated");
  assert.equal(resources.functionalAssistants.find((item) => item.functionId === secondFunctionId).sharingMode, "shared");
  assert.equal(resources.functionalAssistants.find((item) => item.functionId === thirdFunctionId).sharingMode, "hybrid");
  assert.deepEqual(resources.functionalAssistants.find((item) => item.functionId === functionId).resolvedContributionIds.sort(), [contextId, skillId].sort());
  assert.deepEqual(resources.customTools.map((tool) => tool.name), ["functional_assistant_state"]);

  await manager.functionalAssistantStorage.write({
    functionId,
    assistantId: "main",
    sharingMode: "isolated",
    path: "memory/progress.md",
    content: "local progress\n",
  });
  const nextManifest = { ...manifest, version: "2.0.0" };
  await writeFile(join(repo.path, "wuxianpi-package.json"), `${JSON.stringify(nextManifest, null, 2)}\n`);
  await writeFile(join(repo.path, "context.md"), "Operations context v2\n");
  const v2 = await commitRepository(repo.path, "Functional assistant v2");
  market.plans[packageId] = installPlan({ ...repo, ...v2 });
  await manager.update(packageId);

  const persisted = await manager.functionalAssistantStorage.read({
    functionId,
    assistantId: "main",
    sharingMode: "isolated",
    path: "memory/progress.md",
  });
  assert.equal(persisted.content, "local progress\n");
  assert.match((await manager.resolveAssistantResources("main")).appendSystemPrompt.join("\n"), /Operations context v2/);
  const droppedSharedAndNew = await manager.setAssistantBinding("main", {
    enabledContributionIds: [functionId, skillId],
  });
  assert.deepEqual(droppedSharedAndNew.functionalAssistants, {
    [functionId]: { sharingMode: "isolated" },
  });
  const droppedIsolated = await manager.setAssistantBinding("main", {
    enabledContributionIds: [skillId],
  });
  assert.deepEqual(droppedIsolated.functionalAssistants, {});
  await manager.uninstall(packageId);
  assert.equal((await manager.functionalAssistantStorage.read({
    functionId,
    assistantId: "main",
    sharingMode: "isolated",
    path: "memory/progress.md",
  })).content, "local progress\n");
});

test("Package-owned MCP and service contributions preserve unrelated config and follow contribution lifecycle", async () => {
  const root = await mkdtemp(join(tmpdir(), "wuxianpi-package-owned-"));
  const packageId = "io.test.owned";
  const manifest = {
    ...basicManifest(packageId),
    contributions: [
      { id: `${packageId}/mcp.owned`, type: "mcp.server", name: "Owned MCP", config: "mcp/owned.json", assistantSelectable: true },
      { id: `${packageId}/service.owned`, type: "service-manager.service", name: "Owned service", manifest: "service/service.json" },
    ],
  };
  const repo = await createRepository(join(root, "upstream"), manifest, {
    "mcp/owned.json": `${JSON.stringify({ id: "owned-mcp", name: "Owned MCP", transport: "streamable-http", url: "https://example.com/mcp", auth: false })}\n`,
    "service/service.json": `${JSON.stringify(serviceManifest("owned-service", ["sh", "-lc", "sleep 60"]))}\n`,
  });
  const mcpPath = join(root, "mcp", "mcp.json");
  await mkdir(join(root, "mcp"), { recursive: true });
  await writeFile(mcpPath, `${JSON.stringify({ mcpServers: { user: { name: "User", url: "https://user.example/mcp", custom: true } } }, null, 2)}\n`);
  const services = new Map();
  const actions = [];
  const serviceBridge = {
    async exists(id) { return services.has(id); },
    async apply(spec) { services.set(spec.name, spec); actions.push(`apply:${spec.name}`); return spec.name; },
    async activate(id, restart) { actions.push(`${restart ? "restart" : "start"}:${id}`); },
    async remove(id) { services.delete(id); actions.push(`remove:${id}`); },
  };
  const manager = createManager(root, new FakeMarket({ [packageId]: installPlan(repo) }), { serviceBridge });
  await manager.install(packageId);
  let mcp = JSON.parse(await readFile(mcpPath, "utf8"));
  assert.equal(mcp.mcpServers.user.custom, true);
  assert.equal(mcp.mcpServers["owned-mcp"].url, "https://example.com/mcp");
  assert.deepEqual(actions, ["apply:owned-service", "start:owned-service"]);
  assert.equal("schemaVersion" in services.get("owned-service"), false);
  assert.equal("service" in services.get("owned-service"), false);

  await manager.setContributionEnabled(`${packageId}/mcp.owned`, false);
  mcp = JSON.parse(await readFile(mcpPath, "utf8"));
  assert.equal(mcp.mcpServers.user.custom, true);
  assert.equal(mcp.mcpServers["owned-mcp"], undefined);
  await manager.setContributionEnabled(`${packageId}/service.owned`, false);
  assert.equal(actions.at(-1), "remove:owned-service");
});

test("service-manager client unwraps the registry child manifest before sending ServiceSpec", async () => {
  const requests = [];
  const client = new ServiceManagerClient({
    baseUrl: "http://service-manager.test",
    token: "test-token",
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (init?.method === "GET") return Response.json({ error: { code: "not_found" } }, { status: 404 });
      return Response.json({ ok: true }, { status: 201 });
    },
  });
  await client.apply(serviceManifest("wrapped-service", ["sh", "-lc", "sleep 1"]));
  assert.deepEqual(requests.at(-1).body, {
    name: "wrapped-service", provider: "termux-process", command: ["sh", "-lc", "sleep 1"], enabled: true,
  });
  assert.equal("schemaVersion" in requests.at(-1).body, false);
  assert.equal("service" in requests.at(-1).body, false);
});

test("failed service activation restores old specs and restarts services that were running", async () => {
  const root = await mkdtemp(join(tmpdir(), "wuxianpi-package-service-rollback-"));
  const packageId = "io.test.service-rollback";
  const manifest = {
    ...basicManifest(packageId),
    contributions: [{ id: `${packageId}/service.main`, type: "service-manager.service", name: "Service", manifest: "service.json" }],
  };
  const repo = await createRepository(join(root, "upstream"), manifest, {
    "service.json": JSON.stringify(serviceManifest("rollback-service", ["sh", "-lc", "printf v1"])),
  });
  const market = new FakeMarket({ [packageId]: installPlan(repo) });
  const specs = new Map();
  const actions = [];
  let failUpdatedActivation = false;
  const serviceBridge = {
    async exists(id) { return specs.has(id); },
    async isRunning(id) { return id === "rollback-service"; },
    async apply(spec) { specs.set(spec.name, structuredClone(spec)); actions.push(`apply:${spec.command.at(-1)}`); return spec.name; },
    async remove(id) { specs.delete(id); actions.push(`remove:${id}`); },
    async activate(id, restart) {
      actions.push(`${restart ? "restart" : "start"}:${id}:${specs.get(id)?.command?.at(-1)}`);
      if (failUpdatedActivation && specs.get(id)?.command?.at(-1) === "printf v2") {
        failUpdatedActivation = false;
        throw new Error("activation failed");
      }
    },
  };
  const manager = createManager(root, market, { serviceBridge });
  await manager.install(packageId);
  const before = await manager.detail(packageId);
  await writeFile(join(repo.path, "service.json"), JSON.stringify(serviceManifest("rollback-service", ["sh", "-lc", "printf v2"])));
  const v2 = await commitRepository(repo.path, "Service v2");
  market.plans[packageId] = installPlan({ ...repo, ...v2 });
  failUpdatedActivation = true;
  await assert.rejects(() => manager.update(packageId), /activation failed/);
  assert.equal(specs.get("rollback-service").command.at(-1), "printf v1");
  assert.equal(actions.at(-1), "restart:rollback-service:printf v1");
  assert.equal((await manager.detail(packageId)).activeRevisionId, before.activeRevisionId);
});

test("WebExtension discovery ignores unmanaged Package directories and disabled registry entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "wuxianpi-package-web-discovery-"));
  const agentDir = join(root, "agent");
  const unmanaged = join(agentDir, "packages", "unmanaged");
  await mkdir(unmanaged, { recursive: true });
  await writeFile(join(unmanaged, "wuxianpi-extension.json"), JSON.stringify({
    schemaVersion: 1, apiVersion: "1", id: "unmanaged", name: "Unmanaged", version: "1.0.0", entry: "index.html",
  }));
  await writeFile(join(unmanaged, "index.html"), "unmanaged");
  const packageId = "io.test.web-registry";
  const contributionId = `${packageId}/web.main`;
  const manifest = {
    ...basicManifest(packageId),
    contributions: [{ id: contributionId, type: "wuxianpi.webExtension", name: "Managed", manifest: "web/wuxianpi-extension.json", assistantSelectable: true }],
  };
  const repo = await createRepository(join(root, "upstream"), manifest, {
    "web/wuxianpi-extension.json": JSON.stringify({ schemaVersion: 1, apiVersion: "1", id: "managed", name: "Managed", version: "1.0.0", entry: "index.html" }),
    "web/index.html": "managed",
  });
  const manager = createManager(root, new FakeMarket({ [packageId]: installPlan(repo) }));
  await manager.install(packageId);
  const services = new WebServices({ agentDir, packageManager: manager, registry: { list: async () => ({ sessions: [] }) } });
  assert.deepEqual((await services.listWebExtensions()).map((item) => item.id), [contributionId]);
  await manager.setContributionEnabled(contributionId, false);
  assert.deepEqual(await services.listWebExtensions(), []);
});

test("only self-related operations create the maintenance handoff record", async () => {
  const root = await mkdtemp(join(tmpdir(), "wuxianpi-package-self-"));
  const ordinaryId = "io.test.ordinary";
  const selfId = "io.test.self";
  const ordinaryManifest = basicManifest(ordinaryId);
  ordinaryManifest.contributions[0].id = `${ordinaryId}/skill.runtime-helper`;
  const ordinary = await createRepository(join(root, "ordinary"), ordinaryManifest, { "skills/basic/SKILL.md": skill("ordinary") });
  const selfManifest = basicManifest(selfId);
  selfManifest.contributions[0].id = `${selfId}/skill.control`;
  const own = await createRepository(join(root, "self"), selfManifest, { "skills/basic/SKILL.md": skill("self") });
  const market = new FakeMarket({ [ordinaryId]: installPlan(ordinary), [selfId]: installPlan(own) });
  const manager = createManager(root, market, { initialExecutionContext: { contributionIds: [`${selfId}/skill.control`] } });
  await manager.install(ordinaryId);
  await assert.rejects(() => readFile(manager.selfJournal.historyPath, "utf8"), (error) => error.code === "ENOENT");
  await manager.install(selfId);
  const history = (await readFile(manager.selfJournal.historyPath, "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(history.map((item) => item.status), ["pending", "completed"]);
  assert.equal(await manager.selfJournal.pending(), undefined);
  const operations = await manager.operations();
  assert.equal(operations.length, 2);
  assert.equal(operations.find((item) => item.packageId === selfId).details.selfRelated, true);
  assert.equal(operations.find((item) => item.packageId === ordinaryId).details.selfRelated, undefined);
});

class FakeMarket {
  constructor(plans) { this.plans = plans; this.releasePlans = {}; }
  async installPlan(packageId, options = {}) {
    const plan = options.releaseId
      ? (this.releasePlans[packageId] ?? [this.plans[packageId]]).find((item) => item.releaseId === options.releaseId)
      : this.plans[packageId];
    if (!plan) throw new Error(`Missing fake plan for ${packageId}`);
    return structuredClone(plan);
  }
  async installPlanForCommit(packageId, approvedCommit) {
    const plan = (this.releasePlans[packageId] ?? [this.plans[packageId]]).find((item) => item.approvedCommit === approvedCommit);
    if (!plan) throw new Error(`Missing fake commit ${packageId}@${approvedCommit}`);
    return structuredClone(plan);
  }
  async listPackages() { return { packages: [], nextCursor: null }; }
  async packageDetail(packageId) { return { package: { id: packageId } }; }
  async releases(packageId) { return { packageId, releases: [], nextCursor: null }; }
}

function createManager(root, marketClient, overrides = {}) {
  const services = new Map();
  const serviceBridge = overrides.serviceBridge ?? {
    async exists(id) { return services.has(id); },
    async apply(spec) { const id = spec.id ?? spec.name; services.set(id, spec); return id; },
    async remove(id) { services.delete(id); },
  };
  return new WuxianPiPackageManager({
    rootDir: join(root, "manager"),
    agentDir: join(root, "agent"),
    mcpConfigPath: join(root, "mcp", "mcp.json"),
    maintenanceRoot: join(root, "maintenance"),
    marketClient,
    serviceBridge,
    ...overrides,
  });
}

function basicManifest(packageId) {
  return {
    schemaVersion: 1,
    id: packageId,
    name: packageId,
    version: "1.0.0",
    summary: "Package fixture",
    categories: ["skill"],
    requires: { hostCapabilities: [], packages: [] },
    build: { mode: "none" },
    artifacts: [],
    contributions: [{ id: `${packageId}/skill.basic`, type: "pi.skill", name: "Basic", path: "skills/basic", assistantSelectable: true }],
  };
}

function skill(name) {
  return `---\nname: ${name}\ndescription: Test ${name} skill\n---\n\n# ${name}\n`;
}

function serviceManifest(id, command) {
  return {
    schemaVersion: 1,
    id,
    service: { name: id, provider: "termux-process", command, enabled: true },
  };
}

async function createRepository(path, manifest, files) {
  await mkdir(path, { recursive: true });
  exec(path, ["init"]);
  exec(path, ["config", "user.name", "Test"]);
  exec(path, ["config", "user.email", "test@example.com"]);
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(path, name).split("/").slice(0, -1).join("/"), { recursive: true });
    await writeFile(join(path, name), content);
  }
  await writeFile(join(path, "wuxianpi-package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const commit = await commitRepository(path, "Initial");
  return { path, ...commit };
}

async function commitRepository(path, message) {
  exec(path, ["add", "-A"]);
  exec(path, ["commit", "-m", message]);
  const commit = exec(path, ["rev-parse", "HEAD"]);
  const manifestBytes = await readFile(join(path, "wuxianpi-package.json"));
  return { commit, manifestDigest: sha(manifestBytes), manifestBytes };
}

function installPlan(repo, sources = [{ kind: "github", url: repo.path, priority: 100 }]) {
  const manifest = JSON.parse(repo.manifestBytes.toString("utf8"));
  return {
    schemaVersion: 1,
    packageId: manifest.id,
    releaseId: `release-${repo.commit.slice(0, 8)}`,
    version: manifest.version,
    approvedCommit: repo.commit,
    manifestPath: "wuxianpi-package.json",
    manifestDigest: repo.manifestDigest,
    gitSources: sources,
    artifacts: manifest.artifacts,
    compatibility: manifest.requires,
    verification: { status: "passed", checks: ["commit", "manifest-schema"] },
    revoked: false,
  };
}

function repoSource(manager, packageId) { return join(manager.rootDir, "packages", packageId, "source"); }
function sha(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function exec(cwd, args) { return execFileSync("git", args, { cwd, encoding: "utf8" }).trim(); }
