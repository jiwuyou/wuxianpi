import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HubIssueClient } from "../extension/hub-issue.js";
import { IssueStore } from "../extension/issue-store.js";
import { normalizeRepository, resolveSupportTarget } from "../extension/support-target.js";

test("persists one reporter identity, drafts, and submitted references", async () => {
  const root = await mkdtemp(join(tmpdir(), "wuxianpi-issue-store-"));
  try {
    const path = join(root, "issues.json");
    const store = new IssueStore(path);
    const firstToken = await store.reporterToken();
    assert.equal(await store.reporterToken(), firstToken);
    const draft = await store.createDraft({ title: "测试问题", status: "prepared" });
    const reference = await store.recordSubmission(draft.draftId, { channel: "github", url: "https://github.com/owner/repo/issues/1" });
    assert.equal((await store.draft(draft.draftId)).referenceId, reference.referenceId);
    assert.equal((await store.reference(reference.referenceId)).channel, "github");
    assert.equal((await readFile(path, "utf8")).includes(firstToken), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolves explicit, core, Package, and Git origin support targets", async () => {
  assert.equal(normalizeRepository("git@github.com:jiwuyou/wuxianpi.git"), "jiwuyou/wuxianpi");
  assert.deepEqual(await resolveSupportTarget({ component: "service-manager" }), {
    repository: "jiwuyou/service-manager", source: "core_component",
  });
  const packageTarget = await resolveSupportTarget({ packageId: "io.example.package" }, {
    fetch: async () => new Response(JSON.stringify({ package: { links: [{ kind: "source", url: "https://github.com/example/package" }] } }), {
      status: 200, headers: { "content-type": "application/json" },
    }),
  });
  assert.deepEqual(packageTarget, { repository: "example/package", source: "hub_package" });
  const packageBeforeCore = await resolveSupportTarget({ packageId: "io.example.package", component: "runtime" }, {
    fetch: async () => new Response(JSON.stringify({ package: { links: [{ kind: "source", url: "https://github.com/example/package" }] } }), {
      status: 200, headers: { "content-type": "application/json" },
    }),
  });
  assert.deepEqual(packageBeforeCore, { repository: "example/package", source: "hub_package" });
  const gitTarget = await resolveSupportTarget({ cwd: "/tmp/project" }, {
    runGit: async () => ({ stdout: "https://github.com/example/current.git\n" }),
  });
  assert.deepEqual(gitTarget, { repository: "example/current", source: "git_origin" });
});

test("Hub client authenticates with the local reporter token and asserts user confirmation", async () => {
  const calls = [];
  const client = new HubIssueClient({
    baseUrl: "https://hub.example",
    fetch: async (url, options) => {
      calls.push({ url, options, body: options.body ? JSON.parse(options.body) : null });
      return new Response(JSON.stringify({ issue: { issueNumber: 7, url: "https://hub.example/issues/7" } }), {
        status: 201, headers: { "content-type": "application/json" },
      });
    },
  });
  const result = await client.create({
    packageId: "io.example.package",
    repository: "example/package",
    title: "问题",
    body: "复现步骤",
    labels: ["bug"],
    environment: { arch: "arm64" },
    visibility: "public",
  }, "reporter-token-abcdefghijklmnopqrstuvwxyz");
  assert.equal(result.issue.issueNumber, 7);
  assert.equal(calls[0].options.headers.authorization, "Bearer reporter-token-abcdefghijklmnopqrstuvwxyz");
  assert.equal(calls[0].body.userConfirmed, true);
  assert.equal(calls[0].body.targetRepository, "example/package");
});
