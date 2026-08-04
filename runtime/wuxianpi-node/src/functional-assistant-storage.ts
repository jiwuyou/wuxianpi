import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, opendir, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { FunctionalAssistantSharingMode } from "./package-types.js";
import { RequestError } from "./protocol.js";

export const FUNCTIONAL_ASSISTANT_MAX_READ_BYTES = 64 * 1024;
export const FUNCTIONAL_ASSISTANT_MAX_WRITE_BYTES = 256 * 1024;
export const FUNCTIONAL_ASSISTANT_MAX_LIST_ENTRIES = 200;

export type FunctionalAssistantStateScope = "auto" | "shared" | "profile";

export interface FunctionalAssistantStateAccess {
  functionId: string;
  assistantId: string;
  sharingMode: FunctionalAssistantSharingMode;
}

export interface FunctionalAssistantStateEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  scope: Exclude<FunctionalAssistantStateScope, "auto">;
  size?: number;
  modifiedAt: string;
}

export class FunctionalAssistantStorage {
  constructor(readonly rootDir: string) {}

  statePaths(functionId: string, assistantId: string): { shared: string; profile: string } {
    assertFunctionId(functionId);
    assertAssistantId(assistantId);
    const functionRoot = resolve(this.rootDir, ...functionId.split("/"));
    assertInside(resolve(this.rootDir), functionRoot, "functionId");
    return {
      shared: join(functionRoot, "shared"),
      profile: join(functionRoot, "profiles", assistantId),
    };
  }

  async purgeFunction(functionId: string): Promise<void> {
    assertFunctionId(functionId);
    const root = resolve(this.rootDir);
    const target = resolve(root, ...functionId.split("/"));
    assertInside(root, target, "functionId");
    await assertNoSymlinkPath(target, root);
    await rm(target, { recursive: true, force: true });
  }

  async list(input: FunctionalAssistantStateAccess & {
    path?: string;
    scope?: FunctionalAssistantStateScope;
  }): Promise<{
    operation: "list";
    functionId: string;
    assistantId: string;
    sharingMode: FunctionalAssistantSharingMode;
    path: string;
    scope: FunctionalAssistantStateScope;
    entries: FunctionalAssistantStateEntry[];
    truncated: boolean;
  }> {
    const relativePath = normalizeRelativePath(input.path ?? "", true);
    const requestedScope = input.scope ?? "auto";
    const scopes = readScopes(input.sharingMode, requestedScope);
    const entries = new Map<string, FunctionalAssistantStateEntry>();
    let truncated = false;
    for (const scope of [...scopes].reverse()) {
      const listed = await this.listScope(input, scope, relativePath);
      truncated ||= listed.truncated;
      for (const entry of listed.entries) entries.set(entry.name, entry);
    }
    const output = [...entries.values()].sort((left, right) => left.name.localeCompare(right.name));
    return {
      operation: "list",
      functionId: input.functionId,
      assistantId: input.assistantId,
      sharingMode: input.sharingMode,
      path: relativePath,
      scope: requestedScope,
      entries: output.slice(0, FUNCTIONAL_ASSISTANT_MAX_LIST_ENTRIES),
      truncated: truncated || output.length > FUNCTIONAL_ASSISTANT_MAX_LIST_ENTRIES,
    };
  }

