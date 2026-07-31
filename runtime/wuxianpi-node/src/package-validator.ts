import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import yaml from "js-yaml";
import { validateCanonicalChildManifest } from "./child-manifest-validator.js";
import { RequestError } from "./protocol.js";
import type {
  InstallPlan, PackageArtifact, PackageContribution, WuxianPiPackageManifest,
} from "./package-types.js";
import type { McpServerConfig } from "./mcp-config.js";

const PACKAGE_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/;
const CONTRIBUTION_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+\/[a-z][a-z0-9]*(?:[._/-][a-z0-9]+)*$/;
const COMMIT = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const CONTRIBUTION_TYPES = new Set([
  "pi.extension", "pi.skill", "pi.prompt", "pi.theme", "mcp.server", "wuxianpi.webExtension",
  "wuxianpi.renderer", "wuxianpi.assistantTemplate", "wuxianpi.context", "wuxianpi.experience",
  "openhouse.app", "service-manager.service", "artifact",
]);

export async function readAndValidatePackageManifest(
  root: string,
  plan: InstallPlan,
  verifyDigest = true,
): Promise<{ manifest: WuxianPiPackageManifest; manifestBytes: Buffer }> {
  const manifestPath = safePackagePath(root, plan.manifestPath);
  const manifestBytes = await readFile(manifestPath);
  const digest = createHash("sha256").update(manifestBytes).digest("hex");
  if (verifyDigest && digest !== plan.manifestDigest) {
    throw new RequestError("manifest_digest_mismatch", `Manifest SHA-256 mismatch: expected ${plan.manifestDigest}, got ${digest}`);
  }
  let manifest: WuxianPiPackageManifest;
  try { manifest = JSON.parse(manifestBytes.toString("utf8")) as WuxianPiPackageManifest; }
  catch { throw new RequestError("invalid_package_manifest", "wuxianpi-package.json is not valid JSON"); }
  await validatePackageManifest(root, manifest, plan);
  return { manifest, manifestBytes };
}

export async function validatePackageManifest(root: string, manifest: WuxianPiPackageManifest, plan?: InstallPlan): Promise<void> {
  if (!manifest || manifest.schemaVersion !== 1 || !PACKAGE_ID.test(manifest.id)) {
    throw new RequestError("invalid_package_manifest", "Package schemaVersion or id is invalid");
  }
  if (plan && (manifest.id !== plan.packageId || !COMMIT.test(plan.approvedCommit))) {
    throw new RequestError("package_identity_mismatch", "Package manifest does not match its install plan");
  }
  if (!manifest.name?.trim() || !manifest.version?.trim() || !manifest.summary?.trim()) {
    throw new RequestError("invalid_package_manifest", "Package name, version, and summary are required");
  }
  if (!Array.isArray(manifest.contributions) || manifest.contributions.length === 0) {
    throw new RequestError("invalid_package_manifest", "Package must declare at least one contribution");
  }
  if (!manifest.requires || !Array.isArray(manifest.requires.hostCapabilities) || !Array.isArray(manifest.requires.packages)) {
    throw new RequestError("invalid_package_manifest", "Package requirements are invalid");
  }
  validateBuild(manifest);
  const ids = new Set<string>();
  const artifacts = new Map<string, PackageArtifact>();
  for (const artifact of manifest.artifacts ?? []) {
    validateArtifact(manifest.id, artifact);
    if (ids.has(artifact.id)) throw new RequestError("duplicate_contribution", `Duplicate Package id: ${artifact.id}`);
    ids.add(artifact.id);
    artifacts.set(artifact.id, artifact);
  }
  for (const contribution of manifest.contributions) {
    validateContributionShape(manifest.id, contribution);
    if (ids.has(contribution.id)) throw new RequestError("duplicate_contribution", `Duplicate Package id: ${contribution.id}`);
    ids.add(contribution.id);
    await validateContributionFiles(root, contribution, artifacts);
  }
  for (const contribution of manifest.contributions) {
    if (contribution.type === "wuxianpi.assistantTemplate") {
      for (const binding of contribution.defaultBindings ?? []) {
        if (!ids.has(binding)) throw new RequestError("invalid_package_reference", `Assistant template references missing contribution: ${binding}`);
      }
    }
  }
  if (manifest.build.mode === "artifact") {
    for (const id of manifest.build.artifactIds) {
      if (!artifacts.has(id)) throw new RequestError("invalid_package_reference", `Build references missing artifact: ${id}`);
    }
  }
  if (plan) validatePlanArtifacts(manifest.artifacts, plan.artifacts);
}

