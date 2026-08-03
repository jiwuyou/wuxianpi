import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, test } from "node:test";
import { promisify } from "node:util";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { HubAuthService } from "../src/auth-service.js";
import type { GitHubAuthGateway, GitHubDeviceAuthorization, GitHubIdentity } from "../src/github-auth.js";
import { RealGitGateway, type GitGateway, type CheckoutResult } from "../src/git.js";
import type { GitSource, PackageManifest, SourceHealth } from "../src/types.js";
import { VerifiedAssetStore, type DownloadVerifier } from "../src/metadata.js";
import { HubDatabase } from "../src/database.js";
import { PackageValidator } from "../src/validator.js";
import { HubService } from "../src/service.js";
import { createHubServer } from "../src/server.js";

const COMMIT_A = "1111111111111111111111111111111111111111";
const COMMIT_B = "2222222222222222222222222222222222222222";
const execFileAsync = promisify(execFile);
const cleanupPaths: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  for (const path of cleanupPaths.splice(0)) await rm(path, { recursive: true, force: true });
});

class EmptyDownloader implements DownloadVerifier {
  async fetchBytes(): Promise<{ bytes: Uint8Array; contentType: string | null }> {
    throw new Error("No remote files are expected in this fixture");
  }
}

class FakeGitHubAuthGateway implements GitHubAuthGateway {
  identity: GitHubIdentity = {
    githubId: "1001",
    login: "fixture-user",
    name: "Fixture User",
    avatarUrl: null,
    profileUrl: "https://github.com/fixture-user",
  };

  async getIdentity(): Promise<GitHubIdentity> {
    return this.identity;
  }

  async startDeviceFlow(): Promise<GitHubDeviceAuthorization> {
    return { deviceCode: "fixture-device-code", userCode: "ABCD-EFGH", verificationUri: "https://github.com/login/device", expiresIn: 900, interval: 5 };
  }

  async completeDeviceFlow(): Promise<GitHubIdentity> {
    return this.identity;
  }
}

class MemoryDownloader implements DownloadVerifier {
  readonly objects = new Map<string, { bytes: Uint8Array; contentType: string | null }>();

  async fetchBytes(url: string): Promise<{ bytes: Uint8Array; contentType: string | null }> {
    const object = this.objects.get(url);
    if (!object) throw new Error(`Missing fixture download: ${url}`);
    return object;
  }
}

function deferred() {
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}

class FakeGitGateway implements GitGateway {
  resolvedCommit = COMMIT_A;
  mirrorHealthy = true;
  checkouts: Array<{ sources: GitSource[]; commit: string }> = [];
  private resolveBlock: { started: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> } | null = null;
  private checkoutBlock: { started: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> } | null = null;

  constructor(public directory: string) {}

  blockNextResolve() {
    this.resolveBlock = { started: deferred(), release: deferred() };
    return this.resolveBlock;
  }

  blockNextCheckout() {
    this.checkoutBlock = { started: deferred(), release: deferred() };
    return this.checkoutBlock;
  }

  async resolveRef(): Promise<string> {
    if (this.resolveBlock) {
      const block = this.resolveBlock;
      this.resolveBlock = null;
      block.started.resolve();
      await block.release.promise;
    }
    return this.resolvedCommit;
  }

  async checkoutExact(sources: GitSource[], commit: string): Promise<CheckoutResult> {
    if (this.checkoutBlock) {
      const block = this.checkoutBlock;
      this.checkoutBlock = null;
      block.started.resolve();
      await block.release.promise;
    }
    this.checkouts.push({ sources, commit });
    const sourceHealth: SourceHealth[] = sources.map((source) => ({
      url: source.url,
      kind: source.kind,
      status: source.kind === "mirror" && !this.mirrorHealthy ? "failed" : "healthy",
      checkedAt: new Date().toISOString(),
      commit: source.kind === "mirror" && !this.mirrorHealthy ? null : commit,
      error: source.kind === "mirror" && !this.mirrorHealthy ? "missing commit" : null,
    }));
    if (!this.mirrorHealthy) throw Object.assign(new Error("Declared mirror does not contain the approved commit"), { sourceHealth });
    return { directory: this.directory, sourceHealth, cleanup: async () => undefined };
  }
}

