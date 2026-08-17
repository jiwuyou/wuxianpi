import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { FunctionalAssistantStorage } from "./functional-assistant-storage.js";
import { createFunctionalAssistantStateTool } from "./functional-assistant-tool.js";
import { StandardMcpConfigStore, type McpServerConfig } from "./mcp-config.js";
import { MarketClient, validateInstallPlan } from "./market-client.js";
import { createMarketplaceTools } from "./marketplace-tool.js";
import { PackageArtifactManager } from "./package-artifacts.js";
import { PackageBuildRunner } from "./package-build.js";
import { PackageExperienceManager } from "./package-experience.js";
import { PackageGitRepository } from "./package-git.js";
import { AtomicPackageStateStore, PackageOperationLog, removeIfExists, writeAtomicJson } from "./package-storage.js";
import type {
  ActiveContributionRecord, AssistantPackageBinding, InstallPlan, InstalledPackageState,
  FunctionalAssistantBindingSettings, FunctionalAssistantSharingMode, PackageContribution, PackageExecutionContext,
  InitialAssistantBinding, PackageManagerState, PackageOperationEvent, ResolvedAssistantPackageResources, ResolvedFunctionalAssistant,
  WuxianPiPackageManifest,
} from "./package-types.js";
import {
  readAndValidatePackageManifest, readDirectoryContext, readMcpContribution, readServiceContribution,
  safePackagePath, serviceIdOf, validatePackageManifest,
} from "./package-validator.js";
import { RequestError } from "./protocol.js";
import { SelfOperationJournal, type SelfOperationRecord } from "./self-operation-journal.js";
import { ServiceManagerClient, type PackageServiceBridge } from "./service-manager-client.js";

export interface WuxianPiPackageManagerOptions {
  rootDir?: string;
  functionalAssistantRoot?: string;
  agentDir: string;
  mcpConfigPath?: string;
  marketClient?: MarketClient;
  git?: PackageGitRepository;
  artifacts?: PackageArtifactManager;
  buildRunner?: PackageBuildRunner;
  experienceManager?: PackageExperienceManager;
  serviceBridge?: PackageServiceBridge;
  maintenanceRoot?: string;
  hostCapabilities?: Array<{ id: string; contractVersion: number }>;
  initialExecutionContext?: Partial<Omit<PackageExecutionContext, "updatedAt">>;
}

export class WuxianPiPackageManager {
  readonly rootDir: string;
  readonly marketClient: MarketClient;
  readonly store: AtomicPackageStateStore;
  readonly operationLog: PackageOperationLog;
  readonly selfJournal: SelfOperationJournal;
  readonly mcpConfig: StandardMcpConfigStore;
  readonly functionalAssistantStorage: FunctionalAssistantStorage;
  private readonly agentDir: string;
  private readonly git: PackageGitRepository;
  private readonly artifacts: PackageArtifactManager;
  private readonly buildRunner: PackageBuildRunner;
  private readonly experienceManager: PackageExperienceManager;
  private readonly serviceBridge: PackageServiceBridge;
  private readonly hostCapabilities: Array<{ id: string; contractVersion: number }>;
  private readonly initialExecutionContext: PackageExecutionContext;
  private readonly executionContextPath: string;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(options: WuxianPiPackageManagerOptions) {
    this.agentDir = options.agentDir;
    this.rootDir = options.rootDir ?? join(homedir(), ".wuxianpi", "package-manager");
    this.marketClient = options.marketClient ?? new MarketClient();
    this.git = options.git ?? new PackageGitRepository();
    this.artifacts = options.artifacts ?? new PackageArtifactManager();
    this.buildRunner = options.buildRunner ?? new PackageBuildRunner();
    this.experienceManager = options.experienceManager ?? new PackageExperienceManager();
    this.serviceBridge = options.serviceBridge ?? new ServiceManagerClient();
    this.store = new AtomicPackageStateStore(join(this.rootDir, "state.json"));
    this.operationLog = new PackageOperationLog(join(this.rootDir, "logs", "operations.jsonl"));
    this.selfJournal = new SelfOperationJournal(options.maintenanceRoot ?? join(homedir(), ".smallphoneai", "maintenance"));
    this.mcpConfig = new StandardMcpConfigStore(options.mcpConfigPath);
    this.functionalAssistantStorage = new FunctionalAssistantStorage(options.functionalAssistantRoot ?? join(this.rootDir, "functional-assistants"));
    this.hostCapabilities = options.hostCapabilities ?? defaultHostCapabilities();
    this.executionContextPath = join(this.rootDir, "execution-context.json");
    this.initialExecutionContext = normalizeExecutionContext(options.initialExecutionContext ?? {});
  }

  marketPackages(query: URLSearchParams | Record<string, string | number | undefined> = {}): Promise<Record<string, unknown>> {
    return this.marketClient.listPackages(query);
  }

  marketPackage(packageId: string): Promise<Record<string, unknown>> { return this.marketClient.packageDetail(packageId); }
  marketReleases(packageId: string, query: URLSearchParams = new URLSearchParams()): Promise<Record<string, unknown>> {
    return this.marketClient.releases(packageId, query);
  }
  marketInstallPlan(packageId: string, releaseId?: string): Promise<InstallPlan> {
    return this.marketClient.installPlan(packageId, { releaseId, hostCapabilities: this.hostCapabilities });
  }

  submitMarketPackage(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.marketClient.submitPackage(input);
  }

  async executionContext(): Promise<PackageExecutionContext> {
    try {
      return normalizeExecutionContext(JSON.parse(await readFile(this.executionContextPath, "utf8")) as Partial<PackageExecutionContext>);
    } catch (error) {
      if (isMissing(error)) return this.initialExecutionContext;
      throw error;
    }
  }

  async setExecutionContext(input: Partial<Omit<PackageExecutionContext, "updatedAt">>): Promise<PackageExecutionContext> {
    const context = normalizeExecutionContext(input);
    await writeAtomicJson(this.executionContextPath, context);
    return context;
  }

  async listExperiences(assistantId?: string): Promise<Array<Record<string, unknown>>> {
    const state = await this.store.read();
    const binding = assistantId ? state.assistantBindings[assistantId] : undefined;
    const selected = resolveAssistantSelection(state, binding).resolvedContributionIds;
    const rows: Array<Record<string, unknown>> = [];
    for (const record of Object.values(state.contributions)) {
      const contribution = record.contribution;
      if (!record.enabled || contribution.type !== "wuxianpi.experience" || !contribution.experienceSpaceId) continue;
      if (assistantId && !selected.has(record.id)) continue;
      const installed = requireInstalled(state, record.packageId);
      const experienceSpaceId = binding?.experienceSpaces[record.id] ?? contribution.experienceSpaceId;
      const root = this.experienceRoot(installed, experienceSpaceId);
      rows.push({
        ...(await this.experienceManager.readState({
          root, packageId: record.packageId, contributionId: record.id, experienceSpaceId,
        })),
        source: contribution.mainstream,
        updatePolicy: contribution.updatePolicy,
      });
    }
    return rows;
  }

  updateExperience(contributionId: string, experienceSpaceId?: string) {
    return this.mutate(() => this.runOperation("update-experience", undefined, async () => {
      const state = await this.store.read();
      const record = state.contributions[contributionId];
      if (!record?.enabled || record.contribution.type !== "wuxianpi.experience" || !record.contribution.mainstream || !record.contribution.experienceSpaceId) {
        throw new RequestError("experience_not_found", `Enabled experience contribution not found: ${contributionId}`);
      }
      const space = experienceSpaceId ?? record.contribution.experienceSpaceId;
      assertExperienceSpaceId(space);
      const installed = requireInstalled(state, record.packageId);
      return this.experienceManager.update({
        root: this.experienceRoot(installed, space),
        packageId: record.packageId,
        contributionId,
        experienceSpaceId: space,
        source: record.contribution.mainstream,
      });
    }));
  }

  async listInstalled(): Promise<Array<Record<string, unknown>>> {
    const state = await this.store.read();
    return Promise.all(Object.values(state.packages).sort((left, right) => left.name.localeCompare(right.name))
      .map((item) => this.localPackageView(state, item)));
  }

  async packageDataPath(packageId: string): Promise<string> {
    const state = await this.store.read();
    const installed = state.packages[packageId];
    if (!installed) throw new RequestError("package_not_found", `Package is not installed: ${packageId}`);
    await mkdir(installed.dataPath, { recursive: true, mode: 0o700 });
    return installed.dataPath;
  }

  async isPackageEnabled(packageId: string): Promise<boolean> {
    const state = await this.store.read();
    const installed = state.packages[packageId];
    return Boolean(installed && installed.enabledContributionIds.length > 0);
  }

