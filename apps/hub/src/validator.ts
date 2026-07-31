import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import Ajv2020Import, { type ValidateFunction } from "ajv/dist/2020.js";
import yaml from "js-yaml";
import type { PackageManifest, PackagePresentationMetadata, VerificationOutput } from "./types.js";
import type { DownloadVerifier } from "./metadata.js";
import { verifyArtifact, verifyScreenshot } from "./metadata.js";
import type { VerifiedAssetStore } from "./metadata.js";
import {
  ASSISTANT_TEMPLATE_SCHEMA,
  OPENHOUSE_APP_SCHEMA,
  SERVICE_MANAGER_SCHEMA,
  WEB_EXTENSION_SCHEMA,
} from "./child-manifests.js";

interface ValidationOptions {
  schema: object;
  downloader: DownloadVerifier;
  assetStore: VerifiedAssetStore;
  maxDownloadBytes: number;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const Ajv2020 = Ajv2020Import as unknown as new (options?: Record<string, unknown>) => {
  compile(schema: object): ValidateFunction;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function formatAjv(validate: ValidateFunction): string {
  return (validate.errors ?? []).map((item) => `${item.instancePath || "/"} ${item.message ?? "is invalid"}`).join("; ");
}

async function resolvePackagePath(root: string, packagePath: string): Promise<string> {
  assert(!isAbsolute(packagePath), `Absolute Package path is forbidden: ${packagePath}`);
  const target = resolve(root, packagePath);
  const rel = relative(root, target);
  assert(rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel), `Package path escapes repository: ${packagePath}`);
  await lstat(target);
  const actualRoot = await realpath(root);
  const actualTarget = await realpath(target);
  const actualRel = relative(actualRoot, actualTarget);
  assert(actualRel !== ".." && !actualRel.startsWith(`..${sep}`) && !isAbsolute(actualRel), `Package path resolves outside repository: ${packagePath}`);
  return target;
}

async function validateSkill(root: string, path: string): Promise<void> {
  const directory = await resolvePackagePath(root, path);
  const content = await readFile(join(directory, "SKILL.md"), "utf8");
  const match = content.match(FRONTMATTER);
  assert(match?.[1], `Skill ${path} is missing YAML frontmatter`);
  const frontmatter = yaml.load(match[1]);
  assert(frontmatter && typeof frontmatter === "object" && !Array.isArray(frontmatter), `Skill ${path} frontmatter is invalid`);
  const record = frontmatter as Record<string, unknown>;
  assert(typeof record.name === "string" && record.name.length <= 64 && SKILL_NAME.test(record.name), `Skill ${path} has an invalid name`);
  assert(typeof record.description === "string" && record.description.length > 0 && record.description.length <= 1024, `Skill ${path} has an invalid description`);
}

export class PackageValidator {
  private readonly validateManifest: ValidateFunction;
  private readonly validateMcp: ValidateFunction;
  private readonly validateWebExtension: ValidateFunction;
  private readonly validateAssistantTemplate: ValidateFunction;
  private readonly validateOpenHouseApp: ValidateFunction;
  private readonly validateServiceManager: ValidateFunction;

  constructor(private readonly options: ValidationOptions) {
    const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
    this.validateManifest = ajv.compile(options.schema);
    const defs = (options.schema as { $defs?: Record<string, unknown> }).$defs;
    assert(defs?.mcpServerConfig, "Package Schema is missing $defs.mcpServerConfig");
    this.validateMcp = ajv.compile({ $defs: defs, $ref: "#/$defs/mcpServerConfig" });
    this.validateWebExtension = ajv.compile(WEB_EXTENSION_SCHEMA);
    this.validateAssistantTemplate = ajv.compile(ASSISTANT_TEMPLATE_SCHEMA);
    this.validateOpenHouseApp = ajv.compile(OPENHOUSE_APP_SCHEMA);
    this.validateServiceManager = ajv.compile(SERVICE_MANAGER_SCHEMA);
  }

