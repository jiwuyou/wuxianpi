import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, test } from "node:test";
import { HubAuthService } from "../src/auth-service.js";
import type { GitHubAuthGateway, GitHubDeviceAuthorization, GitHubIdentity } from "../src/github-auth.js";
import { HubDatabase } from "../src/database.js";
import type { CheckoutResult, GitGateway } from "../src/git.js";
import { VerifiedAssetStore, type DownloadVerifier } from "../src/metadata.js";
import type {
  CreateMirrorTargetInput,
  HubMirrorClient,
  MirrorJob,
  MirrorTarget,
  UpdateMirrorTargetInput,
} from "../src/mirror-client.js";
import { createHubServer } from "../src/server.js";
import { HubService } from "../src/service.js";
import type { GitSource, PackageManifest, SourceHealth } from "../src/types.js";
import { PackageValidator } from "../src/validator.js";

const COMMIT = "1111111111111111111111111111111111111111";
const servers: Server[] = [];
const cleanupPaths: string[] = [];

class EmptyDownloader implements DownloadVerifier {
  async fetchBytes(): Promise<{ bytes: Uint8Array; contentType: string | null }> {
    throw new Error("No remote files are expected in this fixture");
  }
}

class FakeGit implements GitGateway {
  constructor(private readonly directory: string) {}

  async resolveRef(): Promise<string> {
    return COMMIT;
  }

  async checkoutExact(sources: GitSource[], commit: string): Promise<CheckoutResult> {
    const sourceHealth: SourceHealth[] = sources.map((source) => ({
      url: source.url,
      kind: source.kind,
      status: "healthy",
      checkedAt: new Date().toISOString(),
      commit,
      error: null,
    }));
    return { directory: this.directory, sourceHealth, cleanup: async () => undefined };
  }
}

class FakeGitHub implements GitHubAuthGateway {
  readonly identity: GitHubIdentity = {
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
    return {
      deviceCode: "fixture-device-code",
      userCode: "ABCD-EFGH",
      verificationUri: "https://github.com/login/device",
      expiresIn: 900,
      interval: 5,
    };
  }

  async completeDeviceFlow(): Promise<GitHubIdentity> {
    return this.identity;
  }
}

class FakeMirror implements HubMirrorClient {
  readonly targets: MirrorTarget[] = [];
  readonly jobs: MirrorJob[] = [];

  async registerRelease(): Promise<void> {}
  async findSource(): Promise<null> { return null; }
  async listTargets(): Promise<MirrorTarget[]> { return this.targets; }
  async createTarget(input: CreateMirrorTargetInput): Promise<MirrorTarget> {
    const timestamp = new Date().toISOString();
    const target: MirrorTarget = {
      id: `mirror_${this.targets.length + 1}`,
      repositoryUrl: input.repositoryUrl,
      mode: "tracking",
      branch: input.branch,
      approvedCommit: null,
      mirrorUrl: `https://git.example.com/openhouse/mirror-${this.targets.length + 1}.git`,
      maxSizeBytes: input.maxSizeBytes,
      intervalSeconds: input.intervalSeconds,
      status: "active",
      currentSizeBytes: null,
      lastSyncedCommit: null,
      lastError: null,
      nextSyncAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.targets.push(target);
    return target;
  }
  async updateTarget(targetId: string, input: UpdateMirrorTargetInput): Promise<MirrorTarget> {
    const target = this.requireTarget(targetId);
    Object.assign(target, input, { updatedAt: new Date().toISOString() });
    return target;
  }
  async listJobs(targetId: string): Promise<MirrorJob[]> { return this.jobs.filter((job) => job.targetId === targetId); }
  async sync(targetId: string): Promise<MirrorJob> {
    const existing = this.jobs.find((job) => job.targetId === targetId && ["pending", "running"].includes(job.status));
    if (existing) return existing;
    const timestamp = new Date().toISOString();
    const job: MirrorJob = {
      id: `job_${this.jobs.length + 1}`, targetId, releaseId: null, packageId: null,
      requestedCommit: null, status: "pending", attempts: 0, availableAt: timestamp,
      leaseUntil: null, lastError: null, createdAt: timestamp, updatedAt: timestamp,
    };
    this.jobs.push(job);
    return job;
  }
  async pause(targetId: string): Promise<MirrorTarget> { return Object.assign(this.requireTarget(targetId), { status: "paused" as const }); }
  async resume(targetId: string): Promise<MirrorTarget> { return Object.assign(this.requireTarget(targetId), { status: "ready" as const }); }

  private requireTarget(targetId: string): MirrorTarget {
    const target = this.targets.find((item) => item.id === targetId);
    if (!target) throw new Error("target_not_found");
    return target;
  }
}

async function createFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "wuxianpi-management-fixture-"));
  cleanupPaths.push(root);
  await mkdir(join(root, "skills", "fixture"), { recursive: true });
  await writeFile(join(root, "skills", "fixture", "SKILL.md"), "---\nname: fixture-skill\ndescription: Fixture Skill\n---\n\n# Fixture\n");
  const manifest: PackageManifest = {
    schemaVersion: 1,
    id: "io.wuxianpi.fixture",
    name: "Fixture Package",
    version: "1.0.0",
    summary: "Fixture Package for management API tests.",
    categories: ["skill"],
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
  };
  await writeFile(join(root, "wuxianpi-package.json"), `${JSON.stringify(manifest)}\n`);
  return root;
}