async function createFixture(overrides: Partial<PackageManifest> = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "wuxianpi-hub-fixture-"));
  cleanupPaths.push(root);
  await mkdir(join(root, "skills", "fixture"), { recursive: true });
  await writeFile(join(root, "skills", "fixture", "SKILL.md"), `---\nname: fixture-skill\ndescription: A valid fixture Skill.\n---\n\n# Fixture\n`);
  const manifest: PackageManifest = {
    schemaVersion: 1,
    id: "io.wuxianpi.fixture",
    name: "Fixture Package",
    version: "1.0.0",
    summary: "A Package used by the WuxianPi Hub tests.",
    description: "Static fixture Package.",
    license: "MIT",
    categories: ["skill", "solution"],
    requires: { hostCapabilities: [{ id: "wuxianpi.package", contractVersion: 1 }], packages: [] },
    build: { mode: "none" },
    artifacts: [],
    contributions: [{
      id: "io.wuxianpi.fixture/skill.fixture",
      type: "pi.skill",
      name: "Fixture Skill",
      path: "skills/fixture",
      assistantSelectable: true,
    }],
    ...overrides,
  };
  await writeFile(join(root, "wuxianpi-package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return root;
}

async function createChildManifestFixture(): Promise<string> {
  const root = await createFixture();
  await Promise.all([
    mkdir(join(root, "web"), { recursive: true }),
    mkdir(join(root, "assistants"), { recursive: true }),
    mkdir(join(root, "openhouse"), { recursive: true }),
    mkdir(join(root, "mcp"), { recursive: true }),
  ]);
  await writeFile(join(root, "web", "index.html"), "<!doctype html><title>Fixture</title>");
  await writeFile(join(root, "web", "wuxianpi-extension.json"), JSON.stringify({
    schemaVersion: 1,
    id: "fixture-web",
    name: "Fixture Web",
    version: "1.0.0",
    apiVersion: "1",
    entry: "index.html",
    permissions: ["assistant.read"],
    contributes: { toolRenderers: [{ toolPattern: "fixture.*", entry: "index.html" }] },
  }));
  await writeFile(join(root, "assistants", "fixture.json"), JSON.stringify({
    schemaVersion: 1,
    name: "Fixture Assistant",
    model: "inherit",
    tools: "inherit",
  }));
  await writeFile(join(root, "openhouse", "openhouse.component.json"), JSON.stringify({
    schemaVersion: 1,
    id: "fixture-openhouse",
    title: "Fixture OpenHouse App",
    kind: "app",
    smallphoneApp: { visible: true, entry: { type: "webview", url: "http://127.0.0.1:23110/" } },
  }));
  await writeFile(join(root, "openhouse", "service-manager.service.json"), JSON.stringify({
    schemaVersion: 1,
    id: "fixture-service",
    service: {
      name: "fixture-service",
      description: "Fixture service",
      provider: "process",
      command: ["node", "server.js"],
      working_dir: "",
      env: {},
      runtime: {},
      restart: { mode: "always", max_retries: 0 },
      health: [],
      ports: [],
      enabled: true,
      residentByDefault: false,
      tags: ["fixture"],
    },
  }));
  await writeFile(join(root, "mcp", "fixture.json"), JSON.stringify({
    id: "fixture",
    name: "Fixture MCP",
    transport: "streamable-http",
    url: "https://example.com/mcp",
    auth: false,
  }));
  const manifest = JSON.parse(await readFile(join(root, "wuxianpi-package.json"), "utf8")) as PackageManifest;
  manifest.categories = ["assistant", "capability", "interface", "app"];
  manifest.contributions = [
    { id: `${manifest.id}/mcp.fixture`, type: "mcp.server", name: "Fixture MCP", config: "mcp/fixture.json", assistantSelectable: true },
    { id: `${manifest.id}/web.fixture`, type: "wuxianpi.webExtension", name: "Fixture Web", manifest: "web/wuxianpi-extension.json", assistantSelectable: true },
    { id: `${manifest.id}/renderer.fixture`, type: "wuxianpi.renderer", name: "Fixture Renderer", manifest: "web/wuxianpi-extension.json", contentTypes: ["fixture.result"] },
    { id: `${manifest.id}/assistant.fixture`, type: "wuxianpi.assistantTemplate", name: "Fixture Assistant", manifest: "assistants/fixture.json", kind: "functional", defaultBindings: [] },
    { id: `${manifest.id}/app.fixture`, type: "openhouse.app", name: "Fixture App", manifest: "openhouse/openhouse.component.json" },
    { id: `${manifest.id}/service.fixture`, type: "service-manager.service", name: "Fixture Service", manifest: "openhouse/service-manager.service.json" },
  ];
  await writeFile(join(root, "wuxianpi-package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return root;
}

async function createHarness(options: { dbPath?: string; fixture?: string; downloader?: DownloadVerifier } = {}) {
  const fixture = options.fixture ?? await createFixture();
  const db = new HubDatabase(options.dbPath ?? ":memory:");
  const schema = JSON.parse(await readFile(resolve("contracts/wuxianpi-package.schema.json"), "utf8")) as object;
  const git = new FakeGitGateway(fixture);
  const assetDir = await mkdtemp(join(tmpdir(), "wuxianpi-hub-assets-"));
  cleanupPaths.push(assetDir);
  const assetStore = new VerifiedAssetStore(assetDir);
  const validator = new PackageValidator({
    schema,
    downloader: options.downloader ?? new EmptyDownloader(),
    assetStore,
    maxDownloadBytes: 1024 * 1024,
  });
  const serviceOptions = { database: db, git, validator, publicUrl: "http://hub.test" };
  const service = new HubService(serviceOptions);
  const authService = new HubAuthService({
    database: db,
    github: new FakeGitHubAuthGateway(),
    githubClientId: "fixture-client-id",
    sessionDays: 30,
  });
  const server = createHubServer({
    service,
    authService,
    database: db,
    publicDir: resolve("public"),
    adminToken: "admin-token",
    publisherCredentials: new Map([["pub_test", {
      id: "pub_test",
      token: "publisher-token",
      name: "Test Publisher",
      profileUrl: "https://example.com/publisher",
    }]]),
    assetStore,
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  servers.push(server);
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  serviceOptions.publicUrl = baseUrl;
  return { db, git, service, authService, server, baseUrl, assetStore };
}

async function request(baseUrl: string, path: string, options: RequestInit = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const body = await response.json() as Record<string, any>;
  return { response, body };
}

async function submitAndVerify(
  harness: Awaited<ReturnType<typeof createHarness>>,
  mirrorUrls: string[] = [],
  options: { ref?: string; metadata?: Record<string, unknown> } = {},
) {
  const created = await request(harness.baseUrl, "/api/v1/publisher/submissions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer publisher-token" },
    body: JSON.stringify({
      repositoryUrl: "https://github.com/example/fixture.git",
      ref: options.ref ?? "v1.0.0",
      mirrorUrls,
      metadata: options.metadata ?? { links: [], screenshots: [] },
    }),
  });
  assert.equal(created.response.status, 202);
  const submissionId = created.body.submission.submissionId as string;
  await harness.service.waitForVerification(submissionId);
  return submissionId;
}

async function approve(harness: Awaited<ReturnType<typeof createHarness>>, submissionId: string) {
  return await request(harness.baseUrl, `/api/v1/admin/submissions/${submissionId}/approve`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer admin-token" },
    body: JSON.stringify({ notes: "Static checks passed." }),
  });
}

test("public API publishes immutable exact-commit Releases and supports search", async () => {
  const harness = await createHarness();
  const submissionId = await submitAndVerify(harness, ["https://gitcode.com/example/fixture.git"]);
  const verified = await request(harness.baseUrl, `/api/v1/publisher/submissions/${submissionId}`, {
    headers: { authorization: "Bearer publisher-token" },
  });
  assert.equal(verified.body.submission.status, "awaiting_review");
  assert.equal(verified.body.submission.resolvedCommit, COMMIT_A);
  assert.equal(harness.git.checkouts[0]?.commit, COMMIT_A);
  assert.deepEqual(harness.git.checkouts[0]?.sources.map((source) => source.kind), ["github", "mirror"]);

  const approved = await approve(harness, submissionId);
  assert.equal(approved.response.status, 201);
  assert.equal(approved.body.approvedCommit, COMMIT_A);

  const packages = await request(harness.baseUrl, "/api/v1/packages?q=fixture&category=skill&contributionType=pi.skill");
  assert.equal(packages.response.status, 200);
  assert.equal(packages.body.packages.length, 1);

  const plan = await request(harness.baseUrl, "/api/v1/packages/io.wuxianpi.fixture/install-plan?hostCapability=wuxianpi.package%401");
  assert.equal(plan.response.status, 200);
  assert.equal(plan.body.approvedCommit, COMMIT_A);
  assert.equal(plan.body.gitSources[1].url, "https://gitcode.com/example/fixture.git");

  const mutation = await request(harness.baseUrl, `/api/v1/publisher/submissions/${submissionId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: "Bearer publisher-token" },
    body: JSON.stringify({ ref: "v2.0.0" }),
  });
  assert.equal(mutation.response.status, 409);
  assert.equal(mutation.body.error.code, "immutable_submission");
  harness.db.close();
});

test("Hub Issues provide a complete reporter and maintainer lifecycle", async () => {
  const harness = await createHarness();
  const submissionId = await submitAndVerify(harness);
  assert.equal((await approve(harness, submissionId)).response.status, 201);
  const reporterToken = "wuxianpi-reporter-token-1234567890";

  const created = await request(harness.baseUrl, "/api/v1/issues", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${reporterToken}` },
    body: JSON.stringify({
      packageId: "io.wuxianpi.fixture",
      component: "fixture-runtime",
      reporterName: "测试用户",
      title: "Fixture 无法启动",
      body: "## 复现步骤\n\n1. 启动 Fixture\n2. 观察错误",
      labels: ["bug"],
      environment: { arch: "arm64" },
      visibility: "public",
      source: "assistant",
      userConfirmed: true,
    }),
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.body.issue.status, "pending");
  assert.equal(created.body.issue.targetRepository, "example/fixture");
  assert.equal(created.body.issue.confirmation, "assistant_asserted");
  assert.equal(created.body.issue.reporterTokenHash, undefined);
  const issueNumber = created.body.issue.issueNumber as number;

  const comment = await request(harness.baseUrl, `/api/v1/issues/${issueNumber}/comments`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${reporterToken}` },
    body: JSON.stringify({ body: "补充：每次都可以复现。" }),
  });
  assert.equal(comment.response.status, 201);
  assert.equal(comment.body.comment.actorName, "测试用户");

  const progressed = await request(harness.baseUrl, `/api/v1/issues/${issueNumber}/status`, {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: "Bearer publisher-token" },
    body: JSON.stringify({ status: "awaiting_verification" }),
  });
  assert.equal(progressed.response.status, 200);
  assert.equal(progressed.body.issue.status, "awaiting_verification");

  const verified = await request(harness.baseUrl, `/api/v1/issues/${issueNumber}/verify`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${reporterToken}` },
    body: JSON.stringify({ accepted: true }),
  });
  assert.equal(verified.response.status, 200);
  assert.equal(verified.body.issue.status, "resolved");
  assert.equal(verified.body.comments.length, 1);

  const listed = await request(harness.baseUrl, "/api/v1/issues?packageId=io.wuxianpi.fixture");
  assert.equal(listed.response.status, 200);
  assert.equal(listed.body.issues.length, 1);
  harness.db.close();
});