export function safePackagePath(root: string, relativePath: string): string {
  if (!relativePath || relativePath.startsWith("/") || relativePath.includes("\\") || relativePath.split("/").includes("..")) {
    throw new RequestError("invalid_package_path", `Unsafe Package path: ${relativePath}`);
  }
  const rootPath = resolve(root);
  const target = resolve(rootPath, relativePath);
  if (target !== rootPath && !target.startsWith(`${rootPath}/`)) throw new RequestError("invalid_package_path", `Package path escapes root: ${relativePath}`);
  return target;
}

export async function readMcpContribution(root: string, contribution: PackageContribution): Promise<McpServerConfig> {
  if (!contribution.config) throw new RequestError("invalid_package_manifest", `MCP contribution ${contribution.id} has no config`);
  const value = JSON.parse(await readFile(safePackagePath(root, contribution.config), "utf8")) as McpServerConfig;
  validateMcp(value, contribution.id);
  return value;
}

export async function readServiceContribution(root: string, contribution: PackageContribution): Promise<Record<string, unknown>> {
  if (!contribution.manifest) throw new RequestError("invalid_package_manifest", `Service contribution ${contribution.id} has no manifest`);
  const value = JSON.parse(await readFile(safePackagePath(root, contribution.manifest), "utf8")) as unknown;
  return unwrapServiceManifest(value, contribution.id);
}

export function unwrapServiceManifest(value: unknown, contributionId = "service-manager.service"): Record<string, unknown> {
  validateCanonicalChildManifest("service", value, `Service manifest for ${contributionId}`);
  if (!isRecord(value) || !isRecord(value.service)) throw new RequestError("invalid_service_manifest", `Service manifest for ${contributionId} is invalid`);
  const serviceId = serviceIdOf(value.service);
  if (value.id !== serviceId) throw new RequestError("invalid_service_manifest", `Service manifest id ${value.id} does not match service name ${serviceId ?? "(missing)"}`);
  return value.service;
}

export function serviceIdOf(value: Record<string, unknown>): string | undefined {
  const id = typeof value.id === "string" ? value.id : typeof value.name === "string" ? value.name : undefined;
  return id?.trim() || undefined;
}

async function validateContributionFiles(root: string, contribution: PackageContribution, artifacts: Map<string, PackageArtifact>): Promise<void> {
  const path = contribution.path ?? contribution.config ?? contribution.manifest ?? contribution.basePath;
  if (path) {
    const target = safePackagePath(root, path);
    const info = await lstat(target).catch(() => undefined);
    if (!info) throw new RequestError("package_file_missing", `Contribution file does not exist: ${path}`);
    const [rootReal, targetReal] = await Promise.all([realpath(root), realpath(target)]);
    if (targetReal !== rootReal && !targetReal.startsWith(`${rootReal}/`)) {
      throw new RequestError("invalid_package_path", `Contribution path resolves outside Package: ${path}`);
    }
  }
  if (contribution.type === "pi.skill") {
    if (!contribution.path) throw new RequestError("invalid_package_manifest", `Skill ${contribution.id} needs path`);
    const skill = await readFile(join(safePackagePath(root, contribution.path), "SKILL.md"), "utf8").catch(() => "");
    const match = skill.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    let frontmatter: unknown;
    try { frontmatter = match?.[1] ? yaml.load(match[1]) : undefined; } catch { frontmatter = undefined; }
    const record = isRecord(frontmatter) ? frontmatter : {};
    if (typeof record.name !== "string" || record.name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(record.name) ||
        typeof record.description !== "string" || record.description.length === 0 || record.description.length > 1024) {
      throw new RequestError("invalid_skill", `Skill ${contribution.id} needs name and description frontmatter`);
    }
  }
  if (contribution.type === "mcp.server") await readMcpContribution(root, contribution);
  if (contribution.type === "wuxianpi.webExtension" || contribution.type === "wuxianpi.renderer") {
    await validateWebManifest(root, contribution);
  }
  if (contribution.type === "wuxianpi.assistantTemplate") await validateAssistantTemplate(root, contribution);
  if (contribution.type === "wuxianpi.experience") validateExperience(contribution);
  if (contribution.type === "openhouse.app") await validateOpenHouseManifest(root, contribution);
  if (contribution.type === "service-manager.service") {
    await readServiceContribution(root, contribution);
  }
  if (contribution.type === "artifact" && (!contribution.artifactId || !artifacts.has(contribution.artifactId))) {
    throw new RequestError("invalid_package_reference", `Artifact contribution ${contribution.id} references a missing artifact`);
  }
}