  async listActiveRuntimeContributions(): Promise<Array<{
    packageId: string;
    contributionId: string;
    packageVersion: string;
    dataPath: string;
    runtimePath: string;
  }>> {
    const state = await this.store.read();
    return Object.values(state.contributions).flatMap((record) => {
      if (!record.enabled || record.contribution.type !== "wuxianpi.runtime" || !record.contribution.path) return [];
      const installed = state.packages[record.packageId];
      if (!installed) return [];
      return [{
        packageId: record.packageId,
        contributionId: record.id,
        packageVersion: installed.version,
        dataPath: installed.dataPath,
        runtimePath: safePackagePath(record.revisionPath, record.contribution.path),
      }];
    });
  }

  async detail(packageId: string): Promise<Record<string, unknown>> {
    const state = await this.store.read();
    const installed = state.packages[packageId];
    if (!installed) throw new RequestError("package_not_found", `Package is not installed: ${packageId}`);
    return this.localPackageView(state, installed, {
      ...packageSummary(installed),
      location: this.packageLocation(installed),
      manifest: installed.manifest,
      installPlan: installed.installPlan,
      ...(installed.sourceKind === "bundled" ? { bundled: true } : { git: {
        sourcePath: installed.sourcePath,
        baseCommit: installed.baseCommit,
        localHead: installed.localHead,
        targetCommit: installed.targetCommit,
        status: await this.git.status(installed.sourcePath),
        conflicts: await this.git.conflicts(installed.sourcePath),
      } }),
    });
  }

  async ensureBundledPackage(sourceRootValue: string): Promise<Record<string, unknown>> {
    const sourceRoot = resolve(sourceRootValue);
    const manifestPath = join(sourceRoot, "wuxianpi-package.json");
    const manifestBytes = await readFile(manifestPath);
    let manifest: WuxianPiPackageManifest;
    try { manifest = JSON.parse(manifestBytes.toString("utf8")) as WuxianPiPackageManifest; }
    catch { throw new RequestError("invalid_package_manifest", `Bundled Package manifest is invalid: ${manifestPath}`); }
    await validatePackageManifest(sourceRoot, manifest);
    this.validateHostCapabilities(manifest);
    if (manifest.build.mode !== "none" || manifest.requires.packages.length > 0) {
      throw new RequestError("invalid_bundled_package", "Bundled Packages must use build.mode=none and cannot depend on market Packages");
    }
    const digest = await digestDirectory(sourceRoot);
    const manifestDigest = createHash("sha256").update(manifestBytes).digest("hex");
    const revisionId = `bundled-${digest.slice(0, 16)}`;
    const commit = digest.slice(0, 40);
    const paths = this.paths(manifest.id);
    const revisionPath = join(paths.revisions, revisionId);
    try {
      await lstat(revisionPath);
    } catch (error) {
      if (!isMissing(error)) throw error;
      const candidate = join(paths.candidates, `${revisionId}-${randomUUID().slice(0, 8)}`);
      await mkdir(dirname(candidate), { recursive: true, mode: 0o700 });
      await cp(sourceRoot, candidate, { recursive: true, force: true });
      await validatePackageManifest(candidate, manifest);
      await mkdir(paths.revisions, { recursive: true, mode: 0o700 });
      await rename(candidate, revisionPath);
    }
    const now = new Date().toISOString();
    const installPlan: InstallPlan = {
      schemaVersion: 1,
      packageId: manifest.id,
      releaseId: `bundled:${manifest.version}`,
      version: manifest.version,
      approvedCommit: commit,
      manifestPath: "wuxianpi-package.json",
      manifestDigest,
      gitSources: [],
      artifacts: manifest.artifacts,
      compatibility: manifest.requires,
      verification: { status: "bundled", verifiedAt: now, checks: ["runtime-distribution"] },
      revoked: false,
    };
    await this.store.update((state) => {
      const existing = state.packages[manifest.id];
      if (existing && existing.sourceKind !== "bundled") {
        throw new RequestError("package_source_conflict", `A non-bundled Package already uses id ${manifest.id}`);
      }
      const previousEnabled = new Map(Object.values(state.contributions)
        .filter((record) => record.packageId === manifest.id)
        .map((record) => [record.id, record.enabled]));
      for (const [id, record] of Object.entries(state.contributions)) {
        if (record.packageId === manifest.id) delete state.contributions[id];
      }
      const enabledContributionIds: string[] = [];
      for (const contribution of manifest.contributions) {
        const enabled = previousEnabled.get(contribution.id) ?? true;
        state.contributions[contribution.id] = {
          id: contribution.id,
          packageId: manifest.id,
          revisionId,
          revisionPath,
          enabled,
          contribution,
        };
        if (enabled) enabledContributionIds.push(contribution.id);
      }
      for (const binding of Object.values(state.assistantBindings)) {
        binding.enabledContributionIds = binding.enabledContributionIds.filter((id) => state.contributions[id] !== undefined);
      }
      state.packages[manifest.id] = {
        packageId: manifest.id,
        name: manifest.name,
        version: manifest.version,
        sourcePath: sourceRoot,
        dataPath: paths.data,
        baseCommit: commit,
        localHead: commit,
        targetCommit: commit,
        activeRevisionId: revisionId,
        knownGoodRevisionId: revisionId,
        sourceStatus: "ready",
        manifest,
        installPlan,
        enabledContributionIds,
        installedAt: existing?.installedAt ?? now,
        updatedAt: now,
        sourceKind: "bundled",
      };
    });
    const state = await this.store.read();
    await this.writeActiveRegistry(state);
    return this.localPackageView(state, requireInstalled(state, manifest.id));
  }

  ensurePreinstalledPackage(
    sourceRootValue: string,
    installPlan: InstallPlan,
    initialBindings: InitialAssistantBinding[],
    distributionId: string,
  ): Promise<Record<string, unknown>> {
    return this.mutate(() => this.runOperation("preinstall", installPlan.packageId, async (operationId) => {
      assertDistributionId(distributionId);
      validateInstallPlan(installPlan, installPlan.packageId);
      const existing = (await this.store.read()).packages[installPlan.packageId];
      if (existing && !(existing.sourceKind === "preinstalled" && !existing.activeRevisionId)) {
        if (existing.sourceKind === "preinstalled" && existing.activeRevisionId && !existing.preinstalled?.initialBindingsAppliedAt) {
          await this.applyInitialPreinstalledBindings(existing.packageId, initialBindings);
        }
        const state = await this.store.read();
        return this.localPackageView(state, requireInstalled(state, installPlan.packageId));
      }
      if (installPlan.artifacts.length > 0 || installPlan.compatibility.packages.length > 0) {
        throw new RequestError("invalid_preinstalled_package", "Preinstalled Package v1 does not support artifacts or Package dependencies");
      }
      const sourceRoot = resolve(sourceRootValue);
      const head = await this.git.revParse(sourceRoot, "HEAD").catch(() => "");
      if (head !== installPlan.approvedCommit) {
        throw new RequestError("preinstalled_commit_mismatch", `Preinstalled Package HEAD does not match ${installPlan.approvedCommit}`);
      }
      const dirty = await this.git.status(sourceRoot).catch(() => ["invalid Git worktree"]);
      if (dirty.length > 0) {
        throw new RequestError("preinstalled_source_dirty", "Preinstalled Package source must be a clean Git worktree", { status: dirty });
      }
      const { manifest } = await readAndValidatePackageManifest(sourceRoot, installPlan);
      this.validateHostCapabilities(manifest);
      if (manifest.build.mode !== "none") {
        throw new RequestError("invalid_preinstalled_package", "Preinstalled Package v1 requires build.mode=none");
      }
      validateInitialBindings(manifest, initialBindings);
      const paths = this.paths(manifest.id);
      await removeIfExists(paths.source);
      await mkdir(dirname(paths.source), { recursive: true, mode: 0o700 });
      await cp(sourceRoot, paths.source, { recursive: true, force: true });
      const copiedHead = await this.git.revParse(paths.source, "HEAD").catch(() => "");
      if (copiedHead !== installPlan.approvedCommit || (await this.git.status(paths.source)).length > 0) {
        await removeIfExists(paths.source);
        throw new RequestError("preinstalled_copy_invalid", "Copied preinstalled Package did not preserve its verified Git state");
      }
      await readAndValidatePackageManifest(paths.source, installPlan);
      const now = new Date().toISOString();
      await this.store.update((state) => {
        state.packages[manifest.id] = {
          packageId: manifest.id,
          name: manifest.name,
          version: manifest.version,
          sourcePath: paths.source,
          dataPath: paths.data,
          baseCommit: installPlan.approvedCommit,
          localHead: copiedHead,
          targetCommit: installPlan.approvedCommit,
          sourceStatus: "candidate_ready",
          manifest,
          installPlan,
          enabledContributionIds: [],
          installedAt: now,
          updatedAt: now,
          sourceKind: "preinstalled",
          preinstalled: {
            distributionId,
            seedReleaseId: installPlan.releaseId,
            seedCommit: installPlan.approvedCommit,
            importedAt: now,
          },
        };
      });
      await this.activateSource(requireInstalled(await this.store.read(), manifest.id), installPlan, operationId, "Import preinstalled Package");
      await this.applyInitialPreinstalledBindings(manifest.id, initialBindings);
      const state = await this.store.read();
      return this.localPackageView(state, requireInstalled(state, manifest.id));
    }));
  }

