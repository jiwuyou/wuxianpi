import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SqliteSingletonGuard } from "./sqlite-singleton-guard.js";

export interface PackageSingletonDefinition {
  packageId: string;
  id: string;
  groupId: string;
  name: string;
  recover?: () => Promise<void> | void;
  start: (context: { signal: AbortSignal; generation: string }) => Promise<void> | void;
  quiesce?: () => Promise<void> | void;
  stop?: () => Promise<void> | void;
  status?: () => Record<string, unknown>;
}

export type PackageSingletonState = "standby" | "acquiring" | "recovering" | "running" | "quiescing" | "stopping" | "error";

interface GroupRuntime {
  state: PackageSingletonState;
  definitions: PackageSingletonDefinition[];
  guard?: SqliteSingletonGuard;
  generation?: string;
  controller?: AbortController;
  transition: Promise<void>;
  error?: string;
}

export interface PackageSingletonManagerOptions {
  guardDirectory: string;
  runtimeId: string;
  runtimeUrl: string;
}

export class PackageSingletonManager {
  private readonly groups = new Map<string, GroupRuntime>();

  constructor(private readonly options: PackageSingletonManagerOptions) {}

  register(definition: PackageSingletonDefinition): void {
    const group = this.groups.get(definition.groupId) ?? { state: "standby" as const, definitions: [], transition: Promise.resolve() };
    if (group.definitions.some((item) => item.packageId === definition.packageId && item.id === definition.id)) {
      throw new Error(`Duplicate Package singleton: ${definition.packageId}/${definition.id}`);
    }
    group.definitions.push(definition);
    group.definitions.sort((left, right) => `${left.packageId}/${left.id}`.localeCompare(`${right.packageId}/${right.id}`));
    this.groups.set(definition.groupId, group);
  }

  async start(): Promise<void> {
    for (const groupId of [...this.groups.keys()].sort()) await this.acquire(groupId);
  }

  async stop(): Promise<void> {
    for (const groupId of [...this.groups.keys()].sort().reverse()) await this.release(groupId);
  }

  async acquire(groupId: string): Promise<Record<string, unknown>> {
    const group = this.requireGroup(groupId);
    await this.transition(group, async () => {
      if (group.state === "running") return;
      group.state = "acquiring";
      group.error = undefined;
      const guard = new SqliteSingletonGuard(this.guardPath(groupId));
      if (!guard.acquire()) {
        group.state = "standby";
        return;
      }
      group.guard = guard;
      group.generation = randomUUID();
      group.controller = new AbortController();
      try {
        await this.publishOwner(groupId, group.generation);
        group.state = "recovering";
        for (const definition of group.definitions) await definition.recover?.();
        for (const definition of group.definitions) {
          await definition.start({ signal: group.controller.signal, generation: group.generation });
        }
        group.state = "running";
      } catch (error) {
        group.error = error instanceof Error ? error.message : String(error);
        group.controller.abort();
        for (const definition of [...group.definitions].reverse()) await Promise.resolve(definition.stop?.()).catch(() => undefined);
        await this.removeOwner(groupId);
        guard.release();
        group.guard = undefined;
        group.generation = undefined;
        group.controller = undefined;
        group.state = "error";
      }
    });
    return this.describe(groupId);
  }

  async release(groupId: string): Promise<Record<string, unknown>> {
    const group = this.requireGroup(groupId);
    await this.transition(group, async () => {
      if (!group.guard) { group.state = "standby"; return; }
      group.state = "quiescing";
      group.controller?.abort();
      for (const definition of [...group.definitions].reverse()) await definition.quiesce?.();
      group.state = "stopping";
      for (const definition of [...group.definitions].reverse()) await definition.stop?.();
      await this.removeOwner(groupId);
      group.guard.release();
      group.guard = undefined;
      group.generation = undefined;
      group.controller = undefined;
      group.state = "standby";
      group.error = undefined;
    });
    return this.describe(groupId);
  }

  isOwner(groupId: string): boolean {
    const group = this.groups.get(groupId);
    return group?.state === "running" && group.guard?.acquired === true;
  }

  list(): Record<string, unknown>[] {
    return [...this.groups.keys()].sort().map((groupId) => this.describe(groupId));
  }

  describe(groupId: string): Record<string, unknown> {
    const group = this.requireGroup(groupId);
    return {
      groupId,
      state: group.state,
      owner: this.isOwner(groupId),
      runtimeId: this.options.runtimeId,
      generation: group.generation ?? null,
      error: group.error ?? null,
      services: group.definitions.map((definition) => ({
        packageId: definition.packageId,
        id: definition.id,
        name: definition.name,
        ...(definition.status ? { status: definition.status() } : {}),
      })),
    };
  }

  async discoverOwner(groupId: string): Promise<Record<string, unknown> | null> {
    try {
      return JSON.parse(await readFile(this.ownerPath(groupId), "utf8")) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  private requireGroup(groupId: string): GroupRuntime {
    const group = this.groups.get(groupId);
    if (!group) throw new Error(`Package singleton group not found: ${groupId}`);
    return group;
  }

  private async transition(group: GroupRuntime, operation: () => Promise<void>): Promise<void> {
    const previous = group.transition;
    let release!: () => void;
    group.transition = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { await operation(); } finally { release(); }
  }

  private guardPath(groupId: string): string { return join(this.options.guardDirectory, `${hash(groupId)}.sqlite`); }
  private ownerPath(groupId: string): string { return join(this.options.guardDirectory, `${hash(groupId)}.owner.json`); }

  private async publishOwner(groupId: string, generation: string): Promise<void> {
    await mkdir(this.options.guardDirectory, { recursive: true, mode: 0o700 });
    const path = this.ownerPath(groupId);
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify({
      schemaVersion: 1,
      groupId,
      runtimeId: this.options.runtimeId,
      runtimeUrl: this.options.runtimeUrl,
      pid: process.pid,
      generation,
      startedAt: new Date().toISOString(),
    }, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  }

  private async removeOwner(groupId: string): Promise<void> {
    await unlink(this.ownerPath(groupId)).catch(() => undefined);
  }
}

function hash(value: string): string { return createHash("sha256").update(value).digest("hex").slice(0, 24); }