function validateContributionShape(packageId: string, contribution: PackageContribution): void {
  if (!contribution || !CONTRIBUTION_ID.test(contribution.id) || !contribution.id.startsWith(`${packageId}/`)) {
    throw new RequestError("invalid_contribution", `Contribution id is invalid or outside Package namespace: ${contribution?.id ?? "(missing)"}`);
  }
  if (!CONTRIBUTION_TYPES.has(contribution.type) || !contribution.name?.trim()) {
    throw new RequestError("invalid_contribution", `Contribution ${contribution.id} has invalid type or name`);
  }
  const requiresPath = ["pi.extension", "pi.skill", "pi.prompt", "pi.theme"].includes(contribution.type);
  if (requiresPath && !contribution.path) throw new RequestError("invalid_contribution", `${contribution.type} ${contribution.id} requires path`);
  if (contribution.type === "mcp.server" && !contribution.config) throw new RequestError("invalid_contribution", `MCP ${contribution.id} requires config`);
  if (["wuxianpi.webExtension", "wuxianpi.renderer", "wuxianpi.assistantTemplate", "openhouse.app", "service-manager.service"].includes(contribution.type) && !contribution.manifest) {
    throw new RequestError("invalid_contribution", `${contribution.type} ${contribution.id} requires manifest`);
  }
  if (contribution.type === "wuxianpi.experience" && (!contribution.basePath || !contribution.experienceSpaceId || !contribution.mainstream || !contribution.updatePolicy)) {
    throw new RequestError("invalid_contribution", `Experience ${contribution.id} is incomplete`);
  }
  if (contribution.type === "wuxianpi.renderer" && (!Array.isArray(contribution.contentTypes) || contribution.contentTypes.length === 0 || contribution.contentTypes.some((value) => !CAPABILITY_ID.test(value)))) {
    throw new RequestError("invalid_contribution", `Renderer ${contribution.id} requires valid contentTypes`);
  }
  if (contribution.type === "wuxianpi.assistantTemplate" &&
      (!(["main", "functional"] as unknown[]).includes(contribution.kind) || !Array.isArray(contribution.defaultBindings))) {
    throw new RequestError("invalid_contribution", `Assistant template ${contribution.id} requires kind and defaultBindings`);
  }
  if (contribution.type === "wuxianpi.context" && !["markdown", "json", "directory"].includes(contribution.format ?? "")) {
    throw new RequestError("invalid_contribution", `Context ${contribution.id} requires a valid format`);
  }
}

function validateBuild(manifest: WuxianPiPackageManifest): void {
  if (!manifest.build || !["none", "local", "artifact"].includes(manifest.build.mode)) {
    throw new RequestError("invalid_package_manifest", "Package build mode is invalid");
  }
  if (manifest.build.mode === "local" && !manifest.build.commands?.build?.command) {
    throw new RequestError("invalid_package_manifest", "Local build mode requires a build command");
  }
}

function validateArtifact(packageId: string, artifact: PackageArtifact): void {
  if (!artifact.id?.startsWith(`${packageId}/`) || !SHA256.test(artifact.sha256) || artifact.sizeBytes < 1 || !artifact.fileName) {
    throw new RequestError("invalid_artifact", `Artifact ${artifact.id ?? "(missing)"} is invalid`);
  }
  safePackagePath("/tmp/wuxianpi-package", artifact.fileName);
  if (!Array.isArray(artifact.sources) || artifact.sources.length === 0) throw new RequestError("invalid_artifact", `Artifact ${artifact.id} has no sources`);
}

function validatePlanArtifacts(manifestArtifacts: PackageArtifact[], planArtifacts: PackageArtifact[]): void {
  const planById = new Map((planArtifacts ?? []).map((artifact) => [artifact.id, artifact]));
  for (const artifact of manifestArtifacts) {
    const planned = planById.get(artifact.id);
    if (!planned || planned.sha256 !== artifact.sha256 || planned.sizeBytes !== artifact.sizeBytes || planned.fileName !== artifact.fileName) {
      throw new RequestError("artifact_plan_mismatch", `Install plan does not match artifact ${artifact.id}`);
    }
  }
}

function validateMcp(value: McpServerConfig, contributionId: string): void {
  validateCanonicalChildManifest("mcp", value, `MCP contribution ${contributionId}`);
}