  install(packageId: string, releaseId?: string): Promise<Record<string, unknown>> {
    return this.mutate(() => this.runOperation("install", packageId, (operationId) => this.installInternal(packageId, releaseId, operationId, new Set())));
  }

  update(packageId: string, releaseId?: string): Promise<Record<string, unknown>> {
    return this.mutate(() => this.runOperation("update", packageId, (operationId) => this.updateInternal(packageId, releaseId, operationId)));
  }

  commitLocalChanges(packageId: string, message: string): Promise<Record<string, unknown>> {
    return this.mutate(() => this.runOperation("commit-local", packageId, async (operationId) => {
      const state = await this.store.read();
      const installed = requireInstalled(state, packageId);
      if (installed.sourceKind === "bundled") throw new RequestError("package_managed_by_runtime", "Bundled Packages cannot be committed through Package Manager");
      const committed = await this.git.commitLocal(installed.sourcePath, message);
      if (!committed.committed) return { committed: false, head: committed.head, package: packageSummary(installed) };
      const targetCommit = committed.completedMerge ? installed.targetCommit : installed.baseCommit;
      await this.store.update((next) => {
        const current = requireInstalled(next, packageId);
        current.localHead = committed.head;
        current.targetCommit = targetCommit;
        current.sourceStatus = "candidate_ready";
        current.updatedAt = new Date().toISOString();
        delete current.lastError;
      });
      const refreshed = requireInstalled(await this.store.read(), packageId);
      const activated = await this.activateSource(refreshed, refreshed.installPlan, operationId, "Apply committed local Package changes");
      return { committed: true, head: committed.head, package: packageSummary(activated) };
    }));
  }

  uninstall(packageId: string, purgeData = false): Promise<Record<string, unknown>> {
    return this.mutate(() => this.runOperation("uninstall", packageId, async (operationId) => {
      const current = await this.store.read();
      const installed = requireInstalled(current, packageId);
      if (installed.sourceKind === "bundled") throw new RequestError("package_managed_by_runtime", "Bundled Packages can be disabled but not uninstalled");
      if (installed.sourceKind === "preinstalled") throw new RequestError("package_managed_by_distribution", "Preinstalled Packages can be disabled but not uninstalled");
      const functionalAssistantIds = Object.values(current.contributions)
        .filter((record) => record.packageId === packageId && isFunctionalAssistant(record.contribution))
        .map((record) => record.id);
      const next = structuredClone(current);
      delete next.packages[packageId];
      for (const [id, contribution] of Object.entries(next.contributions)) if (contribution.packageId === packageId) delete next.contributions[id];
      for (const binding of Object.values(next.assistantBindings)) {
        binding.enabledContributionIds = binding.enabledContributionIds.filter((id) => next.contributions[id] !== undefined);
        for (const id of Object.keys(binding.experienceSpaces)) if (!next.contributions[id]) delete binding.experienceSpaces[id];
        for (const id of Object.keys(binding.functionalAssistants ?? {})) if (!next.contributions[id]) delete binding.functionalAssistants[id];
      }
      await this.withSelfOperation(installed, Object.keys(current.contributions).filter((id) => current.contributions[id]?.packageId === packageId), operationId,
        "Uninstall Package and deactivate its contributions", async () => this.commitActivation(current, next));
      const paths = this.paths(packageId);
      await Promise.all([
        removeIfExists(paths.source), removeIfExists(paths.revisions), removeIfExists(paths.candidates), removeIfExists(paths.artifacts),
        ...(purgeData ? [removeIfExists(paths.data)] : []),
        ...(purgeData ? functionalAssistantIds.map((functionId) => this.functionalAssistantStorage.purgeFunction(functionId)) : []),
      ]);
      return { packageId, uninstalled: true, dataPreserved: !purgeData };
    }));
  }

  setContributionEnabled(contributionId: string, enabled: boolean): Promise<Record<string, unknown>> {
    return this.mutate(() => this.runOperation(enabled ? "enable-contribution" : "disable-contribution", undefined, async (operationId) => {
      const current = await this.store.read();
      const record = current.contributions[contributionId];
      if (!record) throw new RequestError("contribution_not_found", `Contribution is not installed: ${contributionId}`);
      const installed = requireInstalled(current, record.packageId);
      if (record.enabled === enabled) return { contribution: record };
      const next = structuredClone(current);
      next.contributions[contributionId]!.enabled = enabled;
      const ids = next.packages[record.packageId]!.enabledContributionIds;
      next.packages[record.packageId]!.enabledContributionIds = enabled
        ? [...new Set([...ids, contributionId])]
        : ids.filter((id) => id !== contributionId);
      if (!enabled) {
        for (const binding of Object.values(next.assistantBindings)) {
          binding.enabledContributionIds = binding.enabledContributionIds.filter((id) => id !== contributionId);
          delete binding.experienceSpaces[contributionId];
          if (binding.functionalAssistants) delete binding.functionalAssistants[contributionId];
        }
      }
      await this.withSelfOperation(installed, [contributionId], operationId,
        `${enabled ? "Enable" : "Disable"} Package contribution`, async () => this.commitActivation(current, next));
      return { contribution: (await this.store.read()).contributions[contributionId] };
    }));
  }

  async assistantBinding(assistantId: string): Promise<AssistantPackageBinding> {
    assertAssistantId(assistantId);
    const state = await this.store.read();
    return normalizeAssistantBinding(state, assistantId, state.assistantBindings[assistantId]);
  }

  setAssistantBinding(assistantId: string, input: {
    enabledContributionIds: string[];
    experienceSpaces?: Record<string, string>;
    functionalAssistants?: Record<string, Partial<FunctionalAssistantBindingSettings>>;
  }): Promise<AssistantPackageBinding> {
    return this.mutate(async () => {
      assertAssistantId(assistantId);
      const ids = [...new Set(input.enabledContributionIds)];
      const spaces = { ...(input.experienceSpaces ?? {}) };
      const binding = await this.store.update((state) => {
        for (const id of ids) {
          const record = state.contributions[id];
          if (!record || !record.enabled) throw new RequestError("contribution_unavailable", `Contribution is not enabled: ${id}`);
          if (record.contribution.assistantSelectable !== true && !["wuxianpi.experience", "wuxianpi.context"].includes(record.contribution.type) &&
              !isFunctionalAssistant(record.contribution)) {
            throw new RequestError("contribution_not_selectable", `Contribution cannot be bound to an assistant: ${id}`);
          }
        }
        const preliminary = resolveAssistantSelection(state, {
          assistantId, enabledContributionIds: ids, experienceSpaces: spaces,
          functionalAssistants: {},
          updatedAt: new Date().toISOString(),
        });
        for (const [id, space] of Object.entries(spaces)) {
          if (!preliminary.resolvedContributionIds.has(id) || state.contributions[id]?.contribution.type !== "wuxianpi.experience" || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(space)) {
            throw new RequestError("invalid_experience_binding", `Invalid experience space binding for ${id}`);
          }
        }
        const requestedFunctionalAssistants = input.functionalAssistants === undefined
          ? state.assistantBindings[assistantId]?.functionalAssistants
          : input.functionalAssistants;
        const functionalAssistants = normalizeFunctionalAssistantSettings(
          preliminary.functionalAssistants,
          requestedFunctionalAssistants,
          input.functionalAssistants !== undefined,
        );
        const binding: AssistantPackageBinding = {
          assistantId, enabledContributionIds: ids, experienceSpaces: spaces, functionalAssistants, updatedAt: new Date().toISOString(),
        };
        state.assistantBindings[assistantId] = binding;
        return binding;
      });
      await this.writeActiveRegistry(await this.store.read());
      return binding;
    });
  }

