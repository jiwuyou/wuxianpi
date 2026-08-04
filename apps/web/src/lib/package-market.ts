export const MARKET_CATEGORIES = [
  "app",
  "assistant",
  "capability",
  "skill",
  "interface",
  "knowledge-experience",
  "solution",
] as const;

export type MarketCategory = typeof MARKET_CATEGORIES[number];

export const MARKET_CATEGORY_LABELS: Record<MarketCategory, string> = {
  app: "应用",
  assistant: "助手",
  capability: "能力",
  skill: "Skill",
  interface: "界面",
  "knowledge-experience": "知识与经验",
  solution: "解决方案",
};

export const PACKAGE_CONTRIBUTION_TYPES = [
  "pi.extension",
  "pi.skill",
  "pi.prompt",
  "pi.theme",
  "mcp.server",
  "wuxianpi.webExtension",
  "wuxianpi.renderer",
  "wuxianpi.assistantTemplate",
  "wuxianpi.context",
  "wuxianpi.experience",
  "openhouse.app",
  "service-manager.service",
  "artifact",
] as const;

export type PackageContributionType = typeof PACKAGE_CONTRIBUTION_TYPES[number];
export type PackageReleaseStatus = "approved" | "revoked";
export type PackageVerificationStatus = "queued" | "running" | "passed" | "failed";

export interface HubSource {
  kind: "github" | "mirror" | "github-release" | string;
  url: string;
  priority: number;
}

export interface HubVerification {
  status: PackageVerificationStatus;
  verifiedAt?: string | null;
  checks: string[];
  diagnostics?: string[];
}

export interface HubPackageSummary {
  id: string;
  name: string;
  summary: string;
  categories: MarketCategory[];
  latestReleaseId: string | null;
  updatedAt: string;
}

export interface HubPackageLink {
  id: string;
  kind: "homepage" | "source" | "documentation" | "support" | "license";
  label: string;
  url: string;
  source: "manifest" | "publisher" | "hub";
}

export interface HubScreenshot {
  id: string;
  alt: string;
  mediaType: "image/png" | "image/jpeg" | "image/webp";
  width: number;
  height: number;
  sha256: string;
  source: "manifest" | "publisher" | "hub";
  downloadSources: HubSource[];
}

export interface HubReleaseSummary {
  releaseId: string;
  version: string;
  approvedCommit: string;
  submittedRef?: string;
  manifest?: { path: string; sha256: string };
  contributionTypes: PackageContributionType[];
  verification: HubVerification;
  status: PackageReleaseStatus;
  publishedAt: string;
  revocation: { reason: string; revokedAt: string } | null;
  installPlanUrl?: string;
}

export interface HubPackageDetail extends HubPackageSummary {
  description: string | null;
  license: string | null;
  publisher: { id: string; name: string; profileUrl: string | null };
  links: HubPackageLink[];
  screenshots: HubScreenshot[];
  contributionTypes: PackageContributionType[];
  latestRelease: Pick<HubReleaseSummary, "releaseId" | "version" | "approvedCommit" | "publishedAt" | "status"> | null;
  review: { status: "approved" | "pending" | "rejected"; reviewedAt: string | null };
  createdAt: string;
}

export interface HubArtifact {
  id: string;
  fileName: string;
  sha256: string;
  sizeBytes: number;
  archive: string;
  platforms: Array<{ os: string; arch: string }>;
  sources: HubSource[];
}

export interface HubInstallPlan {
  schemaVersion: 1;
  packageId: string;
  releaseId: string;
  version: string;
  approvedCommit: string;
  manifestPath: string;
  manifestDigest: string;
  gitSources: HubSource[];
  artifacts: HubArtifact[];
  compatibility: {
    hostCapabilities: Array<{ id: string; contractVersion: number }>;
    packages: Array<{ packageId: string; approvedCommit: string; requiredContributionIds?: string[] }>;
  };
  verification: HubVerification;
  revoked: boolean;
}

export type LocalPackageStatus =
  | "installed"
  | "active"
  | "disabled"
  | "update_available"
  | "merge_conflict"
  | "build_failed"
  | "test_failed"
  | "activation_failed"
  | "revoked";