test("Hub Issues trust the assistant assertion but require it to be present", async () => {
  const harness = await createHarness();
  const denied = await request(harness.baseUrl, "/api/v1/issues", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer wuxianpi-reporter-token-1234567890" },
    body: JSON.stringify({ title: "Missing confirmation", body: "Draft only" }),
  });
  assert.equal(denied.response.status, 400);
  assert.equal(denied.body.error.code, "user_confirmation_required");
  const localPackage = await request(harness.baseUrl, "/api/v1/issues", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer wuxianpi-reporter-token-1234567890" },
    body: JSON.stringify({
      packageId: "io.local.unpublished",
      targetRepository: "example/local-package",
      title: "Local Package failure",
      body: "Reproduction",
      userConfirmed: true,
    }),
  });
  assert.equal(localPackage.response.status, 201);
  assert.equal(localPackage.body.issue.packageId, "io.local.unpublished");
  harness.db.close();
});

test("approval rejects a ref that moved after static verification", async () => {
  const harness = await createHarness();
  const submissionId = await submitAndVerify(harness);
  harness.git.resolvedCommit = COMMIT_B;
  const result = await approve(harness, submissionId);
  assert.equal(result.response.status, 409);
  assert.equal(result.body.error.code, "submission_changed");
  assert.equal(harness.db.getSubmission(submissionId)?.status, "awaiting_review");
  harness.db.close();
});