  async resolveAssistantResources(assistantId?: string): Promise<ResolvedAssistantPackageResources> {
    const state = await this.store.read();
    const binding = assistantId ? state.assistantBindings[assistantId] : undefined;
    const selection = resolveAssistantSelection(state, binding);
    const selected = selection.resolvedContributionIds;
    const functionalAssistants: ResolvedFunctionalAssistant[] = assistantId
      ? selection.functionalAssistants.map((record) => {
        const contributionIds = expandContributionIds(state, record.contribution.defaultBindings ?? []);
        const sharingMode = functionalAssistantMode(binding, record.id);
        const paths = this.functionalAssistantStorage.statePaths(record.id, assistantId);
        return {
          functionId: record.id,
          packageId: record.packageId,
          name: record.contribution.name,
          ...(record.contribution.description ? { description: record.contribution.description } : {}),
          sharingMode,
          defaultBindingIds: [...new Set(record.contribution.defaultBindings ?? [])],
          resolvedContributionIds: [...contributionIds],
          sharedStatePath: paths.shared,
          profileStatePath: paths.profile,
        };
      })
      : [];
    const result: ResolvedAssistantPackageResources = {
      extensionPaths: [], skillPaths: [], promptPaths: [], themePaths: [], appendSystemPrompt: [],
      mcpServerIds: [], webExtensionIds: [], experiences: [], customTools: [],
      resolvedContributionIds: [...selected], functionalAssistants,
    };
    for (const functional of functionalAssistants) {
      result.appendSystemPrompt.push(
        `Functional assistant ${functional.name} (${functional.functionId}) is bound as a stateful Skill bundle with ${functional.sharingMode} storage. ` +
        `Use ${functional.functionId} state only for this functional assistant's domain knowledge, progress, and task experience.`,
      );
    }
    if (assistantId && functionalAssistants.length > 0) {
      result.customTools.push(createFunctionalAssistantStateTool({
        assistantId,
        storage: this.functionalAssistantStorage,
        bindings: functionalAssistants.map(({ functionId, sharingMode }) => ({ functionId, sharingMode })),
      }));
    }
    const marketplaceEnabled = state.contributions["com.wuxianpi.builtin.marketplace/context.marketplace"]?.enabled === true &&
      state.contributions["com.wuxianpi.builtin.marketplace/skill.marketplace"]?.enabled === true;
    if (marketplaceEnabled) {
      result.customTools.push(...createMarketplaceTools({
        search: (query) => this.marketPackages(query),
        packageDetail: (packageId) => this.marketPackage(packageId),
        releases: (packageId) => this.marketReleases(packageId),
        installPlan: (packageId, releaseId) => this.marketInstallPlan(packageId, releaseId),
        install: (packageId, releaseId) => this.install(packageId, releaseId),
        installedDetail: (packageId) => this.detail(packageId),
      }));
    }
    for (const record of Object.values(state.contributions)) {
      if (!record.enabled) continue;
      const contribution = record.contribution;
      if (contribution.assistantSelectable === true && !selected.has(record.id)) continue;
      const root = record.revisionPath;
      if (contribution.type === "pi.extension" && contribution.path) result.extensionPaths.push(safePackagePath(root, contribution.path));
      else if (contribution.type === "pi.skill" && contribution.path) result.skillPaths.push(safePackagePath(root, contribution.path));
      else if (contribution.type === "pi.prompt" && contribution.path) result.promptPaths.push(safePackagePath(root, contribution.path));
      else if (contribution.type === "pi.theme" && contribution.path) result.themePaths.push(safePackagePath(root, contribution.path));
      else if (contribution.type === "mcp.server" && selected.has(record.id)) {
        result.mcpServerIds.push((await readMcpContribution(root, contribution)).id);
      } else if (contribution.type === "wuxianpi.webExtension" && selected.has(record.id)) result.webExtensionIds.push(record.id);
      else if (contribution.type === "wuxianpi.context" && contribution.path) {
        const text = await readDirectoryContext(safePackagePath(root, contribution.path));
        if (text) result.appendSystemPrompt.push(`Package context ${record.id}:\n${text}`);
      } else if (contribution.type === "wuxianpi.experience" && contribution.basePath && contribution.experienceSpaceId && contribution.mainstream && contribution.updatePolicy) {
        const experienceSpaceId = binding?.experienceSpaces[record.id] ?? contribution.experienceSpaceId;
        const installed = state.packages[record.packageId]!;
        const experienceRoot = join(installed.dataPath, "experiences", experienceSpaceId);
        const basePath = safePackagePath(root, contribution.basePath);
        const localCorrectionPath = join(experienceRoot, "local-correction.md");
        const layers = [
          ["Package base experience", await readDirectoryContext(basePath).catch(() => "")],
          ["Mainstream experience", await readOptional(join(experienceRoot, "mainstream.md"))],
          ["Locally verified correction", await readOptional(localCorrectionPath)],
        ] as const;
        for (const [label, text] of layers) if (text) result.appendSystemPrompt.push(`${label} (${record.id}, ${experienceSpaceId}):\n${text}`);
        result.experiences.push({
          contributionId: record.id, experienceSpaceId, basePath,
          mainstream: contribution.mainstream, updatePolicy: contribution.updatePolicy, localCorrectionPath,
        });
      }
    }
    return dedupeResources(result);
  }

  async resolveAssistantResourcesForCwd(cwd: string, assistantsRoot: string): Promise<ResolvedAssistantPackageResources> {
    const relativePath = relative(resolve(assistantsRoot), resolve(cwd));
    const assistantId = relativePath && !relativePath.startsWith("..") && !relativePath.includes(sep) ? relativePath : undefined;
    return this.resolveAssistantResources(assistantId);
  }

  async listActiveUiContributions(): Promise<Array<Record<string, unknown>>> {
    const state = await this.store.read();
    const output: Array<Record<string, unknown>> = [];
    for (const record of Object.values(state.contributions)) {
      if (!record.enabled || !["wuxianpi.webExtension", "wuxianpi.renderer"].includes(record.contribution.type) || !record.contribution.manifest) continue;
      const manifestPath = safePackagePath(record.revisionPath, record.contribution.manifest);
      const raw = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
      const root = dirname(manifestPath);
      const entry = typeof raw.entry === "string" ? raw.entry : undefined;
      output.push({
        id: record.id,
        name: record.contribution.name,
        version: state.packages[record.packageId]?.version ?? "0.0.0",
        kind: record.contribution.type === "wuxianpi.renderer" ? "wuxianpi-renderer" : "wuxianpi",
        path: root,
        root,
        manifest: { ...raw, id: record.id, name: record.contribution.name },
        enabled: true,
        packageId: record.packageId,
        contributionId: record.id,
        builtin: state.packages[record.packageId]?.sourceKind === "bundled",
        contentTypes: record.contribution.contentTypes ?? [],
        diagnostics: [],
        resourceBaseUrl: `/api/web/v1/extensions/${encodeURIComponent(record.id)}/assets/`,
        ...(entry ? { entryUrl: `/api/web/v1/extensions/${encodeURIComponent(record.id)}/assets/${entry.split("/").map(encodeURIComponent).join("/")}` } : {}),
      });
    }
    return output;
  }

  async operations(limit = 100, packageId?: string): Promise<Array<Record<string, unknown>>> {
    const events = await this.operationLog.tail(1000, packageId);
    const grouped = new Map<string, Record<string, any>>();
    for (const event of events) {
      const existing = grouped.get(event.operationId);
      if (!existing) {
        grouped.set(event.operationId, {
          operationId: event.operationId,
          packageId: event.packageId,
          type: event.type === "self-operation" ? "update" : event.type,
          phase: event.phase,
          message: event.message,
          details: { ...(event.details ?? {}) },
          startedAt: event.time,
          events: [{ at: event.time, level: event.phase === "failed" ? "error" : "info", message: event.message }],
        });
      } else {
        if (event.type !== "self-operation") existing.type = event.type;
        existing.packageId ??= event.packageId;
        existing.phase = event.phase;
        existing.message = event.message;
        existing.details = { ...existing.details, ...(event.details ?? {}) };
        existing.events.push({ at: event.time, level: event.phase === "failed" ? "error" : "info", message: event.message });
        if (event.phase === "succeeded" || event.phase === "failed") existing.completedAt = event.time;
      }
    }
    return [...grouped.values()].sort((left, right) => String(right.startedAt).localeCompare(String(left.startedAt)))
      .slice(0, Math.max(1, Math.min(limit, 1000)));
  }

  async checkUpdates(packageId?: string): Promise<Array<Record<string, unknown>>> {
    const state = await this.store.read();
    const installed = packageId ? [requireInstalled(state, packageId)] : Object.values(state.packages);
    const results: Array<Record<string, unknown>> = [];
    for (const item of installed) {
      if (item.sourceKind === "bundled") {
        results.push({ packageId: item.packageId, currentCommit: item.baseCommit, available: false, bundled: true });
        continue;
      }
      try {
        const plan = await this.marketInstallPlan(item.packageId);
        results.push({ packageId: item.packageId, currentCommit: item.baseCommit, targetCommit: plan.approvedCommit, available: item.baseCommit !== plan.approvedCommit, releaseId: plan.releaseId, version: plan.version });
      } catch (error) {
        results.push({ packageId: item.packageId, currentCommit: item.baseCommit, available: false, error: errorMessage(error) });
      }
    }
    return results;
  }

