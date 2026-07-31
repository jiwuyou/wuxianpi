import { appendFile, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { PackageManagerState, PackageOperationEvent } from "./package-types.js";

export function emptyPackageManagerState(): PackageManagerState {
  return {
    schemaVersion: 1,
    generation: 0,
    packages: {},
    contributions: {},
    assistantBindings: {},
    mcpServerOwners: {},
    serviceOwners: {},
  };
}

export class AtomicPackageStateStore {
  private tail: Promise<void> = Promise.resolve();

  constructor(readonly path: string) {}

  async read(): Promise<PackageManagerState> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as PackageManagerState;
      if (parsed.schemaVersion !== 1) throw new Error(`Unsupported Package Manager state schema: ${String(parsed.schemaVersion)}`);
      parsed.serviceOwners ??= {};
      return parsed;
    } catch (error) {
      if (isMissing(error)) return emptyPackageManagerState();
      throw error;
    }
  }

  update<T>(operation: (state: PackageManagerState) => Promise<T> | T): Promise<T> {
    let resolveResult!: (value: T | PromiseLike<T>) => void;
    let rejectResult!: (reason?: unknown) => void;
    const result = new Promise<T>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    this.tail = this.tail.then(async () => {
      try {
        const state = await this.read();
        const value = await operation(state);
        state.generation += 1;
        await writeAtomicJson(this.path, state);
        resolveResult(value);
      } catch (error) {
        rejectResult(error);
      }
    }, async () => {
      try {
        const state = await this.read();
        const value = await operation(state);
        state.generation += 1;
        await writeAtomicJson(this.path, state);
        resolveResult(value);
      } catch (error) {
        rejectResult(error);
      }
    });
    return result;
  }
}

export class PackageOperationLog {
  constructor(readonly path: string) {}

  async append(event: PackageOperationEvent): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await appendFile(this.path, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  }

  async tail(limit = 100, packageId?: string): Promise<PackageOperationEvent[]> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    return text.split("\n").filter(Boolean).reverse().flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as PackageOperationEvent;
        return !packageId || parsed.packageId === packageId ? [parsed] : [];
      } catch {
        return [];
      }
    }).slice(0, Math.max(1, Math.min(limit, 1000))).reverse();
  }
}

export async function writeAtomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(temporary, "w", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  try {
    const directory = await open(dirname(path), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } catch {
    // Directory fsync is not supported by every Android filesystem.
  }
}

export async function removeIfExists(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

function isMissing(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT";
}
