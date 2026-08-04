import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { RequestError } from "./protocol.js";
import {
  assertEntityId,
  normalizeAbsolutePath,
  normalizeArchivedFlag,
  normalizeWorkspaceName,
  ProfileStateStore,
} from "./profile-state-store.js";
import type {
  CreateManagedWorkspaceInput,
  UpdateManagedWorkspaceInput,
  WorkspaceContext,
  WorkspaceListFilter,
  WorkspaceRecord,
} from "./profile-types.js";

const DEFAULT_INSTRUCTIONS = "# Workspace instructions\n";
const DEFAULT_MEMORY = "# Workspace memory\n";

export interface WorkspaceManagerOptions {
  stateStore: ProfileStateStore;
  contextRoot: string;
  idFactory?: () => string;
}

export class WorkspaceManager {
  readonly contextRoot: string;
  private readonly stateStore: ProfileStateStore;
  private readonly idFactory: () => string;
  private tail: Promise<void> = Promise.resolve();

  constructor(options: WorkspaceManagerOptions) {
    this.stateStore = options.stateStore;
    this.contextRoot = normalizeAbsolutePath(options.contextRoot, "workspace context root");
    this.idFactory = options.idFactory ?? randomUUID;
  }

  create(input: CreateManagedWorkspaceInput): Promise<WorkspaceContext> {
    return this.exclusive(async () => {
      const id = input.id ?? this.idFactory();
      assertEntityId(id, "workspace id");
      if (this.stateStore.getWorkspace(id)) throw new RequestError("workspace_conflict", `Workspace already exists: ${id}`);
      const workspace = this.stateStore.createWorkspace({
        id,
        name: input.name,
        rootCwd: input.rootCwd,
        archived: input.archived,
      });
      const directory = this.directory(id);
      try {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await Promise.all([
          writeAtomicText(join(directory, "INSTRUCTIONS.md"), input.instructions ?? DEFAULT_INSTRUCTIONS),
          writeAtomicText(join(directory, "MEMORY.md"), input.memory ?? DEFAULT_MEMORY),
        ]);
        return this.readContextFor(workspace);
      } catch (error) {
        this.stateStore.removeWorkspace(id);
        await rm(directory, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
    });
  }

  get(id: string): Promise<WorkspaceContext> {
    assertEntityId(id, "workspace id");
    const workspace = this.stateStore.getWorkspace(id);
    if (!workspace) throw new RequestError("workspace_not_found", `Workspace not found: ${id}`);
    return this.readContextFor(workspace);
  }

  list(filter: WorkspaceListFilter = {}): WorkspaceRecord[] {
    return this.stateStore.listWorkspaces(filter);
  }

  update(id: string, input: UpdateManagedWorkspaceInput): Promise<WorkspaceContext> {
    return this.exclusive(async () => {
      assertEntityId(id, "workspace id");
      const current = this.stateStore.getWorkspace(id);
      if (!current) throw new RequestError("workspace_not_found", `Workspace not found: ${id}`);
      const metadata = {
        ...(input.name !== undefined ? { name: normalizeWorkspaceName(input.name) } : {}),
        ...(input.rootCwd !== undefined ? { rootCwd: normalizeAbsolutePath(input.rootCwd, "workspace root cwd") } : {}),
        ...(input.archived !== undefined ? { archived: normalizeArchivedFlag(input.archived) } : {}),
      };
      const directory = this.directory(id);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const writes: Promise<void>[] = [];
      if (input.instructions !== undefined) writes.push(writeAtomicText(join(directory, "INSTRUCTIONS.md"), input.instructions));
      if (input.memory !== undefined) writes.push(writeAtomicText(join(directory, "MEMORY.md"), input.memory));
      await Promise.all(writes);
      const metadataChanged = Object.keys(metadata).length > 0;
      const workspace = metadataChanged
        ? this.stateStore.updateWorkspace(id, metadata)
        : writes.length > 0 ? this.stateStore.touchWorkspace(id) : current;
      return this.readContextFor(workspace);
    });
  }

  async remove(id: string): Promise<boolean> {
    return this.exclusive(async () => {
      assertEntityId(id, "workspace id");
      const removed = this.stateStore.removeWorkspace(id);
      if (removed) await rm(this.directory(id), { recursive: true, force: true });
      return removed;
    });
  }

  contextPaths(id: string): Pick<WorkspaceContext, "directory" | "instructionsPath" | "memoryPath"> {
    assertEntityId(id, "workspace id");
    const directory = this.directory(id);
    return {
      directory,
      instructionsPath: join(directory, "INSTRUCTIONS.md"),
      memoryPath: join(directory, "MEMORY.md"),
    };
  }

  private async readContextFor(workspace: WorkspaceRecord): Promise<WorkspaceContext> {
    const paths = this.contextPaths(workspace.id);
    const [instructions, memory] = await Promise.all([
      readOptional(paths.instructionsPath),
      readOptional(paths.memoryPath),
    ]);
    return { workspace, ...paths, instructions, memory };
  }

  private directory(id: string): string {
    return join(this.contextRoot, id);
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    let resolveResult!: (value: T | PromiseLike<T>) => void;
    let rejectResult!: (reason?: unknown) => void;
    const result = new Promise<T>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    const run = async () => {
      try { resolveResult(await operation()); }
      catch (error) { rejectResult(error); }
    };
    this.tail = this.tail.then(run, run);
    return result;
  }
}

async function readOptional(path: string): Promise<string> {
  try { return await readFile(path, "utf8"); }
  catch (error) {
    if (isMissing(error)) return "";
    throw error;
  }
}

async function writeAtomicText(path: string, content: string): Promise<void> {
  if (typeof content !== "string") throw new RequestError("invalid_workspace_context", "Workspace context must be text");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "w", 0o600);
  try {
    await handle.writeFile(normalizeText(content), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

function normalizeText(content: string): string {
  return content.length === 0 || content.endsWith("\n") ? content : `${content}\n`;
}

function isMissing(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT";
}