const CAPABILITY_ID = /^[a-z][a-z0-9]*(?:[._/-][a-z0-9]+)*$/;

async function validateWebManifest(root: string, contribution: PackageContribution): Promise<void> {
  const { value, path } = await readChildManifest(root, contribution);
  validateCanonicalChildManifest("web", value, `${contribution.type} ${contribution.id}`);
  const manifestRoot = dirname(path);
  const entries = new Set<string>();
  if (typeof value.entry === "string") entries.add(value.entry);
  if (isRecord(value.contributes)) {
    for (const items of Object.values(value.contributes)) {
      if (!Array.isArray(items)) continue;
      for (const item of items) if (isRecord(item) && typeof item.entry === "string") entries.add(item.entry);
    }
  }
  if (entries.size === 0) throw new RequestError("invalid_web_manifest", `${contribution.type} ${contribution.id} does not expose an entry`);
  if (contribution.type === "wuxianpi.renderer" &&
      (!isRecord(value.contributes) || !Array.isArray(value.contributes.toolRenderers) || value.contributes.toolRenderers.length === 0)) {
    throw new RequestError("invalid_renderer_manifest", `Renderer ${contribution.id} has no toolRenderers contribution`);
  }
  for (const entry of entries) {
    const target = safePackagePath(manifestRoot, entry);
    const info = await lstat(target).catch(() => undefined);
    if (!info?.isFile()) throw new RequestError("invalid_web_extension_manifest", `Web manifest entry does not exist: ${entry}`);
  }
}

async function validateAssistantTemplate(root: string, contribution: PackageContribution): Promise<void> {
  const { value } = await readChildManifest(root, contribution);
  validateCanonicalChildManifest("assistant", value, `Assistant template ${contribution.id}`);
}

function validateExperience(contribution: PackageContribution): void {
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(contribution.experienceSpaceId ?? "")) throw new RequestError("invalid_experience_manifest", `Experience ${contribution.id} has an invalid space id`);
  const source = contribution.mainstream;
  if (!source || !isHttpsUrl(source.url) || (source.type === "git" && (!source.ref?.trim() || !source.path?.trim()))) {
    throw new RequestError("invalid_experience_manifest", `Experience ${contribution.id} has an invalid mainstream source`);
  }
  if (source.type === "git") safePackagePath("/tmp/wuxianpi-experience", source.path);
  const policy = contribution.updatePolicy;
  if (!policy || policy.strategy !== "three-way-merge" || policy.localCorrections !== "preserve" ||
      JSON.stringify(policy.priority) !== JSON.stringify(["local-verified-correction", "mainstream", "package-base"])) {
    throw new RequestError("invalid_experience_manifest", `Experience ${contribution.id} has an unsupported update policy`);
  }
}

async function validateOpenHouseManifest(root: string, contribution: PackageContribution): Promise<void> {
  const { value } = await readChildManifest(root, contribution);
  validateCanonicalChildManifest("openhouse", value, `OpenHouse app ${contribution.id}`);
}

async function readChildManifest(root: string, contribution: PackageContribution): Promise<{ value: Record<string, unknown>; path: string }> {
  const path = safePackagePath(root, contribution.manifest!);
  let value: unknown;
  try { value = JSON.parse(await readFile(path, "utf8")); }
  catch { throw new RequestError("invalid_child_manifest", `Child manifest for ${contribution.id} is not valid JSON`); }
  if (!isRecord(value)) throw new RequestError("invalid_child_manifest", `Child manifest for ${contribution.id} must be an object`);
  return { value, path };
}

function isHttpsUrl(value: string): boolean { try { return new URL(value).protocol === "https:"; } catch { return false; } }

export async function readDirectoryContext(path: string, maxBytes = 512 * 1024): Promise<string> {
  const info = await lstat(path);
  if (info.isFile()) return (await readFile(path, "utf8")).slice(0, maxBytes);
  if (!info.isDirectory()) return "";
  const chunks: string[] = [];
  let size = 0;
  const visit = async (directory: string): Promise<void> => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (size >= maxBytes || entry.isSymbolicLink()) continue;
      const target = join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile() && [".md", ".txt", ".json"].some((suffix) => entry.name.endsWith(suffix))) {
        const text = await readFile(target, "utf8");
        const chunk = `\n\n# ${target.slice(dirname(path).length + 1)}\n\n${text}`.slice(0, maxBytes - size);
        chunks.push(chunk);
        size += Buffer.byteLength(chunk);
      }
    }
  };
  await visit(path);
  return chunks.join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
