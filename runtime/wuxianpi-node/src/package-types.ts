import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

export type PackageCategory =
  | "app"
  | "assistant"
  | "capability"
  | "skill"
  | "interface"
  | "knowledge-experience"
  | "solution";

export type ContributionType =
  | "pi.extension"
  | "pi.skill"
  | "pi.prompt"
  | "pi.theme"
  | "mcp.server"
  | "wuxianpi.webExtension"
  | "wuxianpi.renderer"
  | "wuxianpi.assistantTemplate"
  | "wuxianpi.context"
  | "wuxianpi.experience"
  | "wuxianpi.runtime"
  | "openhouse.app"
  | "service-manager.service"
  | "artifact";

export interface HostCapabilityRequirement {
  id: string;
  contractVersion: number;
}

export interface ExactPackageDependency {
  packageId: string;
  approvedCommit: string;
  requiredContributionIds?: string[];
}

export interface PackageCommandDeclaration {
  command: string;
  workingDirectory?: string;
  timeoutSeconds?: number;
}

export interface PackageArtifactSource {
  kind: "github-release" | "mirror";
  url: string;
  priority: number;
}

export interface PackageArtifact {
  id: string;
  fileName: string;
  sha256: string;
  sizeBytes: number;
  archive: "none" | "zip" | "tar.gz" | "tar.zst";
  platforms: Array<{ os: "android" | "linux" | "any"; arch: "arm64" | "x64" | "any" }>;
  sources: PackageArtifactSource[];
}

export interface PackageContribution {
  id: string;
  type: ContributionType;
  name: string;
  description?: string;
  path?: string;
  config?: string;
  manifest?: string;
  assistantSelectable?: boolean;
  contentTypes?: string[];
  kind?: "main" | "functional";
  defaultBindings?: string[];
  format?: "markdown" | "json" | "directory";
  experienceSpaceId?: string;
  basePath?: string;
  mainstream?: MainstreamExperienceSource;
  updatePolicy?: ExperienceUpdatePolicy;
  artifactId?: string;
  purpose?: string;
}

export type MainstreamExperienceSource =
  | { type: "git"; url: string; ref: string; path: string }
  | { type: "https-json"; url: string };

export interface ExperienceUpdatePolicy {
  strategy: "three-way-merge";
  priority: ["local-verified-correction", "mainstream", "package-base"];
  localCorrections: "preserve";
}

export interface ExperienceUpdateState {
  schemaVersion: 1;
  packageId: string;
  contributionId: string;
  experienceSpaceId: string;
  previousRevision: string | null;
  currentRevision: string | null;
  candidateRevision: string | null;
  status: "empty" | "ready" | "conflict";
  mainstreamPath: string;
  localCorrectionPath: string;
  effectivePath: string;
  conflictPath: string | null;
  updatedAt: string;
}

export interface PackageExecutionContext {
  packageIds: string[];
  contributionIds: string[];
  serviceIds: string[];
  updatedAt: string;
}

export interface WuxianPiPackageManifest {
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
    hostCapabilities: HostCapabilityRequirement[];
    packages: ExactPackageDependency[];
  };
  build:
    | { mode: "none"; commands?: { test?: PackageCommandDeclaration } }
    | { mode: "local"; commands: { install?: PackageCommandDeclaration; build: PackageCommandDeclaration; test?: PackageCommandDeclaration } }
    | { mode: "artifact"; artifactIds: string[]; commands?: { test?: PackageCommandDeclaration } };
  artifacts: PackageArtifact[];
  contributions: PackageContribution[];
}

export interface HubGitSource {
  kind: "github" | "mirror";
  url: string;
  priority: number;
}

export interface InstallPlan {
  schemaVersion: 1;
  packageId: string;
  releaseId: string;
  version: string;
  approvedCommit: string;
  manifestPath: string;
  manifestDigest: string;
  gitSources: HubGitSource[];
  artifacts: PackageArtifact[];
  compatibility: {
    hostCapabilities: HostCapabilityRequirement[];
    packages: ExactPackageDependency[];
  };
  verification: { status: string; verifiedAt?: string; checks?: string[] };
  revoked: boolean;
}

export type PackageSourceStatus = "ready" | "candidate_ready" | "merge_conflict" | "build_failed";

export interface InstalledPackageState {
  packageId: string;
  name: string;
  version: string;
  sourcePath: string;
  dataPath: string;
  baseCommit: string;
  localHead: string;
  targetCommit: string;
  activeRevisionId?: string;
  knownGoodRevisionId?: string;
  sourceStatus: PackageSourceStatus;
  manifest: WuxianPiPackageManifest;
  installPlan: InstallPlan;
  enabledContributionIds: string[];
  installedAt: string;
  updatedAt: string;
  lastError?: { code: string; message: string; logPath?: string };
  sourceKind?: "market" | "bundled";
}

export interface ActiveContributionRecord {
  id: string;
  packageId: string;
  revisionId: string;
  revisionPath: string;
  enabled: boolean;
  contribution: PackageContribution;
}

export interface AssistantPackageBinding {
  assistantId: string;
  enabledContributionIds: string[];
  experienceSpaces: Record<string, string>;
  functionalAssistants: Record<string, FunctionalAssistantBindingSettings>;
  updatedAt: string;
}

export type FunctionalAssistantSharingMode = "isolated" | "shared" | "hybrid";

export interface FunctionalAssistantBindingSettings {
  sharingMode: FunctionalAssistantSharingMode;
}

export interface ResolvedFunctionalAssistant {
  functionId: string;
  packageId: string;
  name: string;
  description?: string;
  sharingMode: FunctionalAssistantSharingMode;
  defaultBindingIds: string[];
  resolvedContributionIds: string[];
  sharedStatePath: string;
  profileStatePath: string;
}

export interface PackageManagerState {
  schemaVersion: 1;
  generation: number;
  packages: Record<string, InstalledPackageState>;
  contributions: Record<string, ActiveContributionRecord>;
  assistantBindings: Record<string, AssistantPackageBinding>;
  mcpServerOwners: Record<string, { packageId: string; contributionId: string }>;
  serviceOwners: Record<string, { packageId: string; contributionId: string }>;
}

export interface PackageOperationEvent {
  operationId: string;
  time: string;
  type: string;
  packageId?: string;
  phase: "started" | "progress" | "succeeded" | "failed";
  message: string;
  details?: Record<string, unknown>;
}

export interface ResolvedAssistantPackageResources {
  extensionPaths: string[];
  skillPaths: string[];
  promptPaths: string[];
  themePaths: string[];
  appendSystemPrompt: string[];
  mcpServerIds: string[];
  webExtensionIds: string[];
  resolvedContributionIds: string[];
  functionalAssistants: ResolvedFunctionalAssistant[];
  customTools: ToolDefinition[];
  experiences: Array<{
    contributionId: string;
    experienceSpaceId: string;
    basePath: string;
    mainstream: MainstreamExperienceSource;
    updatePolicy: ExperienceUpdatePolicy;
    localCorrectionPath: string;
  }>;
}