test("a declared mirror missing the exact commit fails verification", async () => {
  const harness = await createHarness();
  harness.git.mirrorHealthy = false;
  const submissionId = await submitAndVerify(harness, ["https://mirror.example.com/fixture.git"]);
  const submission = harness.db.getSubmission(submissionId);
  assert.equal(submission?.status, "failed");
  assert.match(submission?.diagnostics[0] ?? "", /mirror/i);
  assert.equal(submission?.sourceHealth[1]?.status, "failed");
  harness.db.close();
});

test("invalid Package paths are rejected before review", async () => {
  const fixture = await createFixture({
    contributions: [{
      id: "io.wuxianpi.fixture/skill.invalid",
      type: "pi.skill",
      name: "Invalid Skill",
      path: "missing-skill",
      assistantSelectable: true,
    }],
  });
  const harness = await createHarness({ fixture });
  const submissionId = await submitAndVerify(harness);
  const submission = harness.db.getSubmission(submissionId);
  assert.equal(submission?.status, "failed");
  assert.match(submission?.diagnostics[0] ?? "", /ENOENT|missing/i);
  const result = await approve(harness, submissionId);
  assert.equal(result.response.status, 409);
  harness.db.close();
});

test("all promised child manifest types require their v1 schemas", async (context) => {
  const validFixture = await createChildManifestFixture();
  const validHarness = await createHarness({ fixture: validFixture });
  const validSubmissionId = await submitAndVerify(validHarness);
  const validSubmission = validHarness.db.getSubmission(validSubmissionId);
  assert.equal(validSubmission?.status, "awaiting_review");
  assert.ok(validSubmission?.verification?.checks.includes("child-manifests"));
  validHarness.db.close();

  const cases: Array<{ name: string; path: string; value: unknown; diagnostic: RegExp }> = [
    { name: "Web Extension", path: "web/wuxianpi-extension.json", value: { schemaVersion: 2 }, diagnostic: /Web Extension Schema/ },
    { name: "assistant template", path: "assistants/fixture.json", value: { schemaVersion: 1 }, diagnostic: /Assistant template.*Schema/ },
    { name: "OpenHouse App", path: "openhouse/openhouse.component.json", value: { schemaVersion: 1, id: "bad", title: "Bad", kind: "page" }, diagnostic: /OpenHouse App.*Schema/ },
    { name: "flat service-manager hybrid", path: "openhouse/service-manager.service.json", value: { schemaVersion: 1, id: "bad", name: "bad", provider: "process", command: ["node"] }, diagnostic: /Service.*Schema/ },
    { name: "malformed wrapped service-manager command", path: "openhouse/service-manager.service.json", value: { schemaVersion: 1, id: "bad", service: { name: "bad", provider: "process", command: "node" } }, diagnostic: /Service.*Schema/ },
    { name: "unknown wrapped service-manager field", path: "openhouse/service-manager.service.json", value: { schemaVersion: 1, id: "bad", service: { name: "bad", provider: "process", command: ["node"], unknown: true } }, diagnostic: /Service.*Schema/ },
  ];
  for (const item of cases) {
    await context.test(`rejects invalid ${item.name}`, async () => {
      const fixture = await createChildManifestFixture();
      await writeFile(join(fixture, item.path), JSON.stringify(item.value));
      const harness = await createHarness({ fixture });
      const submissionId = await submitAndVerify(harness);
      const submission = harness.db.getSubmission(submissionId);
      assert.equal(submission?.status, "failed");
      assert.match(submission?.diagnostics[0] ?? "", item.diagnostic);
      assert.ok(!submission?.verification?.checks.includes("child-manifests"));
      harness.db.close();
    });
  }
});