  private async installInternal(packageId: string, releaseId: string | undefined, operationId: string, stack: Set<string>): Promise<Record<string, unknown>> {
    const existing = (await this.store.read()).packages[packageId];
    if (existing?.activeRevisionId) throw new RequestError("package_already_installed", `Package is already installed: ${packageId}`);
    if (stack.has(packageId)) throw new RequestError("package_dependency_cycle", `Package dependency cycle: ${[...stack, packageId].join(" -> ")}`);
    stack.add(packageId);
    const plan = await this.marketInstallPlan(packageId, releaseId);
    const paths = this.paths(packageId);
    const fetched = await this.git.fetchExact(paths.source, plan.gitSources, plan.approvedCommit);
    const head = await this.git.checkoutInitial(paths.source, fetched.ref);
    const { manifest } = await readAndValidatePackageManifest(paths.source, plan);
    this.validateHostCapabilities(manifest);
    await this.ensureDependencies(manifest, stack, operationId);
    const now = new Date().toISOString();
    await this.store.update((state) => {
      state.packages[packageId] = {
        packageId, name: manifest.name, version: manifest.version,
        sourcePath: paths.source, dataPath: paths.data,
        baseCommit: plan.approvedCommit, localHead: head, targetCommit: plan.approvedCommit,
        sourceStatus: "candidate_ready", manifest, installPlan: plan, enabledContributionIds: [],
        installedAt: existing?.installedAt ?? now, updatedAt: now,
      };
    });
    const activated = await this.activateSource(requireInstalled(await this.store.read(), packageId), plan, operationId, "Install and activate Package");
    stack.delete(packageId);
    return { package: packageSummary(activated), sourceUrl: fetched.sourceUrl };
  }

  private async updateInternal(packageId: string, releaseId: string | undefined, operationId: string): Promise<Record<string, unknown>> {
    const state = await this.store.read();
    const installed = requireInstalled(state, packageId);
    if (installed.sourceKind === "bundled") throw new RequestError("package_managed_by_runtime", "Bundled Packages are updated with WuxianPi Runtime");
    const plan = await this.marketInstallPlan(packageId, releaseId);
    if (plan.approvedCommit === installed.baseCommit && installed.sourceStatus === "ready") {
      return { package: packageSummary(installed), updated: false };
    }
    const merged = await this.git.prepareUpdate(installed.sourcePath, installed, plan.gitSources, plan.approvedCommit);
    if (merged.status === "merge_conflict") {
      await this.store.update((next) => {
        const current = requireInstalled(next, packageId);
        current.targetCommit = plan.approvedCommit;
        current.sourceStatus = "merge_conflict";
        current.installPlan = plan;
        current.lastError = { code: "merge_conflict", message: `Merge conflicts: ${merged.conflicts.join(", ")}` };
        current.updatedAt = new Date().toISOString();
      });
      throw new RequestError("merge_conflict", "Package update has merge conflicts; the active revision was not changed", { conflicts: merged.conflicts });
    }
    const officialManifest = await this.git.showFile(installed.sourcePath, plan.approvedCommit, plan.manifestPath);
    const officialDigest = createHash("sha256").update(officialManifest).digest("hex");
    if (officialDigest !== plan.manifestDigest) throw new RequestError("manifest_digest_mismatch", "Official target manifest does not match the Hub install plan");
    const { manifest } = await readAndValidatePackageManifest(installed.sourcePath, plan, false);
    this.validateHostCapabilities(manifest);
    await this.ensureDependencies(manifest, new Set([packageId]), operationId);
    await this.store.update((next) => {
      const current = requireInstalled(next, packageId);
      current.name = manifest.name;
      current.version = manifest.version;
      current.localHead = merged.head;
      current.targetCommit = plan.approvedCommit;
      current.sourceStatus = "candidate_ready";
      current.manifest = manifest;
      current.installPlan = plan;
      current.updatedAt = new Date().toISOString();
      delete current.lastError;
    });
    const activated = await this.activateSource(requireInstalled(await this.store.read(), packageId), plan, operationId, "Update and activate Package");
    return { package: packageSummary(activated), updated: true, sourceUrl: merged.sourceUrl };
  }

  private async ensureDependencies(manifest: WuxianPiPackageManifest, stack: Set<string>, operationId: string): Promise<void> {
    for (const dependency of manifest.requires.packages) {
      const installed = (await this.store.read()).packages[dependency.packageId];
      if (!installed?.activeRevisionId) {
        const plan = await this.marketClient.installPlanForCommit(dependency.packageId, dependency.approvedCommit, { hostCapabilities: this.hostCapabilities });
        await this.installInternal(dependency.packageId, plan.releaseId, operationId, stack);
      } else if (installed.baseCommit !== dependency.approvedCommit) {
        throw new RequestError("package_dependency_mismatch", `Package ${manifest.id} requires ${dependency.packageId}@${dependency.approvedCommit}`);
      }
      const current = await this.store.read();
      for (const id of dependency.requiredContributionIds ?? []) {
        if (!current.contributions[id]?.enabled) throw new RequestError("package_dependency_contribution_missing", `Required contribution is unavailable: ${id}`);
      }
    }
  }

  private async activateSource(installed: InstalledPackageState, plan: InstallPlan, operationId: string, intent: string): Promise<InstalledPackageState> {
    const paths = this.paths(installed.packageId);
    const candidate = join(paths.candidates, operationId);
    const logs = join(paths.logs, operationId);
    await removeIfExists(candidate);
    await mkdir(dirname(candidate), { recursive: true, mode: 0o700 });
    await cp(installed.sourcePath, candidate, {
      recursive: true,
      force: true,
      filter: (source) => basename(source) !== ".git",
    });
    let manifest: WuxianPiPackageManifest;
    try {
      ({ manifest } = await readAndValidatePackageManifest(candidate, plan, false));
      const artifactIds = new Set<string>(manifest.build.mode === "artifact" ? manifest.build.artifactIds : []);
      for (const contribution of manifest.contributions) if (contribution.type === "artifact" && contribution.artifactId) artifactIds.add(contribution.artifactId);
      await this.artifacts.materialize(plan.artifacts, [...artifactIds], candidate, paths.artifacts, logs);
      await this.buildRunner.run(manifest, candidate, logs);
      await validatePackageManifest(candidate, manifest, plan);
    } catch (error) {
      await this.store.update((state) => {
        const current = requireInstalled(state, installed.packageId);
        current.sourceStatus = "build_failed";
        current.lastError = { code: errorCode(error), message: errorMessage(error), logPath: logs };
        current.updatedAt = new Date().toISOString();
      });
      throw error;
    }
    const revisionId = `${installed.localHead.slice(0, 12)}-${operationId.slice(0, 8)}`;
    const revisionPath = join(paths.revisions, revisionId);
    await mkdir(paths.revisions, { recursive: true, mode: 0o700 });
    await removeIfExists(revisionPath);
    await writeAtomicJson(join(candidate, ".wuxianpi-revision.json"), {
      schemaVersion: 1, packageId: installed.packageId, revisionId, localHead: installed.localHead,
      officialCommit: installed.targetCommit, createdAt: new Date().toISOString(),
    });
    await rename(candidate, revisionPath);
    const current = await this.store.read();
    const next = structuredClone(current);
    const nextPackage = requireInstalled(next, installed.packageId);
    const previousContributions = new Map(Object.values(next.contributions)
      .filter((item) => item.packageId === installed.packageId)
      .map((item) => [item.id, item]));
    const hadActiveRevision = nextPackage.activeRevisionId !== undefined;
    for (const [id, contribution] of Object.entries(next.contributions)) if (contribution.packageId === installed.packageId) delete next.contributions[id];
    for (const contribution of manifest.contributions) {
      if (next.contributions[contribution.id]) throw new RequestError("contribution_conflict", `Contribution id is already active: ${contribution.id}`);
      const enabled = !hadActiveRevision || previousContributions.get(contribution.id)?.enabled !== false;
      next.contributions[contribution.id] = {
        id: contribution.id, packageId: installed.packageId, revisionId, revisionPath, enabled, contribution,
      };
    }
    nextPackage.manifest = manifest;
    nextPackage.version = manifest.version;
    nextPackage.name = manifest.name;
    nextPackage.baseCommit = plan.approvedCommit;
    nextPackage.targetCommit = plan.approvedCommit;
    nextPackage.localHead = installed.localHead;
    nextPackage.activeRevisionId = revisionId;
    nextPackage.knownGoodRevisionId = revisionId;
    nextPackage.sourceStatus = "ready";
    nextPackage.installPlan = plan;
    nextPackage.enabledContributionIds = Object.values(next.contributions).filter((item) => item.packageId === installed.packageId && item.enabled).map((item) => item.id);
    nextPackage.updatedAt = new Date().toISOString();
    delete nextPackage.lastError;
    await this.withSelfOperation(installed, manifest.contributions.map((item) => item.id), operationId, intent,
      async () => this.commitActivation(current, next));
    return requireInstalled(await this.store.read(), installed.packageId);
  }