async function createHarness(mirror?: HubMirrorClient) {
  const fixture = await createFixture();
  const db = new HubDatabase(":memory:");
  const schema = JSON.parse(await readFile(resolve("contracts/wuxianpi-package.schema.json"), "utf8")) as object;
  const assetDir = await mkdtemp(join(tmpdir(), "wuxianpi-management-assets-"));
  cleanupPaths.push(assetDir);
  const assetStore = new VerifiedAssetStore(assetDir);
  const validator = new PackageValidator({ schema, downloader: new EmptyDownloader(), assetStore, maxDownloadBytes: 1024 * 1024 });
  const service = new HubService({ database: db, git: new FakeGit(fixture), validator, publicUrl: "http://hub.test", ...(mirror ? { mirror } : {}) });
  const authService = new HubAuthService({ database: db, github: new FakeGitHub(), githubClientId: "fixture-client-id", sessionDays: 30 });
  const server = createHubServer({
    service,
    authService,
    database: db,
    publicDir: resolve("public"),
    adminToken: "admin-token",
    publisherCredentials: new Map(),
    assetStore,
  });
  await new Promise<void>((listen) => server.listen(0, "127.0.0.1", listen));
  servers.push(server);
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return { db, service, authService, baseUrl };
}

async function request(baseUrl: string, path: string, init: RequestInit = {}) {
  const response = await fetch(`${baseUrl}${path}`, init);
  const body = await response.json() as Record<string, any>;
  return { response, body };
}

function json(token: string | undefined, value: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(value),
  };
}

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((close) => server.close(() => close()));
  for (const path of cleanupPaths.splice(0)) await rm(path, { recursive: true, force: true });
});

test("Hub account routes issue sessions and protect publisher operations", async () => {
  const harness = await createHarness();
  const exchanged = await request(harness.baseUrl, "/api/v1/auth/github/token-exchange", json(undefined, {
    githubToken: "gho_fixture",
    kind: "browser",
    label: "management test",
  }));
  assert.equal(exchanged.response.status, 200);
  assert.match(exchanged.body.token, /^wph_[A-Za-z0-9_-]{43}$/);
  assert.equal(exchanged.body.user.githubId, "1001");

  const me = await request(harness.baseUrl, "/api/v1/me", { headers: { authorization: `Bearer ${exchanged.body.token}` } });
  assert.equal(me.response.status, 200);
  assert.equal(me.body.session.sessionId, exchanged.body.session.sessionId);

  const missing = await request(harness.baseUrl, "/api/v1/publisher/submissions");
  assert.equal(missing.response.status, 401);
  const listed = await request(harness.baseUrl, "/api/v1/publisher/submissions", { headers: { authorization: `Bearer ${exchanged.body.token}` } });
  assert.equal(listed.response.status, 200);
  assert.deepEqual(listed.body.submissions, []);

  const anonymousCatalog = await request(harness.baseUrl, "/api/v1/packages");
  assert.equal(anonymousCatalog.response.status, 200);
  harness.db.close();
});

