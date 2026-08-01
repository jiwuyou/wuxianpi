export const PACKAGE_CATEGORIES = [
  "app",
  "assistant",
  "capability",
  "skill",
  "interface",
  "knowledge-experience",
  "solution",
] as const;

export const CONTRIBUTION_TYPES = [
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

export type PackageCategory = typeof PACKAGE_CATEGORIES[number];
export type ContributionType = typeof CONTRIBUTION_TYPES[number];
export type SubmissionStatus = "queued" | "verifying" | "awaiting_review" | "approved" | "rejected" | "failed";
export type ReleaseStatus = "approved" | "revoked";
export type IssueStatus =
  | "pending"
  | "confirmed"
  | "in_progress"
  | "awaiting_verification"
  | "resolved"
  | "cannot_reproduce"
  | "declined"
  | "migrated";
export type IssueVisibility = "public" | "maintainers";

export interface PublisherIdentity {
  id: string;
  name: string;
  profileUrl: string | null;
}

export interface PublisherCredential extends PublisherIdentity {
  token: string;
}

export interface GitSource {
  kind: "github" | "mirror";
  url: string;
  priority: number;
}

export interface LinkMetadata {
  id: string;
  kind: "homepage" | "source" | "documentation" | "support" | "license";
  label: string;
  url: string;
  source: "manifest" | "publisher" | "hub";
}

export interface DownloadSource {
  kind: "github" | "mirror";
  url: string;
  priority: number;
}

export interface ScreenshotMetadata {
  id: string;
  alt: string;
  mediaType: "image/png" | "image/jpeg" | "image/webp";
  width: number;
  height: number;
  sha256: string;
  source: "manifest" | "publisher" | "hub";
  downloadSources: DownloadSource[];
}

export interface PackagePresentationMetadata {
  links: LinkMetadata[];
  screenshots: ScreenshotMetadata[];
}

export interface PackageManifest {
  schemaVersion: 1;
  id: string;
  name: string;
  version: string;
  summary: string;
  description?: string;
  license?: string;
  homepage?: string;
  categories: PackageCategory[];
  requires: {
    hostCapabilities: Array<{ id: string; contractVersion: number }>;
    packages: Array<{
      packageId: string;
      approvedCommit: string;
      requiredContributionIds?: string[];
    }>;
  };
  build: Record<string, unknown>;
  artifacts: ArtifactManifest[];
  contributions: ContributionManifest[];
}

export interface SupportIssueRecord {
  issueId: string;
  issueNumber: number;
  packageId: string | null;
  component: string | null;
  targetRepository: string | null;
  reporterTokenHash: string;
  reporterName: string;
  source: "assistant" | "market";
  confirmation: "assistant_asserted";
  title: string;
  body: string;
  labels: string[];
  environment: Record<string, unknown>;
  visibility: IssueVisibility;
  status: IssueStatus;
  fixReleaseId: string | null;
  githubUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SupportIssueComment {
  commentId: string;
  issueId: string;
  actorType: "reporter" | "publisher" | "admin";
  actorId: string;
  actorName: string;
  body: string;
  createdAt: string;
}

export type IssueActor =
  | { kind: "anonymous" }
  | { kind: "reporter"; tokenHash: string }
  | { kind: "publisher"; id: string; name: string }
  | { kind: "admin"; id: string; name: string };

export interface ArtifactManifest {
  id: string;
  fileName: string;
  sha256: string;
  sizeBytes: number;
  archive: string;
  platforms: Array<{ os: string; arch: string }>;
  sources: Array<{ kind: "github-release" | "mirror"; url: string; priority: number }>;
}

export interface ContributionManifest {
  id: string;
  type: ContributionType;
  name: string;
  description?: string;
  path?: string;
  config?: string;
  manifest?: string;
  basePath?: string;
  artifactId?: string;
  defaultBindings?: string[];
  [key: string]: unknown;
}

export interface VerificationResult {
  status: "passed" | "failed";
  verifiedAt: string;
  checks: string[];
}

export interface VerificationOutput {
  manifest: PackageManifest;
  manifestDigest: string;
  verification: VerificationResult;
  diagnostics: string[];
}

export interface SourceHealth {
  url: string;
  kind: "github" | "mirror";
  status: "healthy" | "failed";
  checkedAt: string;
  commit: string | null;
  error: string | null;
}

export interface SubmissionRecord {
  submissionId: string;
  publisherId: string;
  repositoryUrl: string;
  requestedRef: string;
  resolvedCommit: string | null;
  mirrorUrls: string[];
  metadata: PackagePresentationMetadata;
  status: SubmissionStatus;
  diagnostics: string[];
  verification: VerificationResult | null;
  manifest: PackageManifest | null;
  manifestDigest: string | null;
  sourceHealth: SourceHealth[];
  revision: number;
  verifiedRevision: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReleaseRecord {
  releaseId: string;
  packageId: string;
  submissionId: string;
  publisherId: string;
  version: string;
  approvedCommit: string;
  submittedRef: string;
  repositoryUrl: string;
  mirrorUrls: string[];
  manifestPath: string;
  manifestDigest: string;
  manifest: PackageManifest;
  metadata: PackagePresentationMetadata;
  verification: VerificationResult;
  status: ReleaseStatus;
  publishedAt: string;
  revocation: { reason: string; revokedAt: string } | null;
}