test("service-manager wrapper id must equal service.name", async (context) => {
  await context.test("accepts the canonical matching wrapper", async () => {
    const fixture = await createChildManifestFixture();
    const harness = await createHarness({ fixture });
    const submissionId = await submitAndVerify(harness);
    assert.equal(harness.db.getSubmission(submissionId)?.status, "awaiting_review");
    harness.db.close();
  });

  await context.test("rejects the exact cross-module id mismatch", async () => {
    const fixture = await createChildManifestFixture();
    await writeFile(join(fixture, "openhouse", "service-manager.service.json"), JSON.stringify({
      schemaVersion: 1,
      id: "fixture-service",
      service: {
        name: "different-service",
        provider: "process",
        command: ["node", "server.js"],
      },
    }));
    const harness = await createHarness({ fixture });
    const submissionId = await submitAndVerify(harness);
    const submission = harness.db.getSubmission(submissionId);
    assert.equal(submission?.status, "failed");
    assert.match(submission?.diagnostics[0] ?? "", /wrapper id fixture-service must equal service\.name different-service/);
    assert.ok(!submission?.verification?.checks.includes("child-manifests"));
    harness.db.close();
  });
});

test("install plan falls back to the newest compatible approved Release", async () => {
  const fixtureA = await createFixture({
    version: "1.0.0",
    requires: { hostCapabilities: [{ id: "host.alpha", contractVersion: 1 }], packages: [] },
  });
  const harness = await createHarness({ fixture: fixtureA });
  const submissionA = await submitAndVerify(harness, [], { ref: "v1.0.0" });
  assert.equal((await approve(harness, submissionA)).response.status, 201);

  await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
  const fixtureB = await createFixture({
    version: "2.0.0",
    requires: { hostCapabilities: [{ id: "host.beta", contractVersion: 1 }], packages: [] },
  });
  harness.git.directory = fixtureB;
  harness.git.resolvedCommit = COMMIT_B;
  const submissionB = await submitAndVerify(harness, [], { ref: "v2.0.0" });
  assert.equal((await approve(harness, submissionB)).response.status, 201);

  const plan = await request(harness.baseUrl, "/api/v1/packages/io.wuxianpi.fixture/install-plan?hostCapability=host.alpha%401");
  assert.equal(plan.response.status, 200);
  assert.equal(plan.body.version, "1.0.0");
  assert.equal(plan.body.approvedCommit, COMMIT_A);
  const incompatible = await request(harness.baseUrl, "/api/v1/packages/io.wuxianpi.fixture/install-plan?hostCapability=host.missing%401");
  assert.equal(incompatible.response.status, 409);
  assert.equal(incompatible.body.error.code, "incompatible_host");
  harness.db.close();
});