test("only Hub administrators can manage Git mirrors through the server-side adapter", async () => {
  const mirror = new FakeMirror();
  const harness = await createHarness(mirror);
  const exchanged = await request(harness.baseUrl, "/api/v1/auth/github/token-exchange", json(undefined, { githubToken: "gho_fixture" }));
  const token = exchanged.body.token as string;

  const denied = await request(harness.baseUrl, "/api/v1/admin/mirrors/targets", { headers: { authorization: `Bearer ${token}` } });
  assert.equal(denied.response.status, 403);
  assert.equal(denied.body.error.code, "admin_required");

  harness.authService.updateUserRole(
    { kind: "admin", id: "admin", name: "Test Admin" },
    exchanged.body.user.userId,
    "admin",
  );
  const created = await request(harness.baseUrl, "/api/v1/admin/mirrors/targets", json(token, {
    repositoryUrl: "https://github.com/example/public-repository",
    branch: "main",
    intervalSeconds: 3600,
    maxSizeBytes: 30 * 1024 * 1024,
  }));
  assert.equal(created.response.status, 202);
  assert.equal(created.body.target.repositoryUrl, "https://github.com/example/public-repository.git");
  assert.doesNotMatch(JSON.stringify(created.body), /token/i);
  const targetId = created.body.target.id as string;

  const updated = await request(harness.baseUrl, `/api/v1/admin/mirrors/targets/${targetId}`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ branch: "stable", intervalSeconds: 7200 }),
  });
  assert.equal(updated.response.status, 200);
  assert.equal(updated.body.target.branch, "stable");

  const firstSync = await request(harness.baseUrl, `/api/v1/admin/mirrors/targets/${targetId}/sync`, json(token, {}));
  const secondSync = await request(harness.baseUrl, `/api/v1/admin/mirrors/targets/${targetId}/sync`, json(token, {}));
  assert.equal(firstSync.response.status, 202);
  assert.equal(secondSync.body.job.id, firstSync.body.job.id);

  const paused = await request(harness.baseUrl, `/api/v1/admin/mirrors/targets/${targetId}/pause`, json(token, {}));
  assert.equal(paused.body.target.status, "paused");
  const resumed = await request(harness.baseUrl, `/api/v1/admin/mirrors/targets/${targetId}/resume`, json(token, {}));
  assert.equal(resumed.body.target.status, "ready");
  const jobs = await request(harness.baseUrl, `/api/v1/admin/mirrors/targets/${targetId}/jobs`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(jobs.body.jobs.length, 1);

  const actions = (harness.db.sqlite.prepare("SELECT action FROM audit_events WHERE target_type = 'mirror_target' ORDER BY rowid")
    .all() as unknown as Array<{ action: string }>).map((item) => item.action);
  assert.deepEqual(actions, [
    "mirror_target.create", "mirror_target.update", "mirror_target.sync", "mirror_target.sync",
    "mirror_target.pause", "mirror_target.resume",
  ]);
  harness.db.close();
});

test("mirror administration fails closed without affecting the rest of Hub", async () => {
  const harness = await createHarness();
  const unavailable = await request(harness.baseUrl, "/api/v1/admin/mirrors/targets", {
    headers: { authorization: "Bearer admin-token" },
  });
  assert.equal(unavailable.response.status, 503);
  assert.equal(unavailable.body.error.code, "mirror_service_unavailable");
  const packages = await request(harness.baseUrl, "/api/v1/packages");
  assert.equal(packages.response.status, 200);
  harness.db.close();
});