  private async commitActivation(current: PackageManagerState, next: PackageManagerState): Promise<void> {
    this.validateActivation(next);
    const runningBefore = await this.runningServiceSnapshot(current);
    try {
      await this.reconcileExternal(current, next);
      await this.store.update((state) => replaceState(state, next));
      await this.writeActiveRegistry(await this.store.read());
      await this.activateChangedServices(current, next);
    } catch (error) {
      await this.store.update((state) => replaceState(state, current)).catch(() => undefined);
      await this.writeActiveRegistry(current).catch(() => undefined);
      await this.reconcileExternal(next, current).catch(() => undefined);
      await this.restoreRunningServices(current, runningBefore).catch(() => undefined);
      throw error;
    }
  }

  private async applyInitialPreinstalledBindings(packageId: string, requested: InitialAssistantBinding[]): Promise<void> {
    const appliedAt = new Date().toISOString();
    await this.store.update((state) => {
      const installed = requireInstalled(state, packageId);
      if (installed.sourceKind !== "preinstalled" || !installed.preinstalled || installed.preinstalled.initialBindingsAppliedAt) return;
      validateInitialBindings(installed.manifest, requested);
      for (const requestedBinding of requested) {
        assertAssistantId(requestedBinding.assistantId);
        const current = normalizeAssistantBinding(state, requestedBinding.assistantId, state.assistantBindings[requestedBinding.assistantId]);
        const ids = [...new Set([...current.enabledContributionIds, ...requestedBinding.contributionIds])];
        for (const id of requestedBinding.contributionIds) {
          const record = state.contributions[id];
          if (!record?.enabled || record.packageId !== packageId) {
            throw new RequestError("preinstalled_binding_unavailable", `Preinstalled contribution is unavailable: ${id}`);
          }
          if (record.contribution.assistantSelectable !== true && !isFunctionalAssistant(record.contribution)) {
            throw new RequestError("preinstalled_binding_not_selectable", `Preinstalled contribution cannot be bound to an assistant: ${id}`);
          }
        }
        const selection = resolveAssistantSelection(state, {
          ...current,
          enabledContributionIds: ids,
        });
        state.assistantBindings[requestedBinding.assistantId] = {
          ...current,
          enabledContributionIds: ids,
          functionalAssistants: normalizeFunctionalAssistantSettings(selection.functionalAssistants, current.functionalAssistants, false),
          updatedAt: appliedAt,
        };
      }
      installed.preinstalled.initialBindingsAppliedAt = appliedAt;
      installed.updatedAt = appliedAt;
    });
    await this.writeActiveRegistry(await this.store.read());
  }

  private validateActivation(state: PackageManagerState): void {
    const ids = new Set<string>();
    for (const record of Object.values(state.contributions)) {
      if (ids.has(record.id)) throw new RequestError("contribution_conflict", `Duplicate active contribution: ${record.id}`);
      ids.add(record.id);
      if (!state.packages[record.packageId]?.activeRevisionId) throw new RequestError("invalid_activation", `Contribution ${record.id} has no active Package revision`);
    }
    for (const installed of Object.values(state.packages)) {
      this.validateHostCapabilities(installed.manifest);
      for (const dependency of installed.manifest.requires.packages) {
        const target = state.packages[dependency.packageId];
        if (!target?.activeRevisionId || target.baseCommit !== dependency.approvedCommit) {
          throw new RequestError("package_dependency_mismatch", `${installed.packageId} requires ${dependency.packageId}@${dependency.approvedCommit}`);
        }
      }
    }
  }

  private validateHostCapabilities(manifest: WuxianPiPackageManifest): void {
    for (const required of manifest.requires.hostCapabilities) {
      if (!this.hostCapabilities.some((available) => available.id === required.id && available.contractVersion === required.contractVersion)) {
        throw new RequestError("incompatible_host", `Missing host capability ${required.id}@${required.contractVersion}`);
      }
    }
  }

  private async reconcileExternal(current: PackageManagerState, next: PackageManagerState): Promise<void> {
    await this.reconcileMcp(current, next);
    await this.reconcileServices(current, next);
  }

  private async reconcileMcp(current: PackageManagerState, next: PackageManagerState): Promise<void> {
    const desired = new Map<string, { server: McpServerConfig; packageId: string; contributionId: string }>();
    for (const record of Object.values(next.contributions)) {
      if (!record.enabled || record.contribution.type !== "mcp.server") continue;
      const server = await readMcpContribution(record.revisionPath, record.contribution);
      const previous = desired.get(server.id);
      if (previous) throw new RequestError("mcp_server_conflict", `Multiple Package contributions declare MCP server ${server.id}`);
      desired.set(server.id, { server, packageId: record.packageId, contributionId: record.id });
    }
    const configured = new Map((await this.mcpConfig.list()).map((server) => [server.id, server]));
    for (const [serverId, value] of desired) {
      const owner = current.mcpServerOwners[serverId];
      if (configured.has(serverId) && (!owner || owner.packageId !== value.packageId)) {
        throw new RequestError("mcp_server_conflict", `MCP server ${serverId} is owned by the user or another Package`);
      }
    }
    const removeIds = Object.keys(current.mcpServerOwners).filter((serverId) => !desired.has(serverId));
    if (removeIds.length > 0) await this.mcpConfig.remove(removeIds);
    if (desired.size > 0) await this.mcpConfig.upsert([...desired.values()].map((item) => item.server));
    next.mcpServerOwners = Object.fromEntries([...desired].map(([id, item]) => [id, { packageId: item.packageId, contributionId: item.contributionId }]));
  }

  private async reconcileServices(current: PackageManagerState, next: PackageManagerState): Promise<void> {
    const existingSpecs = new Map<string, Record<string, unknown>>();
    for (const record of Object.values(current.contributions)) {
      if (!record.enabled || record.contribution.type !== "service-manager.service") continue;
      const spec = await readServiceContribution(record.revisionPath, record.contribution);
      existingSpecs.set(serviceIdOf(spec)!, spec);
    }
    const desired = new Map<string, { spec: Record<string, unknown>; packageId: string; contributionId: string }>();
    for (const record of Object.values(next.contributions)) {
      if (!record.enabled || record.contribution.type !== "service-manager.service") continue;
      const spec = await readServiceContribution(record.revisionPath, record.contribution);
      const id = serviceIdOf(spec)!;
      if (desired.has(id)) throw new RequestError("service_conflict", `Multiple Package contributions declare service ${id}`);
      desired.set(id, { spec, packageId: record.packageId, contributionId: record.id });
    }
    for (const [id, item] of desired) {
      const owner = current.serviceOwners[id];
      if (!owner && await this.serviceBridge.exists?.(id)) throw new RequestError("service_conflict", `Service ${id} already exists outside Package ownership`);
      if (owner && owner.packageId !== item.packageId) throw new RequestError("service_conflict", `Service ${id} is owned by another Package`);
    }
    for (const id of Object.keys(current.serviceOwners)) if (!desired.has(id)) await this.serviceBridge.remove(id);
    for (const [id, item] of desired) {
      if (JSON.stringify(existingSpecs.get(id)) !== JSON.stringify(item.spec)) await this.serviceBridge.apply(item.spec);
    }
    next.serviceOwners = Object.fromEntries([...desired].map(([id, item]) => [id, { packageId: item.packageId, contributionId: item.contributionId }]));
  }

  private async activateChangedServices(current: PackageManagerState, next: PackageManagerState): Promise<void> {
    if (!this.serviceBridge.activate) return;
    const currentSpecs = await this.serviceSpecs(current);
    const nextSpecs = await this.serviceSpecs(next);
    for (const [id, spec] of nextSpecs) {
      if (spec.enabled === false || JSON.stringify(currentSpecs.get(id)) === JSON.stringify(spec)) continue;
      await this.serviceBridge.activate(id, currentSpecs.has(id));
    }
  }

  private async serviceSpecs(state: PackageManagerState): Promise<Map<string, Record<string, unknown>>> {
    const specs = new Map<string, Record<string, unknown>>();
    for (const record of Object.values(state.contributions)) {
      if (!record.enabled || record.contribution.type !== "service-manager.service") continue;
      const spec = await readServiceContribution(record.revisionPath, record.contribution);
      specs.set(serviceIdOf(spec)!, spec);
    }
    return specs;
  }

  private async runningServiceSnapshot(state: PackageManagerState): Promise<Map<string, boolean>> {
    const snapshot = new Map<string, boolean>();
    if (!this.serviceBridge.isRunning) return snapshot;
    for (const id of (await this.serviceSpecs(state)).keys()) {
      snapshot.set(id, await this.serviceBridge.isRunning(id));
    }
    return snapshot;
  }