  async read(input: FunctionalAssistantStateAccess & {
    path: string;
    scope?: FunctionalAssistantStateScope;
    offset?: number;
    maxBytes?: number;
  }): Promise<{
    operation: "read";
    functionId: string;
    assistantId: string;
    sharingMode: FunctionalAssistantSharingMode;
    path: string;
    scope: Exclude<FunctionalAssistantStateScope, "auto">;
    content: string;
    offset: number;
    bytesRead: number;
    size: number;
    truncated: boolean;
  }> {
    const relativePath = normalizeRelativePath(input.path, false);
    const offset = boundedInteger(input.offset ?? 0, 0, Number.MAX_SAFE_INTEGER, "offset");
    const maxBytes = boundedInteger(input.maxBytes ?? 32 * 1024, 1, FUNCTIONAL_ASSISTANT_MAX_READ_BYTES, "maxBytes");
    const scopes = readScopes(input.sharingMode, input.scope ?? "auto");
    for (const scope of scopes) {
      const target = this.targetPath(input, scope, relativePath);
      await assertNoSymlinkPath(target, this.rootDir);
      const info = await safeLstat(target);
      if (!info) continue;
      if (info.isSymbolicLink()) throw unsafeStatePath(relativePath);
      if (!info.isFile()) throw new RequestError("functional_assistant_state_not_file", `Functional assistant state is not a file: ${relativePath}`);
      const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const size = (await handle.stat()).size;
        const length = Math.max(0, Math.min(maxBytes, size - offset));
        const buffer = Buffer.alloc(length);
        const { bytesRead } = length > 0 ? await handle.read(buffer, 0, length, offset) : { bytesRead: 0 };
        return {
          operation: "read",
          functionId: input.functionId,
          assistantId: input.assistantId,
          sharingMode: input.sharingMode,
          path: relativePath,
          scope,
          content: buffer.subarray(0, bytesRead).toString("utf8"),
          offset,
          bytesRead,
          size,
          truncated: offset + bytesRead < size,
        };
      } finally {
        await handle.close();
      }
    }
    throw new RequestError("functional_assistant_state_not_found", `Functional assistant state was not found: ${relativePath}`);
  }

  async write(input: FunctionalAssistantStateAccess & {
    path: string;
    content: string;
    scope?: FunctionalAssistantStateScope;
  }): Promise<{
    operation: "write";
    functionId: string;
    assistantId: string;
    sharingMode: FunctionalAssistantSharingMode;
    path: string;
    scope: Exclude<FunctionalAssistantStateScope, "auto">;
    bytesWritten: number;
  }> {
    const relativePath = normalizeRelativePath(input.path, false);
    if (typeof input.content !== "string") throw new RequestError("invalid_functional_assistant_state", "content must be a string");
    const bytes = Buffer.from(input.content, "utf8");
    if (bytes.length > FUNCTIONAL_ASSISTANT_MAX_WRITE_BYTES) {
      throw new RequestError("functional_assistant_state_too_large", `Functional assistant state exceeds ${FUNCTIONAL_ASSISTANT_MAX_WRITE_BYTES} bytes`);
    }
    const scope = writeScope(input.sharingMode, input.scope ?? "auto");
    const target = this.targetPath(input, scope, relativePath);
    await ensureSafeDirectory(dirname(target), this.rootDir);
    const existing = await safeLstat(target);
    if (existing?.isSymbolicLink() || (existing && !existing.isFile())) throw unsafeStatePath(relativePath);
    const temporary = join(dirname(target), `.${relativePath.split("/").at(-1)}.${randomUUID()}.tmp`);
    let completed = false;
    try {
      const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, target);
      completed = true;
    } finally {
      if (!completed) await rm(temporary, { force: true }).catch(() => undefined);
    }
    return {
      operation: "write",
      functionId: input.functionId,
      assistantId: input.assistantId,
      sharingMode: input.sharingMode,
      path: relativePath,
      scope,
      bytesWritten: bytes.length,
    };
  }

  private async listScope(
    input: FunctionalAssistantStateAccess,
    scope: Exclude<FunctionalAssistantStateScope, "auto">,
    relativePath: string,
  ): Promise<{ entries: FunctionalAssistantStateEntry[]; truncated: boolean }> {
    const target = this.targetPath(input, scope, relativePath);
    await assertNoSymlinkPath(target, this.rootDir);
    const info = await safeLstat(target);
    if (!info) return { entries: [], truncated: false };
    if (info.isSymbolicLink()) throw unsafeStatePath(relativePath);
    if (!info.isDirectory()) throw new RequestError("functional_assistant_state_not_directory", `Functional assistant state is not a directory: ${relativePath}`);
    const entries: FunctionalAssistantStateEntry[] = [];
    const directory = await opendir(target);
    try {
      while (entries.length <= FUNCTIONAL_ASSISTANT_MAX_LIST_ENTRIES) {
        const child = await directory.read();
        if (!child) break;
        if (child.isSymbolicLink() || (!child.isFile() && !child.isDirectory())) continue;
        const childPath = relativePath ? `${relativePath}/${child.name}` : child.name;
        const childInfo = await lstat(join(target, child.name));
        entries.push({
          name: child.name,
          path: childPath,
          type: child.isDirectory() ? "directory" : "file",
          scope,
          ...(child.isFile() ? { size: childInfo.size } : {}),
          modifiedAt: childInfo.mtime.toISOString(),
        });
      }
    } finally {
      await directory.close().catch(() => undefined);
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    return { entries: entries.slice(0, FUNCTIONAL_ASSISTANT_MAX_LIST_ENTRIES), truncated: entries.length > FUNCTIONAL_ASSISTANT_MAX_LIST_ENTRIES };
  }

  private scopeRoot(input: FunctionalAssistantStateAccess, scope: Exclude<FunctionalAssistantStateScope, "auto">): string {
    return this.statePaths(input.functionId, input.assistantId)[scope];
  }

  private targetPath(input: FunctionalAssistantStateAccess, scope: Exclude<FunctionalAssistantStateScope, "auto">, relativePath: string): string {
    const root = this.scopeRoot(input, scope);
    const target = relativePath ? resolve(root, ...relativePath.split("/")) : root;
    assertInside(root, target, "path");
    return target;
  }
}