export interface LocalContribution {
  id: string;
  type: PackageContributionType;
  name: string;
  description?: string;
  enabled: boolean;
  assistantSelectable?: boolean;
  selfRelated?: boolean;
  assistantIds?: string[];
  defaultExperienceSpaceId?: string;
}

export interface PackageAssistantBinding {
  assistantId: string;
  enabledContributionIds: string[];
  experienceSpaces: Record<string, string>;
  functionalAssistants: Record<string, FunctionalAssistantBinding>;
}

export type FunctionalAssistantSharingMode = "isolated" | "shared" | "hybrid";

export interface FunctionalAssistantBinding {
  sharingMode: FunctionalAssistantSharingMode;
}

export interface LocalPackage {
  packageId: string;
  name: string;
  version: string;
  status: LocalPackageStatus;
  baseCommit: string;
  localHead: string;
  targetCommit?: string | null;
  activeCommit: string;
  knownGoodCommit?: string | null;
  activeRevision?: string;
  hasLocalChanges: boolean;
  updateReleaseId?: string | null;
  updateVersion?: string | null;
  currentActivePreserved?: boolean;
  selfRelated?: boolean;
  maintenanceRecordPath?: string | null;
  contributions: LocalContribution[];
  assistantBindings: PackageAssistantBinding[];
  failure?: {
    stage: "merge" | "build" | "test" | "activate";
    message: string;
    logPath?: string;
    conflicts?: string[];
  } | null;
  installedAt?: string;
  updatedAt?: string;
}

export function mergeLocalPackage(summary: LocalPackage | null, detail: LocalPackage | null): LocalPackage | null {
  if (!summary) return detail;
  if (!detail) return summary;
  return {
    ...summary,
    ...detail,
    status: summary.status === "update_available" ? summary.status : detail.status,
    updateReleaseId: summary.updateReleaseId ?? detail.updateReleaseId,
    updateVersion: summary.updateVersion ?? detail.updateVersion,
  };
}

export function isAssistantBindableContribution(contribution: LocalContribution): boolean {
  return contribution.enabled && (
    contribution.assistantSelectable === true
    || contribution.type === "wuxianpi.experience"
    || contribution.type === "wuxianpi.context"
  );
}

export function removeContributionBinding(
  enabledContributionIds: string[],
  experienceSpaces: Record<string, string>,
  contributionId: string,
): { enabledContributionIds: string[]; experienceSpaces: Record<string, string> } {
  const nextSpaces = { ...experienceSpaces };
  delete nextSpaces[contributionId];
  return {
    enabledContributionIds: enabledContributionIds.filter((id) => id !== contributionId),
    experienceSpaces: nextSpaces,
  };
}

export function pruneExperienceSpaces(enabledContributionIds: string[], experienceSpaces: Record<string, string>): Record<string, string> {
  const enabled = new Set(enabledContributionIds);
  return Object.fromEntries(Object.entries(experienceSpaces).filter(([id]) => enabled.has(id)));
}

export async function runMutationWithRefresh<T>(
  mutation: () => Promise<T>,
  refreshers: Array<() => Promise<unknown>>,
): Promise<{ result: T; refreshError: unknown | null }> {
  const result = await mutation();
  const refreshResults = await Promise.allSettled(refreshers.map((refresh) => refresh()));
  const failed = refreshResults.find((refreshResult) => refreshResult.status === "rejected");
  return { result, refreshError: failed?.status === "rejected" ? failed.reason : null };
}

export type PackageOperationType = "install" | "update" | "uninstall" | "enable" | "disable" | "commit" | "bind";
export type PackageOperationStatus = "queued" | "running" | "success" | "failed" | "cancelled";

export interface PackageOperation {
  operationId: string;
  packageId: string;
  packageName?: string;
  type: PackageOperationType;
  status: PackageOperationStatus;
  summary: string;
  selfRelated: boolean;
  maintenanceRecordPath?: string | null;
  activePackagePreserved?: boolean;
  fromCommit?: string | null;
  toCommit?: string | null;
  logPath?: string | null;
  error?: string | null;
  events?: Array<{ at: string; level: "info" | "warning" | "error"; message: string }>;
  startedAt: string;
  completedAt?: string | null;
}

