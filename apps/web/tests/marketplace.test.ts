import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildPublisherSubmissionInput,
  isAssistantBindableContribution,
  MARKET_CATEGORIES,
  MARKET_CATEGORY_LABELS,
  mergeLocalPackage,
  pruneExperienceSpaces,
  removeContributionBinding,
  runMutationWithRefresh,
  type HubInstallPlan,
} from "@/lib/package-market";
import { normalizeLocalPackage, normalizeMarketAuth, WebApiClient } from "@/lib/web-api-client";

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { "content-type": "application/json" },
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("WuxianPi Marketplace", () => {
  it("keeps the seven frozen market categories and product labels", () => {
    expect(MARKET_CATEGORIES).toEqual([
      "app",
      "assistant",
      "capability",
      "skill",
      "interface",
      "knowledge-experience",
      "solution",
    ]);
    expect(MARKET_CATEGORIES.map((category) => MARKET_CATEGORY_LABELS[category])).toEqual([
      "应用",
      "助手",
      "能力",
      "Skill",
      "界面",
      "知识与经验",
      "解决方案",
    ]);
  });

  it("uses Runtime-owned discovery and local package endpoints", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ ok: true, data: { packages: [], nextCursor: null } }))
      .mockResolvedValueOnce(json({ ok: true, data: { package: { id: "io.example", name: "Example" } } }))
      .mockResolvedValueOnce(json({ ok: true, data: { packageId: "io.example", releases: [] } }))
      .mockResolvedValueOnce(json({ ok: true, data: { schemaVersion: 1, packageId: "io.example", releaseId: "rel_1" } }))
      .mockResolvedValueOnce(json({ error: { code: "package_not_found", message: "not installed" } }, 404))
      .mockResolvedValueOnce(json({ ok: true, data: { packages: [] } }))
      .mockResolvedValueOnce(json({ ok: true, data: { packages: [] } }))
      .mockResolvedValueOnce(json({ ok: true, data: { updates: [] } }))
      .mockResolvedValueOnce(json({ ok: true, data: { operations: [] } }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new WebApiClient();

    await client.marketPackages({ q: "cloud flare", category: "capability", limit: 50 });
    await client.marketPackage("io.example", "rel_1");
    await client.installedPackages();
    await client.packageUpdates();
    await client.packageOperations({ packageId: "io.example", limit: 25 });

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/web/v1/market/packages?q=cloud+flare&category=capability&limit=50",
      "/api/web/v1/market/packages/io.example",
      "/api/web/v1/market/packages/io.example/releases",
      "/api/web/v1/market/packages/io.example/install-plan?releaseId=rel_1",
      "/api/web/v1/packages/io.example",
      "/api/web/v1/packages",
      "/api/web/v1/packages",
      "/api/web/v1/packages/updates",
      "/api/web/v1/packages/operations?packageId=io.example&limit=25",
    ]);
  });

  it("retains successful local detail and git status when Hub detail is offline", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ error: { code: "hub_unavailable", message: "offline" } }, 503))
      .mockResolvedValueOnce(json({ error: { code: "hub_unavailable", message: "offline" } }, 503))
      .mockResolvedValueOnce(json({ error: { code: "hub_unavailable", message: "offline" } }, 503))
      .mockResolvedValueOnce(json({ ok: true, data: { package: {
        packageId: "io.example",
        name: "Example",
        version: "1.0.0",
        baseCommit: "abc",
        localHead: "abc",
        contributions: [],
        git: { status: [" M README.md"] },
      } } }));
    vi.stubGlobal("fetch", fetchMock);

    const detail = await new WebApiClient().marketPackage("io.example");

    expect(detail.hubOffline).toBe(true);
    expect(detail.hubError).toContain("offline");
    expect(detail.installed).toMatchObject({ packageId: "io.example", hasLocalChanges: true });
  });

  it("submits package mutations as intent without implementing package logic in the browser", async () => {
    const operation = { operationId: "op_1", packageId: "io.example", packageName: "Example", type: "install", status: "queued", summary: "queued", selfRelated: false, events: [{ at: "2026-07-31T00:00:00Z", level: "info", message: "queued" }], startedAt: "2026-07-31T00:00:00Z" };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ ok: true, data: operation }, 202))
      .mockResolvedValueOnce(json({ ok: true, data: { ...operation, type: "update" } }, 202))
      .mockResolvedValueOnce(json({ ok: true, data: { ...operation, type: "disable" } }, 202))
      .mockResolvedValueOnce(json({ ok: true, data: { ...operation, type: "commit" } }, 202))
      .mockResolvedValueOnce(json({ ok: true, data: { ...operation, type: "bind" } }, 202))
      .mockResolvedValueOnce(json({ ok: true, data: { ...operation, type: "uninstall" } }, 202));
    vi.stubGlobal("fetch", fetchMock);
    const client = new WebApiClient();

    const results = [
      await client.installMarketPackage("io.example", "rel_1"),
      await client.updateManagedPackage("io.example", "rel_2"),
      await client.setPackageContribution("io.example", "io.example/skill.main", false),
      await client.commitPackageChanges("io.example", "fix: local workflow"),
      await client.setPackageAssistantBinding(
        "io.example",
        "coding",
        ["io.example/skill.main"],
        { "io.example/experience.main": "main.shared" },
        { "io.example/assistant.reviewer": { sharingMode: "isolated" } },
      ),
      await client.uninstallManagedPackage("io.example", true),
    ];

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/web/v1/packages",
      "/api/web/v1/packages/io.example/update",
      "/api/web/v1/packages/io.example/contributions/io.example%2Fskill.main/disable",
      "/api/web/v1/packages/io.example/commit",
      "/api/web/v1/packages/bindings/coding",
      "/api/web/v1/packages/io.example?purgeData=false",
    ]);
    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))).toEqual({ packageId: "io.example", releaseId: "rel_1" });
    expect((fetchMock.mock.calls[2]?.[1] as RequestInit).method).toBe("POST");
    expect(JSON.parse(String((fetchMock.mock.calls[4]?.[1] as RequestInit).body))).toEqual({
      enabledContributionIds: ["io.example/skill.main"],
      experienceSpaces: { "io.example/experience.main": "main.shared" },
      functionalAssistants: { "io.example/assistant.reviewer": { sharingMode: "isolated" } },
    });
    expect(results.every((result) => result.status === "queued")).toBe(true);
    expect(results[0]).toMatchObject({ packageName: "Example", summary: "queued", events: operation.events });
  });

  it("keeps a completed mutation successful when a Hub-dependent refresh is offline", async () => {
    const operation = { operationId: "op_1", status: "success" };
    const result = await runMutationWithRefresh(
      async () => operation,
      [async () => { throw new TypeError("offline"); }, async () => "local state refreshed"],
    );
    expect(result.result).toBe(operation);
    expect(result.refreshError).toBeInstanceOf(TypeError);
  });

  it("detects ordinary uncommitted files from Runtime git.status arrays", () => {
    const summary = normalizeLocalPackage({
      packageId: "io.example",
      name: "Example",
      version: "1.0.0",
      baseCommit: "abc",
      localHead: "abc",
      contributions: [],
    });
    const detail = normalizeLocalPackage({
      packageId: "io.example",
      name: "Example",
      version: "1.0.0",
      baseCommit: "abc",
      localHead: "abc",
      contributions: [],
      git: { status: [" M README.md", "?? notes.txt"] },
    });
    const merged = mergeLocalPackage(summary, detail);
    expect(detail.hasLocalChanges).toBe(true);
    expect(merged?.hasLocalChanges).toBe(true);
  });

  it("normalizes local Package locations without inventing paths for older Runtimes", () => {
    const located = normalizeLocalPackage({
      packageId: "io.example",
      name: "Example",
      version: "1.0.0",
      contributions: [],
      location: {
        packageRoot: "/home/user/.wuxianpi/package-manager/packages/io.example",
        sourcePath: "/home/user/.wuxianpi/package-manager/packages/io.example/source",
        activeRevisionPath: "/home/user/.wuxianpi/package-manager/packages/io.example/revisions/rev-1",
        dataPath: "/home/user/.wuxianpi/package-manager/packages/io.example/data",
        logsPath: "/home/user/.wuxianpi/package-manager/packages/io.example/logs",
      },
    });
    const legacy = normalizeLocalPackage({ packageId: "io.legacy", name: "Legacy", version: "1.0.0", contributions: [] });
    expect(located.location?.sourcePath).toContain("/io.example/source");
    expect(located.location?.activeRevisionPath).toContain("/revisions/rev-1");
    expect(legacy.location).toBeUndefined();
  });

  it("preserves official preinstalled Package provenance", () => {
    const pkg = normalizeLocalPackage({
      packageId: "io.openhouse.guide",
      name: "Guide",
      version: "1.0.0",
      sourceKind: "preinstalled",
      contributions: [],
      preinstalled: {
        distributionId: "openhouse",
        seedReleaseId: "rel_1",
        seedCommit: "a".repeat(40),
        importedAt: "2026-08-17T00:00:00Z",
      },
    });
    expect(pkg.sourceKind).toBe("preinstalled");
    expect(pkg.preinstalled?.distributionId).toBe("openhouse");
  });

  it("preserves assistantSelectable and only offers Runtime-bindable contributions", () => {
    const pkg = normalizeLocalPackage({
      packageId: "io.example",
      name: "Example",
      version: "1.0.0",
      contributions: [
        { id: "io.example/skill.yes", enabled: true, contribution: { id: "io.example/skill.yes", type: "pi.skill", name: "Yes", assistantSelectable: true } },
        { id: "io.example/skill.no", enabled: true, contribution: { id: "io.example/skill.no", type: "pi.skill", name: "No", assistantSelectable: false } },
        { id: "io.example/context.main", enabled: true, contribution: { id: "io.example/context.main", type: "wuxianpi.context", name: "Context" } },
        { id: "io.example/skill.disabled", enabled: false, contribution: { id: "io.example/skill.disabled", type: "pi.skill", name: "Disabled", assistantSelectable: true } },
      ],
    });
    expect(pkg.contributions.map((item) => item.assistantSelectable)).toEqual([true, false, undefined, true]);
    expect(pkg.contributions.filter(isAssistantBindableContribution).map((item) => item.id)).toEqual([
      "io.example/skill.yes",
      "io.example/context.main",
    ]);
  });

  it("removes stale experience spaces when an experience contribution is unbound", () => {
    const removed = removeContributionBinding(
      ["io.example/experience.main", "io.other/skill.main"],
      { "io.example/experience.main": "example.shared", "io.other/experience.main": "other.shared" },
      "io.example/experience.main",
    );
    expect(removed.enabledContributionIds).toEqual(["io.other/skill.main"]);
    expect(removed.experienceSpaces).toEqual({ "io.other/experience.main": "other.shared" });
    expect(pruneExperienceSpaces(removed.enabledContributionIds, removed.experienceSpaces)).toEqual({});
  });

  it("loads the complete assistant binding before replacing it", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ ok: true, data: { binding: {
      assistantId: "coding",
      enabledContributionIds: ["io.other/skill.existing", "io.example/skill.main"],
      experienceSpaces: { "io.other/experience.main": "other.shared" },
      functionalAssistants: {
        "io.example/assistant.reviewer": { sharingMode: "shared" },
        "invalid-mode": { sharingMode: "global" },
      },
      updatedAt: "2026-07-31T00:00:00Z",
    } } })));
    const binding = await new WebApiClient().packageAssistantBinding("coding");
    expect(binding.enabledContributionIds).toContain("io.other/skill.existing");
    expect(binding.functionalAssistants).toEqual({ "io.example/assistant.reviewer": { sharingMode: "shared" } });
    expect(fetch).toHaveBeenCalledWith("/api/web/v1/packages/bindings/coding", expect.any(Object));
  });

  it("preserves functional assistant sharing when an existing caller omits that field", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ ok: true, data: { binding: {
        assistantId: "coding",
        enabledContributionIds: ["io.example/skill.main"],
        experienceSpaces: {},
        functionalAssistants: { "io.example/assistant.reviewer": { sharingMode: "hybrid" } },
      } } }))
      .mockResolvedValueOnce(json({ ok: true, data: { operationId: "op_1", packageId: "io.example", type: "bind", status: "queued" } }, 202));
    vi.stubGlobal("fetch", fetchMock);

    await new WebApiClient().setPackageAssistantBinding(
      "io.example",
      "coding",
      ["io.example/skill.main"],
      { "io.example/experience.main": "main.shared" },
    );

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/web/v1/packages/bindings/coding",
      "/api/web/v1/packages/bindings/coding",
    ]);
    expect(JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body))).toEqual({
      enabledContributionIds: ["io.example/skill.main"],
      experienceSpaces: { "io.example/experience.main": "main.shared" },
      functionalAssistants: { "io.example/assistant.reviewer": { sharingMode: "hybrid" } },
    });
  });

  it("matches the frozen publisher submission metadata contract", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ ok: true, data: { submission: { submissionId: "sub_1", status: "queued" } } }, 202));
    vi.stubGlobal("fetch", fetchMock);
    const input = {
      repositoryUrl: "https://github.com/example/package.git",
      ref: "v1.0.0",
      mirrorUrls: ["https://gitcode.com/example/package.git"],
      metadata: {
        links: [{ id: "support", kind: "support" as const, label: "Issues", url: "https://github.com/example/package/issues", source: "publisher" as const }],
        screenshots: [],
      },
    };
    await new WebApiClient().submitMarketPackage(input);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/web/v1/packages/publisher/submissions");
    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))).toEqual(input);
  });

  it("uses Runtime-owned gh authentication without exposing GitHub or Hub tokens to the browser", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ ok: true, data: { authenticated: false, ghAvailable: true, ghLogin: "example" } }))
      .mockResolvedValueOnce(json({ ok: true, data: { authenticated: true, user: { githubId: "42", login: "example", name: "Example", role: "user" }, session: { kind: "device" } } }))
      .mockResolvedValueOnce(json({ ok: true, data: { authenticated: false, user: null } }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new WebApiClient();

    const before = await client.marketAuthStatus();
    const signedIn = await client.marketAuthWithGh();
    const after = await client.marketAuthLogout();

    expect(before).toMatchObject({ authenticated: false, ghAvailable: true, ghLogin: "example" });
    expect(signedIn).toMatchObject({ authenticated: true, user: { login: "example" }, session: { kind: "device" } });
    expect(after.authenticated).toBe(false);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/web/v1/market/auth",
      "/api/web/v1/market/auth/github/gh",
      "/api/web/v1/market/auth/logout",
    ]);
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: "POST", body: "{}" });
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({ method: "POST", body: "{}" });
    for (const [, init] of fetchMock.mock.calls) {
      expect(new Headers((init as RequestInit | undefined)?.headers).has("authorization")).toBe(false);
    }
  });

  it("normalizes version-tolerant Runtime market identity payloads", () => {
    expect(normalizeMarketAuth({ auth: { signedIn: true, identity: { login: "octocat", avatarUrl: null }, ghAvailable: true } })).toEqual({
      authenticated: true,
      user: { login: "octocat", name: "octocat", avatarUrl: null },
      ghAvailable: true,
    });
  });

  it("builds publisher screenshots with multiple explicit sources and priorities", () => {
    const input = buildPublisherSubmissionInput({
      repositoryUrl: "https://github.com/example/package.git",
      ref: "v1.0.0",
      mirrorUrls: ["https://gitcode.com/example/package.git"],
      links: [{ id: "support", kind: "support", label: "Issues", url: "https://github.com/example/package/issues" }],
      screenshots: [{
        id: "main",
        alt: "Main screen",
        mediaType: "image/webp",
        width: "1280",
        height: "720",
        sha256: "a".repeat(64),
        downloadSources: [
          { kind: "github", url: "https://raw.githubusercontent.com/example/package/main/main.webp", priority: "100" },
          { kind: "mirror", url: "https://downloads.example.com/main.webp", priority: "80" },
        ],
      }],
    });
    expect(input.metadata.screenshots[0]?.downloadSources).toEqual([
      { kind: "github", url: "https://raw.githubusercontent.com/example/package/main/main.webp", priority: 100 },
      { kind: "mirror", url: "https://downloads.example.com/main.webp", priority: 80 },
    ]);
    expect(() => buildPublisherSubmissionInput({
      repositoryUrl: "https://github.com/example/package.git",
      ref: "main",
      mirrorUrls: [],
      links: [],
      screenshots: [{
        id: "bad",
        alt: "Bad",
        mediaType: "image/png",
        width: "10",
        height: "10",
        sha256: "b".repeat(64),
        downloadSources: [{ kind: "mirror", url: "https://example.com/bad.png", priority: "1001" }],
      }],
    })).toThrow("0 到 1000");
  });

  it("uses packageId for install-plan package dependencies", () => {
    const dependency: HubInstallPlan["compatibility"]["packages"][number] = {
      packageId: "io.example.dependency",
      approvedCommit: "abc123",
    };
    expect(dependency.packageId).toBe("io.example.dependency");
  });

  it("shows candidate failures, current-active preservation, self-operation handoff and experience sharing choices", () => {
    const source = readFileSync(new URL("../src/components/wuxianpi/Marketplace.tsx", import.meta.url), "utf8");
    expect(source).toContain("当前活动 Package 未被替换");
    expect(source).toContain("更新、停用或卸载前将创建维修登记");
    expect(source).toContain("operation.selfRelated");
    expect(source).toContain("共享经验");
    expect(source).toContain("独立经验");
    expect(source).toContain("提交本地修改");
    expect(source).toContain("解决方案目录");
    expect(source).toContain("复制给 AI");
    expect(source).toContain("需要修改时请使用源码目录");
    expect(source).toContain("GitHub 原站");
    expect(source).toContain("Hub 暂时不可用；本地已安装 Package 仍可管理");
    expect(source).toContain("优先级数值越大越先尝试");
    expect(source).toContain("使用本机 GitHub CLI 登录");
    expect(source).toContain("marketAuth.authenticated ? setPublisherOpen(true) : setAuthOpen(true)");
  });

  it("keeps Hub bearer sessions memory-only and locks governance actions to the loaded revision", () => {
    const source = readFileSync(new URL("../../hub/public/app.js", import.meta.url), "utf8");
    expect(source).toContain('sessionToken: ""');
    expect(source).not.toContain('localStorage.getItem("wuxianpiHubSessionToken")');
    expect(source).not.toContain('localStorage.setItem("wuxianpiHubSessionToken"');
    expect(source).not.toContain('localStorage.removeItem("wuxianpiHubSessionToken"');
    expect(source).toContain('name="expectedRevision" value="${escapeHtml(item.revision ?? 1)}"');
    expect(source).toContain('expectedRevision: Number(data.get("expectedRevision"))');
    expect(source).toContain('expectedRevision: Number(container.dataset.revision)');
    expect(source).toContain('message: message.trim()');
    expect(source).not.toContain('body: JSON.stringify(reason ? { reason } : {})');
    expect(source).toContain("审核消息不能为空");
  });
});