  private async restoreRunningServices(state: PackageManagerState, snapshot: Map<string, boolean>): Promise<void> {
    if (!this.serviceBridge.activate) return;
    const specs = await this.serviceSpecs(state);
    for (const [id, wasRunning] of snapshot) {
      if (wasRunning && specs.has(id)) await this.serviceBridge.activate(id, true);
    }
  }

  private async withSelfOperation<T>(
    installed: InstalledPackageState,
    affectedContributionIds: string[],
    operationId: string,
    intent: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (!(await this.isSelfRelated(installed, affectedContributionIds))) return operation();
    const record: SelfOperationRecord = {
      id: operationId,
      actor: "wuxianpi-package-manager",
      intent,
      targets: [`package:${installed.packageId}`, ...affectedContributionIds.map((id) => `contribution:${id}`)],
      before: {
        baseCommit: installed.baseCommit,
        localHead: installed.localHead,
        activeRevisionId: installed.activeRevisionId ?? null,
      },
      plannedActions: ["Update active contribution registry", "Reconcile MCP and service declarations", "Reload affected WuxianPi resources"],
      commandAndLogs: [join(this.paths(installed.packageId).logs, operationId)],
      recoveryHint: `Inspect Package ${installed.packageId}; restore active revision ${installed.activeRevisionId ?? "none"} or Git commit ${installed.localHead}`,
      status: "pending",
      startedAt: new Date().toISOString(),
    };
    await this.selfJournal.begin(record);
    await this.operationLog.append({
      operationId,
      type: "self-operation",
      packageId: installed.packageId,
      phase: "progress",
      message: "Self-related operation registered for native maintenance handoff",
      details: { selfRelated: true, maintenanceRecordPath: this.selfJournal.pendingPath },
      time: new Date().toISOString(),
    });
    try {
      const result = await operation();
      await this.selfJournal.complete(record);
      return result;
    } catch (error) {
      await this.selfJournal.fail(record, error);
      throw error;
    }
  }

  private async isSelfRelated(installed: InstalledPackageState, affectedContributionIds: string[]): Promise<boolean> {
    const context = await this.executionContext();
    if (context.packageIds.includes(installed.packageId) || affectedContributionIds.some((id) => context.contributionIds.includes(id))) return true;
    for (const contribution of installed.manifest.contributions) {
      if (!affectedContributionIds.includes(contribution.id)) continue;
      if (contribution.type === "service-manager.service") {
        const root = installed.activeRevisionId ? join(this.paths(installed.packageId).revisions, installed.activeRevisionId) : installed.sourcePath;
        const spec = await readServiceContribution(root, contribution).catch(() => undefined);
        const id = spec ? serviceIdOf(spec) : undefined;
        if (id && context.serviceIds.includes(id)) return true;
      }
    }
    return false;
  }

  private runOperation<T>(type: string, packageId: string | undefined, operation: (operationId: string) => Promise<T>): Promise<T> {
    const operationId = randomUUID();
    return (async () => {
      await this.log(operationId, type, packageId, "started", `${type} started`);
      try {
        const result = await operation(operationId);
        await this.log(operationId, type, packageId, "succeeded", `${type} completed`);
        return result;
      } catch (error) {
        const code = errorCode(error);
        const requestDetails = error instanceof RequestError && error.details && typeof error.details === "object"
          ? error.details as Record<string, unknown> : {};
        await this.log(operationId, type, packageId, "failed", errorMessage(error), {
          code,
          ...requestDetails,
          ...(["merge_conflict", "package_command_failed", "package_command_timeout", "artifact_download_failed"].includes(code)
            ? { activePackagePreserved: true } : {}),
        });
        throw error;
      }
    })();
  }

  private log(operationId: string, type: string, packageId: string | undefined, phase: PackageOperationEvent["phase"], message: string, details?: Record<string, unknown>): Promise<void> {
    return this.operationLog.append({ operationId, type, packageId, phase, message, details, time: new Date().toISOString() });
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    let resolveResult!: (value: T | PromiseLike<T>) => void;
    let rejectResult!: (reason?: unknown) => void;
    const result = new Promise<T>((resolvePromise, reject) => { resolveResult = resolvePromise; rejectResult = reject; });
    this.mutationTail = this.mutationTail.then(async () => {
      try { resolveResult(await operation()); } catch (error) { rejectResult(error); }
    }, async () => {
      try { resolveResult(await operation()); } catch (error) { rejectResult(error); }
    });
    return result;
  }

  private paths(packageId: string) {
    assertPackageId(packageId);
    const root = join(this.rootDir, "packages", packageId);
    return {
      root,
      source: join(root, "source"),
      candidates: join(root, "candidates"),
      revisions: join(root, "revisions"),
      artifacts: join(root, "artifacts"),
      data: join(root, "data"),
      logs: join(root, "logs"),
    };
  }

  private packageLocation(installed: InstalledPackageState): Record<string, string | null> {
    const paths = this.paths(installed.packageId);
    return {
      packageRoot: installed.sourceKind === "bundled" ? null : paths.root,
      sourcePath: installed.sourcePath,
      activeRevisionPath: installed.activeRevisionId
        ? join(paths.revisions, installed.activeRevisionId)
        : installed.sourcePath,
      dataPath: installed.dataPath,
      logsPath: paths.logs,
    };
  }

  private experienceRoot(installed: InstalledPackageState, experienceSpaceId: string): string {
    assertExperienceSpaceId(experienceSpaceId);
    return join(installed.dataPath, "experiences", experienceSpaceId);
  }

  private async localPackageView(
    state: PackageManagerState,
    installed: InstalledPackageState,
    extra: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const records = Object.values(state.contributions).filter((record) => record.packageId === installed.packageId);
    const selfRelated = await this.isSelfRelated(installed, records.map((record) => record.id));
    const context = await this.executionContext();
    const pending = await this.selfJournal.pending();
    return {
      ...packageSummary(installed),
      selfRelated,
      ...(pending?.targets.includes(`package:${installed.packageId}`) ? { maintenanceRecordPath: this.selfJournal.pendingPath } : {}),
      contributions: await Promise.all(records.map(async (record) => ({
        ...record,
        selfRelated: await this.contributionIsInExecutionContext(record, context),
      }))),
      bindings: Object.values(state.assistantBindings).filter((binding) =>
        binding.enabledContributionIds.some((id) => state.contributions[id]?.packageId === installed.packageId)),
      ...extra,
    };
  }

  private async contributionIsInExecutionContext(record: ActiveContributionRecord, context: PackageExecutionContext): Promise<boolean> {
    if (context.packageIds.includes(record.packageId) || context.contributionIds.includes(record.id)) return true;
    if (record.contribution.type !== "service-manager.service") return false;
    const spec = await readServiceContribution(record.revisionPath, record.contribution).catch(() => undefined);
    const id = spec ? serviceIdOf(spec) : undefined;
    return !!id && context.serviceIds.includes(id);
  }

  private async writeActiveRegistry(state: PackageManagerState): Promise<void> {
    await writeAtomicJson(join(this.rootDir, "active-registry.json"), {
      schemaVersion: 1,
      generation: state.generation,
      packages: Object.fromEntries(Object.values(state.packages).filter((item) => item.activeRevisionId).map((item) => [item.packageId, {
        revisionId: item.activeRevisionId,
        revisionPath: join(this.paths(item.packageId).revisions, item.activeRevisionId!),
        officialCommit: item.baseCommit,
        localHead: item.localHead,
      }])),
      contributions: state.contributions,
      assistantBindings: state.assistantBindings,
    });
  }
}

function replaceState(target: PackageManagerState, source: PackageManagerState): void {
  target.schemaVersion = 1;
  target.packages = source.packages;
  target.contributions = source.contributions;
  target.assistantBindings = source.assistantBindings;
  target.mcpServerOwners = source.mcpServerOwners;
  target.serviceOwners = source.serviceOwners;
}

function packageSummary(item: InstalledPackageState): Record<string, unknown> {
  return {
    packageId: item.packageId,
    name: item.name,
    version: item.version,
    baseCommit: item.baseCommit,
    localHead: item.localHead,
    targetCommit: item.targetCommit,
    activeRevisionId: item.activeRevisionId ?? null,
    knownGoodRevisionId: item.knownGoodRevisionId ?? null,
    sourceStatus: item.sourceStatus,
    enabledContributionIds: item.enabledContributionIds,
    installedAt: item.installedAt,
    updatedAt: item.updatedAt,
    lastError: item.lastError ?? null,
    sourceKind: item.sourceKind ?? "market",
    ...(item.preinstalled ? { preinstalled: item.preinstalled } : {}),
  };
}