export interface MarketPackageDetailPayload {
  package: HubPackageDetail | null;
  releases: HubReleaseSummary[];
  installPlan: HubInstallPlan | null;
  installed: LocalPackage | null;
  hubOffline?: boolean;
  hubError?: string;
}

export interface PublisherSubmissionInput {
  repositoryUrl: string;
  ref: string;
  mirrorUrls: string[];
  metadata: {
    links: HubPackageLink[];
    screenshots: HubScreenshot[];
  };
}

export interface PublisherSubmissionDraft {
  repositoryUrl: string;
  ref: string;
  mirrorUrls: string[];
  links: Array<{ id: string; kind: HubPackageLink["kind"]; label: string; url: string }>;
  screenshots: Array<{
    id: string;
    alt: string;
    mediaType: HubScreenshot["mediaType"];
    width: string;
    height: string;
    sha256: string;
    downloadSources: Array<{ kind: "github" | "mirror"; url: string; priority: string }>;
  }>;
}

function requireHttpsUrl(value: string, label: string): string {
  const trimmed = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`${label}必须是有效 URL`);
  }
  if (parsed.protocol !== "https:") throw new Error(`${label}必须使用 HTTPS`);
  return trimmed;
}

function requireUniqueIds(items: Array<{ id: string }>, label: string): void {
  const ids = items.map((item) => item.id);
  if (new Set(ids).size !== ids.length) throw new Error(`${label} ID 不能重复`);
}

export function buildPublisherSubmissionInput(draft: PublisherSubmissionDraft): PublisherSubmissionInput {
  const repositoryUrl = requireHttpsUrl(draft.repositoryUrl, "GitHub 仓库");
  const ref = draft.ref.trim();
  if (!ref) throw new Error("Ref 不能为空");
  const mirrorUrls = draft.mirrorUrls.filter((url) => url.trim()).map((url, index) => requireHttpsUrl(url, `镜像 ${index + 1}`));
  const links = draft.links.map((item, index) => ({
    id: item.id.trim() || `link-${index + 1}`,
    kind: item.kind,
    label: item.label.trim() || item.kind,
    url: requireHttpsUrl(item.url, `链接 ${index + 1}`),
    source: "publisher" as const,
  }));
  requireUniqueIds(links, "链接");
  const screenshots = draft.screenshots.map((item, index) => {
    const width = Number(item.width);
    const height = Number(item.height);
    if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) throw new Error(`截图 ${index + 1} 的尺寸必须是正整数`);
    const sha256 = item.sha256.trim();
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error(`截图 ${index + 1} 的 SHA-256 必须是 64 位小写十六进制`);
    if (item.downloadSources.length === 0) throw new Error(`截图 ${index + 1} 至少需要一个下载来源`);
    const downloadSources = item.downloadSources.map((source, sourceIndex) => {
      const priority = Number(source.priority);
      if (!Number.isInteger(priority) || priority < 0 || priority > 1000) throw new Error(`截图 ${index + 1} 来源 ${sourceIndex + 1} 的优先级必须是 0 到 1000 的整数`);
      return {
        kind: source.kind,
        url: requireHttpsUrl(source.url, `截图 ${index + 1} 来源 ${sourceIndex + 1}`),
        priority,
      };
    }).sort((left, right) => right.priority - left.priority);
    return {
      id: item.id.trim() || `screenshot-${index + 1}`,
      alt: item.alt.trim(),
      mediaType: item.mediaType,
      width,
      height,
      sha256,
      source: "publisher" as const,
      downloadSources,
    };
  });
  requireUniqueIds(screenshots, "截图");
  return { repositoryUrl, ref, mirrorUrls, metadata: { links, screenshots } };
}

export interface PublisherSubmission {
  submissionId: string;
  repositoryUrl: string;
  requestedRef: string;
  resolvedCommit: string | null;
  mirrorUrls: string[];
  status: "queued" | "verifying" | "awaiting_review" | "approved" | "rejected" | "failed";
  diagnostics: string[];
  createdAt: string;
  updatedAt: string;
}

export interface PackageListResponse {
  packages: HubPackageSummary[];
  nextCursor: string | null;
}

export interface InstalledPackageListResponse {
  packages: LocalPackage[];
}

export interface PackageOperationListResponse {
  operations: PackageOperation[];
  nextCursor?: string | null;
}