test("approval cannot publish stale metadata while a publisher update wins", async () => {
  const harness = await createHarness();
  const submissionId = await submitAndVerify(harness);
  const barrier = harness.git.blockNextResolve();
  const approvalPromise = approve(harness, submissionId);
  await barrier.started.promise;

  const updated = await request(harness.baseUrl, `/api/v1/publisher/submissions/${submissionId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: "Bearer publisher-token" },
    body: JSON.stringify({
      metadata: {
        links: [{ id: "support", kind: "support", label: "Updated support", url: "https://example.com/updated", source: "publisher" }],
        screenshots: [],
      },
    }),
  });
  assert.equal(updated.response.status, 200);
  assert.equal(updated.body.submission.revision, 2);
  barrier.release.resolve();
  const approval = await approvalPromise;
  assert.equal(approval.response.status, 409);
  assert.equal(approval.body.error.code, "submission_changed");
  await harness.service.waitForVerification(submissionId);
  assert.equal(harness.db.countReleases("io.wuxianpi.fixture"), 0);
  assert.equal(harness.db.getSubmission(submissionId)?.metadata.links[0]?.label, "Updated support");
  harness.db.close();
});

test("in-flight verification cannot overwrite an administrator rejection", async () => {
  const harness = await createHarness();
  const barrier = harness.git.blockNextCheckout();
  const created = await request(harness.baseUrl, "/api/v1/publisher/submissions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer publisher-token" },
    body: JSON.stringify({
      repositoryUrl: "https://github.com/example/fixture.git",
      ref: "v1.0.0",
      mirrorUrls: [],
      metadata: { links: [], screenshots: [] },
    }),
  });
  const submissionId = created.body.submission.submissionId as string;
  await barrier.started.promise;
  const rejected = await request(harness.baseUrl, `/api/v1/admin/submissions/${submissionId}/reject`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer admin-token" },
    body: JSON.stringify({ reason: "Manual review rejected this submission." }),
  });
  assert.equal(rejected.response.status, 200);
  barrier.release.resolve();
  await harness.service.waitForVerification(submissionId);
  const final = harness.db.getSubmission(submissionId);
  assert.equal(final?.status, "rejected");
  assert.equal(final?.diagnostics[0], "Manual review rejected this submission.");
  assert.equal(final?.verification, null);
  harness.db.close();
});

test("public screenshots are served only from the verified SHA-256 cache", async () => {
  const downloader = new MemoryDownloader();
  const publisherUrl = "https://publisher.example.com/mutable.png";
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  const digest = createHash("sha256").update(png).digest("hex");
  downloader.objects.set(publisherUrl, { bytes: png, contentType: "image/png" });
  const harness = await createHarness({ downloader });
  const submissionId = await submitAndVerify(harness, [], {
    metadata: {
      links: [],
      screenshots: [{
        id: "fixture",
        alt: "Fixture screenshot",
        mediaType: "image/png",
        width: 1,
        height: 1,
        sha256: digest,
        source: "publisher",
        downloadSources: [{ kind: "github", url: publisherUrl, priority: 100 }],
      }],
    },
  });
  assert.equal((await approve(harness, submissionId)).response.status, 201);
  downloader.objects.set(publisherUrl, { bytes: Buffer.from("mutated"), contentType: "image/png" });

  const detail = await request(harness.baseUrl, "/api/v1/packages/io.wuxianpi.fixture");
  const publicUrl = detail.body.package.screenshots[0].downloadSources[0].url as string;
  assert.equal(publicUrl, `${harness.baseUrl}/api/v1/assets/${digest}`);
  assert.ok(!JSON.stringify(detail.body).includes(publisherUrl));
  const assetResponse = await fetch(publicUrl);
  const cached = Buffer.from(await assetResponse.arrayBuffer());
  assert.equal(assetResponse.status, 200);
  assert.equal(createHash("sha256").update(cached).digest("hex"), digest);
  assert.equal(assetResponse.headers.get("cache-control"), "public, max-age=31536000, immutable");
  harness.db.close();
});

test("approved catalog and immutable Release survive SQLite reopen", async () => {
  const root = await mkdtemp(join(tmpdir(), "wuxianpi-hub-persistence-"));
  cleanupPaths.push(root);
  const dbPath = join(root, "hub.sqlite");
  const harness = await createHarness({ dbPath });
  const submissionId = await submitAndVerify(harness);
  const approved = await approve(harness, submissionId);
  assert.equal(approved.response.status, 201);
  harness.db.close();
  await new Promise<void>((resolveClose) => harness.server.close(() => resolveClose()));
  servers.splice(servers.indexOf(harness.server), 1);

  const reopened = new HubDatabase(dbPath);
  const packages = reopened.listPackages({ q: null, category: null, contributionType: null, offset: 0, limit: 10 });
  assert.equal(packages[0]?.id, "io.wuxianpi.fixture");
  const release = reopened.getLatestRelease("io.wuxianpi.fixture");
  assert.equal(release?.approvedCommit, COMMIT_A);
  assert.equal(release?.releaseId, approved.body.releaseId);
  reopened.close();
});

test("revocation preserves Release history and blocks new install plans", async () => {
  const harness = await createHarness();
  const submissionId = await submitAndVerify(harness);
  const approved = await approve(harness, submissionId);
  const releaseId = approved.body.releaseId as string;
  const revoked = await request(harness.baseUrl, `/api/v1/admin/releases/${releaseId}/revoke`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer admin-token" },
    body: JSON.stringify({ reason: "Artifact was withdrawn." }),
  });
  assert.equal(revoked.response.status, 200);
  const releases = await request(harness.baseUrl, "/api/v1/packages/io.wuxianpi.fixture/releases");
  assert.equal(releases.body.releases[0].status, "revoked");
  assert.equal(releases.body.releases[0].revocation.reason, "Artifact was withdrawn.");
  const plan = await request(harness.baseUrl, `/api/v1/packages/io.wuxianpi.fixture/install-plan?releaseId=${releaseId}`);
  assert.equal(plan.response.status, 410);
  assert.equal(plan.body.error.code, "release_revoked");
  const detail = await request(harness.baseUrl, "/api/v1/packages/io.wuxianpi.fixture");
  assert.equal(detail.response.status, 200);
  assert.equal(detail.body.package.latestRelease, null);
  assert.equal(detail.body.package.review.status, "revoked");
  harness.db.close();
});

test("real Git gateway resolves and checks out the same object from true mirrors", async () => {
  const root = await mkdtemp(join(tmpdir(), "wuxianpi-hub-real-git-"));
  cleanupPaths.push(root);
  const source = join(root, "source");
  const mirror = join(root, "mirror.git");
  await mkdir(source);
  await execFileAsync("git", ["init", "--quiet", "--initial-branch=main"], { cwd: source });
  await execFileAsync("git", ["config", "user.name", "Hub Test"], { cwd: source });
  await execFileAsync("git", ["config", "user.email", "hub@example.com"], { cwd: source });
  await writeFile(join(source, "marker.txt"), "exact commit\n");
  await execFileAsync("git", ["add", "marker.txt"], { cwd: source });
  await execFileAsync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: source });
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: source });
  const commit = stdout.trim();
  await execFileAsync("git", ["clone", "--quiet", "--mirror", source, mirror]);

  const gateway = new RealGitGateway();
  assert.equal(await gateway.resolveRef(source, "main"), commit);
  const checkout = await gateway.checkoutExact([
    { kind: "github", url: source, priority: 100 },
    { kind: "mirror", url: mirror, priority: 80 },
  ], commit);
  try {
    assert.equal(await readFile(join(checkout.directory, "marker.txt"), "utf8"), "exact commit\n");
    assert.deepEqual(checkout.sourceHealth.map((item) => item.status), ["healthy", "healthy"]);
  } finally {
    await checkout.cleanup();
  }
});

test("Hub image ships the canonical frozen Package Schema", async () => {
  const [vendored, canonical] = await Promise.all([
    readFile(resolve("contracts/wuxianpi-package.schema.json"), "utf8"),
    readFile(resolve("../../packages/contracts/wuxianpi-package.schema.json"), "utf8"),
  ]);
  assert.equal(vendored, canonical);
});