async function digestDirectory(root: string): Promise<string> {
  const digest = createHash("sha256");
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        digest.update(`d:${relativePath}\0`);
        await visit(absolutePath, relativePath);
      } else if (entry.isFile()) {
        digest.update(`f:${relativePath}\0`);
        digest.update(await readFile(absolutePath));
        digest.update("\0");
      } else {
        throw new RequestError("invalid_bundled_package", `Bundled Package contains an unsupported entry: ${relativePath}`);
      }
    }
  };
  await visit(root, "");
  return digest.digest("hex");
}

function requireInstalled(state: PackageManagerState, packageId: string): InstalledPackageState {
  const installed = state.packages[packageId];
  if (!installed) throw new RequestError("package_not_found", `Package is not installed: ${packageId}`);
  return installed;
}

interface AssistantContributionSelection {
  resolvedContributionIds: Set<string>;
  functionalAssistants: ActiveContributionRecord[];
}

function resolveAssistantSelection(
  state: PackageManagerState,
  binding: AssistantPackageBinding | undefined,
): AssistantContributionSelection {
  const resolvedContributionIds = new Set<string>();
  const functionalAssistants = new Map<string, ActiveContributionRecord>();
  const visit = (id: string): void => {
    if (resolvedContributionIds.has(id)) return;
    const record = state.contributions[id];
    if (!record?.enabled) return;
    resolvedContributionIds.add(id);
    if (!isFunctionalAssistant(record.contribution)) return;
    functionalAssistants.set(id, record);
    for (const defaultId of record.contribution.defaultBindings ?? []) visit(defaultId);
  };
  for (const id of binding?.enabledContributionIds ?? []) visit(id);
  return { resolvedContributionIds, functionalAssistants: [...functionalAssistants.values()] };
}

function expandContributionIds(state: PackageManagerState, ids: string[]): Set<string> {
  const selection = resolveAssistantSelection(state, {
    assistantId: "resolver",
    enabledContributionIds: ids,
    experienceSpaces: {},
    functionalAssistants: {},
    updatedAt: new Date(0).toISOString(),
  });
  return selection.resolvedContributionIds;
}

function normalizeAssistantBinding(
  state: PackageManagerState,
  assistantId: string,
  binding: AssistantPackageBinding | undefined,
): AssistantPackageBinding {
  const base: AssistantPackageBinding = binding ?? {
    assistantId,
    enabledContributionIds: [],
    experienceSpaces: {},
    functionalAssistants: {},
    updatedAt: new Date(0).toISOString(),
  };
  const selection = resolveAssistantSelection(state, base);
  return {
    ...base,
    assistantId,
    enabledContributionIds: [...new Set(base.enabledContributionIds ?? [])],
    experienceSpaces: { ...(base.experienceSpaces ?? {}) },
    functionalAssistants: normalizeFunctionalAssistantSettings(selection.functionalAssistants, base.functionalAssistants, false),
  };
}

function normalizeFunctionalAssistantSettings(
  records: ActiveContributionRecord[],
  requested: Record<string, Partial<FunctionalAssistantBindingSettings>> | undefined,
  rejectUnknown = true,
): Record<string, FunctionalAssistantBindingSettings> {
  const ids = new Set(records.map((record) => record.id));
  if (rejectUnknown) {
    for (const id of Object.keys(requested ?? {})) {
      if (!ids.has(id)) throw new RequestError("functional_assistant_unbound", `Functional assistant is not selected: ${id}`);
    }
  }
  return Object.fromEntries(records.map((record) => {
    const mode = requested?.[record.id]?.sharingMode ?? "hybrid";
    assertFunctionalAssistantSharingMode(mode, record.id);
    return [record.id, { sharingMode: mode }];
  }));
}

function functionalAssistantMode(binding: AssistantPackageBinding | undefined, functionId: string): FunctionalAssistantSharingMode {
  const mode = binding?.functionalAssistants?.[functionId]?.sharingMode ?? "hybrid";
  return isFunctionalAssistantSharingMode(mode) ? mode : "hybrid";
}

function isFunctionalAssistant(contribution: PackageContribution): boolean {
  return contribution.type === "wuxianpi.assistantTemplate" && contribution.kind === "functional";
}

function assertFunctionalAssistantSharingMode(value: unknown, functionId: string): asserts value is FunctionalAssistantSharingMode {
  if (!isFunctionalAssistantSharingMode(value)) {
    throw new RequestError("invalid_functional_assistant_sharing_mode", `Invalid sharing mode for ${functionId}: ${String(value)}`);
  }
}

function isFunctionalAssistantSharingMode(value: unknown): value is FunctionalAssistantSharingMode {
  return value === "isolated" || value === "shared" || value === "hybrid";
}

function dedupeResources(resources: ResolvedAssistantPackageResources): ResolvedAssistantPackageResources {
  resources.extensionPaths = [...new Set(resources.extensionPaths)];
  resources.skillPaths = [...new Set(resources.skillPaths)];
  resources.promptPaths = [...new Set(resources.promptPaths)];
  resources.themePaths = [...new Set(resources.themePaths)];
  resources.mcpServerIds = [...new Set(resources.mcpServerIds)];
  resources.webExtensionIds = [...new Set(resources.webExtensionIds)];
  resources.appendSystemPrompt = [...new Set(resources.appendSystemPrompt)];
  resources.resolvedContributionIds = [...new Set(resources.resolvedContributionIds)];
  resources.functionalAssistants = [...new Map(resources.functionalAssistants.map((item) => [item.functionId, item])).values()];
  resources.customTools = [...new Map(resources.customTools.map((tool) => [tool.name, tool])).values()];
  resources.experiences = [...new Map(resources.experiences.map((item) => [`${item.contributionId}\0${item.experienceSpaceId}`, item])).values()];
  return resources;
}

async function readOptional(path: string): Promise<string> {
  try { return await readFile(path, "utf8"); } catch { return ""; }
}

function defaultHostCapabilities(): Array<{ id: string; contractVersion: number }> {
  return [
    "wuxianpi.package", "pi.extension", "pi.skill", "pi.prompt", "pi.theme", "wuxianpi.mcp",
    "wuxianpi.web-extension", "wuxianpi.renderer", "wuxianpi.assistant", "wuxianpi.context",
    "wuxianpi.experience", "openhouse.app", "service-manager.service",
  ].map((id) => ({ id, contractVersion: 1 }));
}

function assertPackageId(id: string): void {
  if (!/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/.test(id)) throw new RequestError("invalid_package_id", `Invalid Package id: ${id}`);
}

function assertAssistantId(id: string): void {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id)) throw new RequestError("invalid_assistant_id", `Invalid assistant id: ${id}`);
}

function assertDistributionId(id: string): void {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id)) throw new RequestError("invalid_distribution_id", `Invalid distribution id: ${id}`);
}

function validateInitialBindings(manifest: WuxianPiPackageManifest, bindings: InitialAssistantBinding[]): void {
  if (!Array.isArray(bindings)) throw new RequestError("invalid_preinstalled_bindings", "initialBindings must be an array");
  const contributions = new Map(manifest.contributions.map((item) => [item.id, item]));
  const assistantIds = new Set<string>();
  for (const binding of bindings) {
    assertAssistantId(binding.assistantId);
    if (assistantIds.has(binding.assistantId)) throw new RequestError("invalid_preinstalled_bindings", `Duplicate initial binding for ${binding.assistantId}`);
    assistantIds.add(binding.assistantId);
    if (!Array.isArray(binding.contributionIds) || binding.contributionIds.length === 0) {
      throw new RequestError("invalid_preinstalled_bindings", `Initial binding for ${binding.assistantId} has no contributions`);
    }
    for (const id of binding.contributionIds) {
      const contribution = contributions.get(id);
      if (!contribution) throw new RequestError("invalid_preinstalled_bindings", `Initial binding references a missing contribution: ${id}`);
      if (contribution.assistantSelectable !== true && !isFunctionalAssistant(contribution)) {
        throw new RequestError("invalid_preinstalled_bindings", `Initial binding references a non-selectable contribution: ${id}`);
      }
    }
  }
}

function assertExperienceSpaceId(id: string): void {
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(id)) throw new RequestError("invalid_experience_space_id", `Invalid experience space id: ${id}`);
}

function normalizeExecutionContext(input: Partial<PackageExecutionContext>): PackageExecutionContext {
  const normalize = (value: unknown, label: string): string[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
      throw new RequestError("invalid_execution_context", `${label} must be an array of non-empty strings`);
    }
    return [...new Set(value.map((item) => item.trim()))];
  };
  return {
    packageIds: normalize(input.packageIds, "packageIds"),
    contributionIds: normalize(input.contributionIds, "contributionIds"),
    serviceIds: normalize(input.serviceIds, "serviceIds"),
    updatedAt: typeof input.updatedAt === "string" && input.updatedAt ? input.updatedAt : new Date().toISOString(),
  };
}

function isMissing(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT";
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function errorCode(error: unknown): string { return error instanceof RequestError ? error.code : "package_operation_failed"; }
