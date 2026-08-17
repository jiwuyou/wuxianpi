import { access } from "node:fs/promises";
import { join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { InstallPlan } from "./package-types.js";
import { RequestError } from "./protocol.js";

export const MARKETPLACE_DETAILS_KEY = "wuxianpiMarketplace";
export const MARKETPLACE_TOOL_NAMES = [
  "search_marketplace",
  "inspect_marketplace_package",
  "install_marketplace_package",
] as const;

interface MarketplaceToolHost {
  search(query: Record<string, string | number | undefined>): Promise<Record<string, unknown>>;
  packageDetail(packageId: string): Promise<Record<string, unknown>>;
  releases(packageId: string): Promise<Record<string, unknown>>;
  installPlan(packageId: string, releaseId?: string): Promise<InstallPlan>;
  install(packageId: string, releaseId?: string): Promise<Record<string, unknown>>;
  installedDetail(packageId: string): Promise<Record<string, unknown>>;
}

export function createMarketplaceTools(host: MarketplaceToolHost): ToolDefinition[] {
  return [createSearchTool(host), createInspectTool(host), createInstallTool(host)];
}

function createSearchTool(host: MarketplaceToolHost): ToolDefinition {
  return defineTool({
    name: MARKETPLACE_TOOL_NAMES[0],
    label: "Search WuxianPi marketplace",
    description: "Search the live WuxianPi Package marketplace by user need. Returns current Package IDs, names, summaries, categories, and Release availability.",
    promptSnippet: "Search the WuxianPi Package marketplace for installable capabilities and solutions",
    promptGuidelines: [
      "Use search_marketplace when the user needs a capability or solution that is not already available.",
      "Do not claim that a Package exists until search_marketplace returns it.",
    ],
    parameters: {
      type: "object",
      required: ["query"],
      additionalProperties: false,
      properties: {
        query: { type: "string", minLength: 1 },
        category: { type: "string" },
        contributionType: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 20 },
      },
    } as never,
    async execute(_toolCallId, rawParams) {
      const params = asRecord(rawParams);
      const query = requiredString(params.query, "query");
      const limit = optionalInteger(params.limit, "limit") ?? 10;
      const response = await host.search({
        q: query,
        category: optionalString(params.category),
        contributionType: optionalString(params.contributionType),
        limit,
      });
      const packages = asArray(response.packages).slice(0, limit).map(compactPackage);
      const result = { query, packages, nextCursor: optionalString(response.nextCursor) ?? null };
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: { [MARKETPLACE_DETAILS_KEY]: { operation: "search", ...result } },
      };
    },
  });
}

function createInspectTool(host: MarketplaceToolHost): ToolDefinition {
  return defineTool({
    name: MARKETPLACE_TOOL_NAMES[1],
    label: "Inspect WuxianPi marketplace Package",
    description: "Inspect a current marketplace Package, its Releases, verified install plan, and installed local location when available.",
    promptSnippet: "Inspect a WuxianPi marketplace Package before installation or locate an installed solution",
    promptGuidelines: [
      "Use inspect_marketplace_package before recommending installation when Package source, verification, or local state matters.",
      "For an installed solution Package, use its returned sourcePath and read README.md before continuing.",
    ],
    parameters: {
      type: "object",
      required: ["packageId"],
      additionalProperties: false,
      properties: {
        packageId: { type: "string", minLength: 1 },
        releaseId: { type: "string" },
      },
    } as never,
    async execute(_toolCallId, rawParams) {
      const params = asRecord(rawParams);
      const packageId = requiredString(params.packageId, "packageId");
      const releaseId = optionalString(params.releaseId);
      const [marketResult, releasesResult, planResult, installedResult] = await Promise.allSettled([
        host.packageDetail(packageId),
        host.releases(packageId),
        host.installPlan(packageId, releaseId),
        host.installedDetail(packageId),
      ]);
      if (marketResult.status === "rejected" && installedResult.status === "rejected") throw marketResult.reason;
      const market = marketResult.status === "fulfilled" ? compactPackage(asRecord(marketResult.value.package)) : null;
      const releases = releasesResult.status === "fulfilled"
        ? asArray(releasesResult.value.releases).slice(0, 20).map(compactRelease)
        : [];
      const plan = planResult.status === "fulfilled" ? compactInstallPlan(planResult.value) : null;
      const installed = installedResult.status === "fulfilled" ? compactInstalled(installedResult.value) : null;
      const result = { packageId, market, releases, installPlan: plan, installed };
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: { [MARKETPLACE_DETAILS_KEY]: { operation: "inspect", ...result } },
      };
    },
  });
}

