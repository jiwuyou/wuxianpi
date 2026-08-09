import { access, mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { AutomationTurnService } from "./automation-turn-service.js";
import type { WuxianPiPackageManager } from "./package-manager.js";
import type { SessionRegistry } from "./session-registry.js";

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

export interface PackageRuntimeContextV1 {
  packageId: string;
  version: string;
  dataDir: string;
  registerApi(namespace: string, handler: (request: PackageApiRequestV1) => Promise<unknown> | unknown): void;
  registerService(serviceId: string, service: Record<string, unknown>): void;
  getService<T = Record<string, unknown>>(packageId: string, serviceId: string): T | undefined;
  registry: SessionRegistry;
  automation: AutomationTurnService;
}

interface RuntimeModule {
  packageId: string;
  version: string;
  dataDir: string;
  apis: Map<string, (request: PackageApiRequestV1) => Promise<unknown> | unknown>;
  services: Map<string, Record<string, unknown>>;
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
  }) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    const contributions = await this.options.packageManager.listActiveRuntimeContributions();
    for (const contribution of contributions.sort((left, right) => left.packageId.localeCompare(right.packageId))) {
      await access(contribution.runtimePath);
      await mkdir(contribution.dataPath, { recursive: true, mode: 0o700 });
      const moduleState: RuntimeModule = {
        packageId: contribution.packageId, version: contribution.packageVersion,
        dataDir: contribution.dataPath, apis: new Map(), services: new Map(), lifecycle: [],
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
        registerService: (serviceId, service) => {
          moduleState.services.set(serviceId, service);
          moduleState.lifecycle.push({ serviceId, service });
        },
        getService: (packageId, serviceId) => this.modules.get(packageId)?.services.get(serviceId) as Record<string, unknown> | undefined,
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
    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.started) return;
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

  has(packageId: string, namespace: string): boolean {
    return Boolean(this.modules.get(packageId)?.apis.has(namespace));
  }
}
