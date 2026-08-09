import { access, mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { AutomationTurnService } from "./automation-turn-service.js";
import type { WuxianPiPackageManager } from "./package-manager.js";
import type { SessionRegistry } from "./session-registry.js";
import { PackageSingletonManager, type PackageSingletonDefinition } from "./package-singleton-manager.js";
import { RequestError } from "./protocol.js";

export interface PackageApiContextV1 {
  packageId: string;
  extensionId?: string;
  assistantId?: string;
  sessionId?: string;
}

export interface PackageApiRequestV1 extends PackageApiContextV1 {
  namespace: string;
  method: string;
  params: Record<string, unknown>;
}

export interface PackageServiceRefV1 {
  packageId: string;
  serviceId: string;
  method: string;
}

export interface PackageRuntimeContextV1 {
  packageId: string;
  version: string;
  dataDir: string;
  registerApi(namespace: string, handler: (request: PackageApiRequestV1) => Promise<unknown> | unknown): void;
  registerService(serviceId: string, service: Record<string, unknown>, options?: { singletonGroupId?: string }): void;
  registerSingleton(definition: Omit<PackageSingletonDefinition, "packageId">): void;
  getService<T = Record<string, unknown>>(packageId: string, serviceId: string): T | undefined;
  invokeService<T = unknown>(reference: PackageServiceRefV1, input: unknown): Promise<T>;
  isSingletonOwner(groupId: string): boolean;
  singletonStatus(groupId: string): Record<string, unknown>;
  registry: SessionRegistry;
  automation: AutomationTurnService;
}

interface RuntimeModule {
  packageId: string;
  version: string;
  dataDir: string;
  apis: Map<string, (request: PackageApiRequestV1) => Promise<unknown> | unknown>;
  services: Map<string, Record<string, unknown>>;
  serviceGroups: Map<string, string>;
  lifecycle: Array<{ serviceId: string; service: Record<string, unknown> }>;
}

export class PackageRuntimeHostV1 {
  private readonly modules = new Map<string, RuntimeModule>();
  private loaded = false;
  private started = false;

  constructor(private readonly options: {
    packageManager: WuxianPiPackageManager;
    registry: SessionRegistry;
    automation: AutomationTurnService;
    singletons: PackageSingletonManager;
    internalToken: string;
  }) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    const contributions = await this.options.packageManager.listActiveRuntimeContributions();
    for (const contribution of contributions.sort((left, right) => left.packageId.localeCompare(right.packageId))) {
      await access(contribution.runtimePath);
      await mkdir(contribution.dataPath, { recursive: true, mode: 0o700 });
      const moduleState: RuntimeModule = {
        packageId: contribution.packageId, version: contribution.packageVersion,
        dataDir: contribution.dataPath, apis: new Map(), services: new Map(), serviceGroups: new Map(), lifecycle: [],
      };
      this.modules.set(contribution.packageId, moduleState);
      const imported = await import(`${pathToFileURL(contribution.runtimePath).href}?packageRevision=${encodeURIComponent(contribution.packageVersion)}`) as {
        default?: (context: PackageRuntimeContextV1) => Promise<unknown> | unknown;
      };
      if (typeof imported.default !== "function") throw new Error(`Package runtime has no default activation function: ${contribution.packageId}`);
      const context: PackageRuntimeContextV1 = {
        packageId: moduleState.packageId,
        version: moduleState.version,
        dataDir: moduleState.dataDir,
        registerApi: (namespace, handler) => {
          if (moduleState.apis.has(namespace)) throw new Error(`Duplicate Package API: ${contribution.packageId}/${namespace}`);
          moduleState.apis.set(namespace, handler);
        },
        registerService: (serviceId, service, serviceOptions = {}) => {
          if (moduleState.services.has(serviceId)) throw new Error(`Duplicate Package service: ${contribution.packageId}/${serviceId}`);
          moduleState.services.set(serviceId, service);
          if (serviceOptions.singletonGroupId) moduleState.serviceGroups.set(serviceId, serviceOptions.singletonGroupId);
          if (typeof service.start === "function" || typeof service.stop === "function" || typeof service.recover === "function") {
            moduleState.lifecycle.push({ serviceId, service });
          }
        },
        registerSingleton: (definition) => this.options.singletons.register({ ...definition, packageId: contribution.packageId }),
        getService: <T = Record<string, unknown>>(packageId: string, serviceId: string) =>
          this.modules.get(packageId)?.services.get(serviceId) as T | undefined,
        invokeService: <T = unknown>(reference: PackageServiceRefV1, input: unknown) => this.invokeService<T>(reference, input),
        isSingletonOwner: (groupId) => this.options.singletons.isOwner(groupId),
        singletonStatus: (groupId) => this.options.singletons.describe(groupId),
        registry: this.options.registry,
        automation: this.options.automation,
      };
      await imported.default(context);
    }
    this.loaded = true;
  }

  async start(): Promise<void> {
    await this.load();
    if (this.started) return;
    for (const moduleState of this.modules.values()) {
      for (const { service } of moduleState.lifecycle) {
        if (typeof service.recover === "function") await (service.recover as () => Promise<void>)();
        if (typeof service.start === "function") await (service.start as () => Promise<void>)();
      }
    }
    await this.options.singletons.start();
    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    await this.options.singletons.stop();
    for (const moduleState of [...this.modules.values()].reverse()) {
      for (const { service } of [...moduleState.lifecycle].reverse()) {
        if (typeof service.stop === "function") await (service.stop as () => Promise<void>)();
      }
    }
    this.started = false;
  }

  async invoke(request: PackageApiRequestV1): Promise<unknown> {
    await this.load();
    const moduleState = this.modules.get(request.packageId);
    const handler = moduleState?.apis.get(request.namespace);
    if (!handler) throw new Error(`Package API not found: ${request.packageId}/${request.namespace}`);
    return handler(request);
  }

  async invokeService<T = unknown>(reference: PackageServiceRefV1, input: unknown): Promise<T> {
    await this.load();
    const groupId = this.modules.get(reference.packageId)?.serviceGroups.get(reference.serviceId);
    if (!groupId || this.options.singletons.isOwner(groupId)) return this.invokeServiceLocal<T>(reference, input, true);
    const owner = await this.options.singletons.discoverOwner(groupId);
    const runtimeUrl = owner?.runtimeUrl;
    if (typeof runtimeUrl !== "string") {
      throw new RequestError("singleton_owner_unavailable", `No owner is available for Package singleton group: ${groupId}`, { httpStatus: 503 });
    }
    const endpoint = internalInvokeUrl(runtimeUrl);
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${this.options.internalToken}`, "content-type": "application/json" },
      body: JSON.stringify({ reference, input }),
    });
    const body = await response.json().catch(() => ({})) as { data?: { result?: T }; error?: { code?: string; message?: string } };
    if (!response.ok) {
      throw new RequestError(body.error?.code ?? "package_service_remote_error", body.error?.message ?? `Remote Package service returned HTTP ${response.status}`, { httpStatus: response.status });
    }
    return body.data?.result as T;
  }

  async invokeServiceLocal<T = unknown>(reference: PackageServiceRefV1, input: unknown, requireSingletonOwner = false): Promise<T> {
    await this.load();
    const moduleState = this.modules.get(reference.packageId);
    const groupId = moduleState?.serviceGroups.get(reference.serviceId);
    if (requireSingletonOwner && groupId && !this.options.singletons.isOwner(groupId)) {
      throw new RequestError("singleton_not_owned", `This Runtime does not own Package singleton group: ${groupId}`, { httpStatus: 409 });
    }
    const service = moduleState?.services.get(reference.serviceId);
    const method = service?.[reference.method];
    if (typeof method !== "function") {
      throw new RequestError("package_service_not_found", `Package service method not found: ${reference.packageId}/${reference.serviceId}/${reference.method}`, { httpStatus: 404 });
    }
    return await (method as (input: unknown) => Promise<T> | T)(input);
  }

  has(packageId: string, namespace: string): boolean {
    return Boolean(this.modules.get(packageId)?.apis.has(namespace));
  }

  singletons(): Record<string, unknown>[] { return this.options.singletons.list(); }
  acquireSingleton(groupId: string): Promise<Record<string, unknown>> { return this.options.singletons.acquire(groupId); }
  releaseSingleton(groupId: string): Promise<Record<string, unknown>> { return this.options.singletons.release(groupId); }
  discoverSingletonOwner(groupId: string): Promise<Record<string, unknown> | null> { return this.options.singletons.discoverOwner(groupId); }
}

function internalInvokeUrl(runtimeUrl: string): string {
  const url = new URL(runtimeUrl);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)) {
    throw new RequestError("singleton_owner_invalid", "Package singleton owner URL must use loopback HTTP", { httpStatus: 503 });
  }
  url.pathname = "/api/runtime/v1/package-services/invoke";
  url.search = "";
  url.hash = "";
  return url.toString();
}