function createInstallTool(host: MarketplaceToolHost): ToolDefinition {
  return defineTool({
    name: MARKETPLACE_TOOL_NAMES[2],
    label: "Install WuxianPi marketplace Package",
    description: "Install a verified WuxianPi marketplace Package after explicit user confirmation. Returns the Package's local source path. For solution Packages, read the returned README path and follow the local repository.",
    promptSnippet: "Install a verified marketplace Package and return its local source location",
    promptGuidelines: [
      "Never use install_marketplace_package without explicit user confirmation in its confirmation dialog.",
      "After installing a solution Package, immediately read nextAction.entryPath and follow the local repository; do not claim the final application is already installed.",
    ],
    parameters: {
      type: "object",
      required: ["packageId"],
      additionalProperties: false,
      properties: {
        packageId: { type: "string", minLength: 1 },
        releaseId: { type: "string" },
      },
    } as never,
    async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
      const params = asRecord(rawParams);
      const packageId = requiredString(params.packageId, "packageId");
      const requestedReleaseId = optionalString(params.releaseId);
      const [marketResponse, plan] = await Promise.all([
        host.packageDetail(packageId),
        host.installPlan(packageId, requestedReleaseId),
      ]);
      if (plan.revoked) throw new RequestError("marketplace_release_revoked", `Release is revoked: ${plan.releaseId}`);
      if (plan.verification.status !== "passed") {
        throw new RequestError("marketplace_release_unverified", `Release verification is not passed: ${plan.verification.status}`);
      }
      const market = compactPackage(asRecord(marketResponse.package));
      const marketCategories = asStringArray(market.categories);
      const source = plan.gitSources.sort((left, right) => right.priority - left.priority)[0]?.url ?? "unknown";
      const capabilities = plan.compatibility.hostCapabilities.map((item) => `${item.id}@${item.contractVersion}`);
      const dependencies = plan.compatibility.packages.map((item) => item.packageId);
      const confirmed = await ctx.ui.confirm(
        "安装 WuxianPi Package",
        [
          `${market.name ?? packageId}`,
          `Package: ${packageId}`,
          `版本: ${plan.version}`,
          `Commit: ${plan.approvedCommit}`,
          `来源: ${source}`,
          `分类: ${marketCategories.join(", ") || "未分类"}`,
          `验证: ${plan.verification.status}`,
          `Host 能力: ${capabilities.join(", ") || "无"}`,
          `Package 依赖: ${dependencies.join(", ") || "无"}`,
          `Artifacts: ${plan.artifacts.length}`,
          "",
          "确认下载、验证并安装这个 Package？",
        ].join("\n"),
        { signal },
      );
      if (!confirmed) {
        const cancelled = { operation: "install", packageId, cancelled: true };
        return {
          content: [{ type: "text", text: "用户取消了 Package 安装。" }],
          details: { [MARKETPLACE_DETAILS_KEY]: cancelled },
        };
      }
      const installedOperation = await host.install(packageId, plan.releaseId);
      const detail = await host.installedDetail(packageId);
      const installed = compactInstalled(detail);
      const categories = asStringArray(asRecord(detail.manifest).categories);
      const sourcePath = installed.location?.sourcePath ?? null;
      let nextAction: Record<string, unknown> | null = null;
      if (categories.includes("solution") && sourcePath) {
        const entryPath = join(sourcePath, "README.md");
        const entryExists = await access(entryPath).then(() => true, () => false);
        nextAction = { type: "follow-solution", entryPath, entryExists };
      }
      const result = {
        operation: "install",
        installed: true,
        packageId,
        name: installed.name,
        categories,
        location: installed.location,
        nextAction,
        packageOperation: installedOperation,
      };
      const text = nextAction
        ? `解决方案已下载到：\n${sourcePath}\n\n请立即读取 ${String(nextAction.entryPath)}，并按照本地仓库执行。方案下载不代表最终应用已经安装。`
        : `Package 已安装：${installed.name ?? packageId}${sourcePath ? `\n源码目录：${sourcePath}` : ""}`;
      return {
        content: [{ type: "text", text }],
        details: { [MARKETPLACE_DETAILS_KEY]: result },
      };
    },
  });
}

function compactPackage(value: unknown): Record<string, unknown> {
  const item = asRecord(value);
  return {
    id: optionalString(item.id) ?? optionalString(item.packageId) ?? null,
    name: optionalString(item.name) ?? null,
    summary: boundedText(item.summary, 500),
    categories: asStringArray(item.categories),
    latestReleaseId: optionalString(item.latestReleaseId) ?? null,
    updatedAt: optionalString(item.updatedAt) ?? null,
  };
}

function compactRelease(value: unknown): Record<string, unknown> {
  const item = asRecord(value);
  return {
    releaseId: optionalString(item.releaseId) ?? optionalString(item.id) ?? null,
    version: optionalString(item.version) ?? null,
    approvedCommit: optionalString(item.approvedCommit) ?? null,
    status: optionalString(item.status) ?? null,
    publishedAt: optionalString(item.publishedAt) ?? null,
    revoked: item.revocation != null,
  };
}

function compactInstallPlan(plan: InstallPlan): Record<string, unknown> {
  return {
    releaseId: plan.releaseId,
    version: plan.version,
    approvedCommit: plan.approvedCommit,
    verificationStatus: plan.verification.status,
    revoked: plan.revoked,
    sources: plan.gitSources.map((source) => ({ kind: source.kind, url: source.url, priority: source.priority })),
  };
}

function compactInstalled(value: unknown): { packageId: string | null; name: string | null; version: string | null; location: Record<string, string | null> | null } {
  const item = asRecord(value);
  const location = asRecord(item.location);
  return {
    packageId: optionalString(item.packageId) ?? null,
    name: optionalString(item.name) ?? null,
    version: optionalString(item.version) ?? null,
    location: Object.keys(location).length > 0 ? {
      packageRoot: optionalString(location.packageRoot) ?? null,
      sourcePath: optionalString(location.sourcePath) ?? null,
      activeRevisionPath: optionalString(location.activeRevisionPath) ?? null,
      dataPath: optionalString(location.dataPath) ?? null,
      logsPath: optionalString(location.logsPath) ?? null,
    } : null,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new RequestError("invalid_marketplace_tool_input", `${label} must be a non-empty string`);
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalInteger(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value)) throw new RequestError("invalid_marketplace_tool_input", `${label} must be an integer`);
  return value as number;
}

function boundedText(value: unknown, maxLength: number): string | null {
  const text = optionalString(value);
  if (!text) return null;
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}…`;
}