  async verify(directory: string, metadata: PackagePresentationMetadata): Promise<VerificationOutput> {
    const checks: string[] = ["commit"];
    const manifestPath = join(directory, "wuxianpi-package.json");
    const manifestBytes = await readFile(manifestPath);
    let manifest: PackageManifest;
    try {
      manifest = JSON.parse(manifestBytes.toString("utf8")) as PackageManifest;
    } catch {
      throw new Error("wuxianpi-package.json is not valid JSON");
    }
    if (!this.validateManifest(manifest)) throw new Error(`Package manifest failed Schema validation: ${formatAjv(this.validateManifest)}`);
    checks.push("manifest-schema");

    const ids = new Set<string>();
    let childManifestCount = 0;
    const artifactIds = new Set(manifest.artifacts.map((artifact) => artifact.id));
    for (const artifact of manifest.artifacts) {
      assert(artifact.id.startsWith(`${manifest.id}/`), `Artifact ID is outside Package namespace: ${artifact.id}`);
      assert(!ids.has(artifact.id), `Duplicate Package ID: ${artifact.id}`);
      ids.add(artifact.id);
    }

    for (const contribution of manifest.contributions) {
      assert(contribution.id.startsWith(`${manifest.id}/`), `Contribution ID is outside Package namespace: ${contribution.id}`);
      assert(!ids.has(contribution.id), `Duplicate Package ID: ${contribution.id}`);
      ids.add(contribution.id);
      for (const key of ["path", "config", "manifest", "basePath"] as const) {
        const packagePath = contribution[key];
        if (typeof packagePath === "string") await resolvePackagePath(directory, packagePath);
      }
      if (contribution.type === "pi.skill") {
        assert(typeof contribution.path === "string", `Skill ${contribution.id} has no path`);
        await validateSkill(directory, contribution.path);
      }
      if (contribution.type === "mcp.server") {
        assert(typeof contribution.config === "string", `MCP ${contribution.id} has no config`);
        const child = JSON.parse(await readFile(join(directory, contribution.config), "utf8")) as unknown;
        if (!this.validateMcp(child)) throw new Error(`MCP ${contribution.id} failed Schema validation: ${formatAjv(this.validateMcp)}`);
        childManifestCount += 1;
      }
      if (contribution.type === "wuxianpi.webExtension" || contribution.type === "wuxianpi.renderer") {
        assert(typeof contribution.manifest === "string", `${contribution.type} ${contribution.id} has no manifest`);
        const child = await this.readChildJson(directory, contribution.manifest, contribution.id);
        if (!this.validateWebExtension(child)) throw new Error(`${contribution.type} ${contribution.id} failed Web Extension Schema validation: ${formatAjv(this.validateWebExtension)}`);
        const web = child as {
          entry?: string;
          contributes?: Record<string, Array<{ entry?: string }>>;
        };
        const entries = [
          web.entry,
          ...Object.values(web.contributes ?? {}).flatMap((items) => items.map((item) => item.entry)),
        ].filter((entry): entry is string => typeof entry === "string");
        assert(entries.length > 0, `${contribution.type} ${contribution.id} does not expose an entry`);
        for (const entry of entries) {
          await resolvePackagePath(directory, join(dirname(contribution.manifest), entry));
        }
        if (contribution.type === "wuxianpi.renderer") {
          assert((web.contributes?.toolRenderers?.length ?? 0) > 0, `Renderer ${contribution.id} has no toolRenderers contribution`);
        }
        childManifestCount += 1;
      }
      if (contribution.type === "wuxianpi.assistantTemplate") {
        assert(typeof contribution.manifest === "string", `Assistant template ${contribution.id} has no manifest`);
        const child = await this.readChildJson(directory, contribution.manifest, contribution.id);
        if (!this.validateAssistantTemplate(child)) throw new Error(`Assistant template ${contribution.id} failed Schema validation: ${formatAjv(this.validateAssistantTemplate)}`);
        childManifestCount += 1;
      }
      if (contribution.type === "openhouse.app") {
        assert(typeof contribution.manifest === "string", `OpenHouse App ${contribution.id} has no manifest`);
        const child = await this.readChildJson(directory, contribution.manifest, contribution.id);
        if (!this.validateOpenHouseApp(child)) throw new Error(`OpenHouse App ${contribution.id} failed Schema validation: ${formatAjv(this.validateOpenHouseApp)}`);
        childManifestCount += 1;
      }
      if (contribution.type === "service-manager.service") {
        assert(typeof contribution.manifest === "string", `Service ${contribution.id} has no manifest`);
        const child = await this.readChildJson(directory, contribution.manifest, contribution.id);
        if (!this.validateServiceManager(child)) throw new Error(`Service ${contribution.id} failed Schema validation: ${formatAjv(this.validateServiceManager)}`);
        const serviceManifest = child as { id: string; service: { name: string } };
        assert(
          serviceManifest.id === serviceManifest.service.name,
          `Service ${contribution.id} wrapper id ${serviceManifest.id} must equal service.name ${serviceManifest.service.name}`,
        );
        childManifestCount += 1;
      }
      if (contribution.type === "wuxianpi.assistantTemplate") {
        for (const binding of contribution.defaultBindings ?? []) {
          assert(manifest.contributions.some((item) => item.id === binding), `Assistant binding does not exist: ${binding}`);
        }
      }
      if (contribution.type === "artifact") {
        assert(typeof contribution.artifactId === "string" && artifactIds.has(contribution.artifactId), `Artifact contribution references an unknown artifact: ${contribution.artifactId ?? "missing"}`);
      }
    }

    const build = manifest.build as { mode?: string; artifactIds?: string[] };
    if (build.mode === "artifact") {
      for (const artifactId of build.artifactIds ?? []) assert(artifactIds.has(artifactId), `Build references an unknown artifact: ${artifactId}`);
    }
    checks.push("paths", "references");
    if (childManifestCount > 0) checks.push("child-manifests");

    for (const screenshot of metadata.screenshots) {
      const bytes = await verifyScreenshot(screenshot, this.options.downloader, this.options.maxDownloadBytes);
      await this.options.assetStore.put(screenshot.sha256, screenshot.mediaType, bytes);
    }
    if (metadata.screenshots.length > 0) checks.push("screenshots");

    for (const artifact of manifest.artifacts) {
      await verifyArtifact(artifact, this.options.downloader, this.options.maxDownloadBytes);
    }
    if (manifest.artifacts.length > 0) checks.push("artifact-digests");

    return {
      manifest,
      manifestDigest: createHash("sha256").update(manifestBytes).digest("hex"),
      verification: {
        status: "passed",
        verifiedAt: new Date().toISOString(),
        checks,
      },
      diagnostics: [],
    };
  }

  private async readChildJson(root: string, packagePath: string, contributionId: string): Promise<unknown> {
    const path = await resolvePackagePath(root, packagePath);
    try {
      return JSON.parse(await readFile(path, "utf8")) as unknown;
    } catch {
      throw new Error(`Child manifest for ${contributionId} is not valid JSON`);
    }
  }
}