test("protected submission and reviewer routes enforce the submitted revision", async () => {
  const harness = await createHarness();
  const exchanged = await request(harness.baseUrl, "/api/v1/auth/github/token-exchange", json(undefined, { githubToken: "gho_fixture" }));
  const token = exchanged.body.token as string;
  const created = await request(harness.baseUrl, "/api/v1/publisher/submissions", json(token, {
    repositoryUrl: "https://github.com/example/fixture.git",
    ref: "main",
    mirrorUrls: [],
    metadata: { links: [], screenshots: [] },
  }));
  assert.equal(created.response.status, 202);
  const submissionId = created.body.submission.submissionId as string;
  await harness.service.waitForVerification(submissionId);

  const roleActor = { kind: "admin" as const, id: "admin", name: "Test Admin" };
  harness.authService.updateUserRole(roleActor, exchanged.body.user.userId, "reviewer");
  const queue = await request(harness.baseUrl, "/api/v1/reviewer/submissions", { headers: { authorization: `Bearer ${token}` } });
  assert.equal(queue.response.status, 200);
  assert.equal(queue.body.submissions[0].revision, 1);

  const reviewed = await request(harness.baseUrl, `/api/v1/reviewer/submissions/${submissionId}/review`, json(token, {
    expectedRevision: 1,
    decision: "changes_requested",
    reasonCodes: ["documentation"],
    message: "请补充 Package 说明。",
    proposedPatch: { summary: "更新说明" },
  }));
  assert.equal(reviewed.response.status, 200);
  assert.equal(reviewed.body.decision, "changes_requested");

  const stale = await request(harness.baseUrl, `/api/v1/submissions/${submissionId}/reviews`, json(token, {
    expectedRevision: 2,
    decision: "changes_requested",
    message: "这次修订应当失败。",
  }));
  assert.equal(stale.response.status, 409);
  assert.equal(stale.body.error.code, "submission_revision_stale");
  harness.db.close();
});

test("proposal revision routes coexist with anonymous immutable installation", async () => {
  const harness = await createHarness();
  const exchanged = await request(harness.baseUrl, "/api/v1/auth/github/token-exchange", json(undefined, { githubToken: "gho_fixture" }));
  const token = exchanged.body.token as string;
  const created = await request(harness.baseUrl, "/api/v1/publisher/submissions", json(token, {
    repositoryUrl: "https://github.com/example/fixture.git",
    ref: "main",
    mirrorUrls: [],
    metadata: { links: [], screenshots: [] },
  }));
  const submissionId = created.body.submission.submissionId as string;
  await harness.service.waitForVerification(submissionId);
  const approved = await request(harness.baseUrl, `/api/v1/admin/submissions/${submissionId}/approve`, json("admin-token", { notes: "fixture approved" }));
  assert.equal(approved.response.status, 201);

  const plan = await request(harness.baseUrl, "/api/v1/packages/io.wuxianpi.fixture/install-plan?hostCapability=wuxianpi.package%401");
  assert.equal(plan.response.status, 200);
  assert.equal(plan.body.approvedCommit, COMMIT);

  const proposalCreated = await request(harness.baseUrl, "/api/v1/packages/io.wuxianpi.fixture/proposals", json(token, {
    title: "Fixture contribution",
    summary: "Improve the fixture contribution.",
    repositoryUrl: "https://github.com/example/fixture-contribution.git",
    ref: "main",
    mirrorUrls: [],
  }));
  assert.equal(proposalCreated.response.status, 202);
  const proposalId = proposalCreated.body.proposal.proposalId as string;
  await harness.service.waitForVerification(proposalCreated.body.proposal.submissionId as string);
  const own = await request(harness.baseUrl, "/api/v1/me/proposals", { headers: { authorization: `Bearer ${token}` } });
  assert.equal(own.response.status, 200);
  assert.equal(own.body.proposals[0].proposalId, proposalId);

  const updated = await request(harness.baseUrl, `/api/v1/proposals/${proposalId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ title: "Updated fixture contribution" }),
  });
  assert.equal(updated.response.status, 200);
  assert.equal(updated.body.proposal.title, "Updated fixture contribution");
  assert.equal(updated.body.proposal.submission.revision, 2);
  await harness.service.waitForVerification(updated.body.proposal.submission.submissionId as string);
  harness.db.close();
});