function readScopes(
  mode: FunctionalAssistantSharingMode,
  requested: FunctionalAssistantStateScope,
): Array<Exclude<FunctionalAssistantStateScope, "auto">> {
  if (requested !== "auto") {
    assertScopeAllowed(mode, requested);
    return [requested];
  }
  if (mode === "isolated") return ["profile"];
  if (mode === "shared") return ["shared"];
  return ["profile", "shared"];
}

function writeScope(
  mode: FunctionalAssistantSharingMode,
  requested: FunctionalAssistantStateScope,
): Exclude<FunctionalAssistantStateScope, "auto"> {
  if (requested !== "auto") {
    assertScopeAllowed(mode, requested);
    return requested;
  }
  return mode === "shared" ? "shared" : "profile";
}

function assertScopeAllowed(mode: FunctionalAssistantSharingMode, scope: Exclude<FunctionalAssistantStateScope, "auto">): void {
  if ((mode === "isolated" && scope !== "profile") || (mode === "shared" && scope !== "shared")) {
    throw new RequestError("functional_assistant_scope_denied", `Scope ${scope} is not available in ${mode} mode`);
  }
}

async function ensureSafeDirectory(target: string, storageRoot: string): Promise<void> {
  const root = resolve(storageRoot);
  assertInside(root, resolve(target), "path");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const rootInfo = await lstat(root);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw unsafeStatePath(root);
  const relative = resolve(target).slice(root.length).replace(/^\//, "");
  let current = root;
  for (const segment of relative.split("/").filter(Boolean)) {
    current = join(current, segment);
    const info = await safeLstat(current);
    if (!info) {
      await mkdir(current, { mode: 0o700 });
      continue;
    }
    if (info.isSymbolicLink() || !info.isDirectory()) throw unsafeStatePath(current);
  }
}

async function assertNoSymlinkPath(target: string, storageRoot: string): Promise<void> {
  const root = resolve(storageRoot);
  assertInside(root, resolve(target), "path");
  let current = root;
  for (const segment of resolve(target).slice(root.length).replace(/^\//, "").split("/").filter(Boolean)) {
    const info = await safeLstat(current);
    if (info?.isSymbolicLink()) throw unsafeStatePath(current);
    if (!info) return;
    current = join(current, segment);
  }
  const info = await safeLstat(current);
  if (info?.isSymbolicLink()) throw unsafeStatePath(current);
}

function normalizeRelativePath(value: string, allowEmpty: boolean): string {
  if (typeof value !== "string" || value.includes("\\") || value.includes("\0") || value.startsWith("/") || value.length > 512) {
    throw unsafeStatePath(String(value));
  }
  const segments = value.split("/");
  if ((segments.length === 1 && segments[0] === "") && allowEmpty) return "";
  if (segments.some((segment) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(segment) || segment === "." || segment === "..")) {
    throw unsafeStatePath(value);
  }
  return segments.join("/");
}

function assertFunctionId(value: string): void {
  if (!/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+\/[a-z][a-z0-9]*(?:[._/-][a-z0-9]+)*$/.test(value)) {
    throw new RequestError("invalid_functional_assistant_id", `Invalid functional assistant id: ${value}`);
  }
}

function assertAssistantId(value: string): void {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value)) throw new RequestError("invalid_assistant_id", `Invalid assistant id: ${value}`);
}

function assertInside(root: string, target: string, label: string): void {
  const normalizedRoot = resolve(root);
  const normalizedTarget = resolve(target);
  if (normalizedTarget !== normalizedRoot && !normalizedTarget.startsWith(`${normalizedRoot}/`)) {
    throw new RequestError("invalid_functional_assistant_state_path", `${label} escapes functional assistant state root`);
  }
}

function boundedInteger(value: number, min: number, max: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RequestError("invalid_functional_assistant_state", `${label} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function unsafeStatePath(value: string): RequestError {
  return new RequestError("invalid_functional_assistant_state_path", `Unsafe functional assistant state path: ${value}`);
}

async function safeLstat(path: string) {
  try { return await lstat(path); }
  catch (error) { if (isMissing(error)) return undefined; throw error; }
}

function isMissing(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT";
}
