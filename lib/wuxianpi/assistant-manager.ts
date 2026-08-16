import { lstat, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { strFromU8, unzipSync, zipSync } from "fflate";
import type {
  AssistantBundleV1,
  AssistantCreateRequest,
  AssistantFiles,
  AssistantManifestV1,
  AssistantSummary,
  AssistantUpdateRequest,
  CapabilityDiagnostic,
} from "./contracts";
import { WUXIANPI_SCHEMA_VERSION } from "./contracts";
import { listAllSessions } from "../session-reader";
import { allowFileRoot } from "../file-access";
import { assistantPath, assertSafeId, getWuxianPiPaths, isPathInside } from "./paths";
import { ensurePrivateDir, readJsonFile, removeIfExists, writeJsonAtomic } from "./storage";

export const DEFAULT_ASSISTANT_ID = "wuxianpi";

const DEFAULT_FILES: AssistantFiles = {
  agents: "# Identity\n\nYou are a helpful personal assistant.\n\n# Working style\n\n- Be concise, honest, and practical.\n",
  memory: "# Long-term memory\n\n",
  workspaces: "# External workspaces\n\nDescribe external paths and operating rules here.\n",
};

const DEFAULT_ASSISTANT_MANIFEST: AssistantManifestV1 = {
  schemaVersion: WUXIANPI_SCHEMA_VERSION,
  name: "WuxianPi",
  description: "默认个人助手",
  greeting: "你好，我是 WuxianPi。今天想聊些什么？",
  starterPrompts: ["帮我整理今天的任务", "帮我安装一个 AI 工具", "我想用 OpenHouse 实现一个想法", "帮我完成一个复杂任务"],
  model: "inherit",
  thinkingLevel: "inherit",
  tools: "inherit",
  skills: "inherit",
  mcpServers: "inherit",
  webExtensions: "inherit",
  tts: "inherit",
};

const DEFAULT_ASSISTANT_FILES: AssistantFiles = {
  agents: "# Identity\n\n你是 WuxianPi，运行在用户设备上的默认个人助手。\n\n# Working style\n\n- 简洁、诚实、可执行\n- 优先完成用户目标，不确定时先问清楚\n- 尊重用户隐私与本地数据边界\n",
  memory: "# Long-term memory\n\n",
  workspaces: "# External workspaces\n\nDescribe external paths and operating rules here.\n",
};

/** Ensure the built-in default assistant exists (id: wuxianpi). Idempotent. */
export async function ensureDefaultAssistant(): Promise<AssistantSummary> {
  const directory = assistantPath(DEFAULT_ASSISTANT_ID);
  const manifestFile = path.join(directory, "assistant.json");
  try {
    await lstat(manifestFile);
    return getAssistant(DEFAULT_ASSISTANT_ID);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  // Partial leftover directory (e.g. interrupted create) — remove and recreate.
  try {
    await lstat(directory);
    await removeIfExists(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  try {
    return await createAssistant({
      id: DEFAULT_ASSISTANT_ID,
      manifest: DEFAULT_ASSISTANT_MANIFEST,
      files: DEFAULT_ASSISTANT_FILES,
    });
  } catch (error) {
    // Concurrent create: prefer reading if it became valid.
    try {
      return await getAssistant(DEFAULT_ASSISTANT_ID);
    } catch {
      throw error;
    }
  }
}

function validateManifest(input: AssistantManifestV1 | null | undefined): AssistantManifestV1 {
  if (!input || input.schemaVersion !== WUXIANPI_SCHEMA_VERSION) throw new Error("Unsupported assistant schema");
  if (!input.name?.trim()) throw new Error("Assistant name is required");
  if (input.avatar && (path.isAbsolute(input.avatar) || input.avatar.includes(".."))) {
    throw new Error("Assistant avatar must be a relative path inside the assistant directory");
  }
  for (const [key, value] of Object.entries({ tools: input.tools, skills: input.skills, mcpServers: input.mcpServers, webExtensions: input.webExtensions })) {
    if (value !== undefined && value !== "inherit" && (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item))) throw new Error(`${key} must be inherit or a non-empty string array`);
  }
  if (input.starterPrompts && (!Array.isArray(input.starterPrompts) || input.starterPrompts.some((item) => typeof item !== "string"))) throw new Error("starterPrompts must be a string array");
  return { ...input, name: input.name.trim() };
}

async function verifyAssistantDirectory(directory: string): Promise<void> {
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Assistant path must be a real directory");
  if (!isPathInside(getWuxianPiPaths().assistants, directory)) throw new Error("Assistant path escapes assistants root");
}

async function readFiles(directory: string): Promise<AssistantFiles> {
  const read = async (name: string, fallback: string) => {
    try { return await readFile(path.join(directory, name), "utf8"); } catch { return fallback; }
  };
  return {
    agents: await read("AGENTS.md", DEFAULT_FILES.agents),
    memory: await read("MEMORY.md", DEFAULT_FILES.memory),
    workspaces: await read("WORKSPACES.md", DEFAULT_FILES.workspaces),
  };
}

export async function createAssistant(request: AssistantCreateRequest): Promise<AssistantSummary> {
  const id = assertSafeId(request.id, "assistant id");
  const directory = assistantPath(id);
  await ensurePrivateDir(getWuxianPiPaths().assistants);
  await mkdir(directory, { mode: 0o700 });
  try {
    const manifest = validateManifest(request.manifest);
    await writeJsonAtomic(path.join(directory, "assistant.json"), manifest);
    const files = { ...DEFAULT_FILES, ...(request.files ?? {}) };
    await Promise.all([
      writeFile(path.join(directory, "AGENTS.md"), files.agents, { mode: 0o600 }),
      writeFile(path.join(directory, "MEMORY.md"), files.memory, { mode: 0o600 }),
      writeFile(path.join(directory, "WORKSPACES.md"), files.workspaces, { mode: 0o600 }),
      mkdir(path.join(directory, "knowledge"), { recursive: true, mode: 0o700 }),
      mkdir(path.join(directory, ".pi", "skills"), { recursive: true, mode: 0o700 }),
      mkdir(path.join(directory, ".pi", "extensions"), { recursive: true, mode: 0o700 }),
    ]);
    allowFileRoot(directory);
    return await getAssistant(id);
  } catch (error) {
    await removeIfExists(directory);
    throw error;
  }
}

export async function getAssistant(id: string): Promise<AssistantSummary> {
  return getAssistantWithSessions(id, await listAllSessions());
}

async function getAssistantWithSessions(id: string, allSessions: Awaited<ReturnType<typeof listAllSessions>>): Promise<AssistantSummary> {
  const directory = assistantPath(id);
  await verifyAssistantDirectory(directory);
  const manifest = validateManifest(await readJsonFile<AssistantManifestV1 | null>(path.join(directory, "assistant.json"), null));
  const sessions = allSessions.filter((session) => path.resolve(session.cwd) === path.resolve(directory));
  return {
    id,
    path: directory,
    manifest,
    sessionCount: sessions.length,
    lastActiveAt: sessions.sort((a, b) => b.modified.localeCompare(a.modified))[0]?.modified,
    diagnostics: assistantDiagnostics(manifest),
  };
}

function assistantDiagnostics(manifest: AssistantManifestV1): CapabilityDiagnostic[] {
  const diagnostics: CapabilityDiagnostic[] = [];
  if (!manifest.description) diagnostics.push({ level: "info", code: "assistant.description_missing", message: "Assistant has no description" });
  return diagnostics;
}

export async function listAssistants(options: { includeArchived?: boolean } = {}): Promise<AssistantSummary[]> {
  await ensurePrivateDir(getWuxianPiPaths().assistants);
  await ensureDefaultAssistant();
  const [entries, sessions] = await Promise.all([readdir(getWuxianPiPaths().assistants, { withFileTypes: true }), listAllSessions()]);
  const results: AssistantSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(entry.name)) continue;
    try {
      const assistant = await getAssistantWithSessions(entry.name, sessions);
      if (options.includeArchived || !assistant.manifest.archived) results.push(assistant);
    } catch (error) {
      results.push({
        id: entry.name,
        path: assistantPath(entry.name),
        manifest: { schemaVersion: 1, name: entry.name },
        sessionCount: 0,
        diagnostics: [{ level: "error", code: "assistant.invalid", message: String(error) }],
      });
    }
  }
  return results.sort((a, b) => {
    // Keep the default assistant near the top when both lack recent activity.
    if (!a.lastActiveAt && !b.lastActiveAt) {
      if (a.id === DEFAULT_ASSISTANT_ID && b.id !== DEFAULT_ASSISTANT_ID) return -1;
      if (b.id === DEFAULT_ASSISTANT_ID && a.id !== DEFAULT_ASSISTANT_ID) return 1;
    }
    return (b.lastActiveAt ?? "").localeCompare(a.lastActiveAt ?? "") || a.manifest.name.localeCompare(b.manifest.name);
  });
}

export async function readAssistantBundle(id: string): Promise<AssistantBundleV1> {
  const assistant = await getAssistant(id);
  return { schemaVersion: 1, manifest: assistant.manifest, files: await readFiles(assistant.path) };
}

export async function updateAssistant(id: string, request: AssistantUpdateRequest): Promise<AssistantSummary> {
  const current = await getAssistant(id);
  if (request.manifest) {
    await writeJsonAtomic(path.join(current.path, "assistant.json"), validateManifest({ ...current.manifest, ...request.manifest, schemaVersion: 1 }));
  }
  if (request.files) {
    const mapping: Array<[keyof AssistantFiles, string]> = [["agents", "AGENTS.md"], ["memory", "MEMORY.md"], ["workspaces", "WORKSPACES.md"]];
    await Promise.all(mapping.filter(([key]) => request.files?.[key] !== undefined).map(([key, filename]) => writeFile(path.join(current.path, filename), request.files![key]!, { mode: 0o600 })));
  }
  return getAssistant(id);
}

export async function deleteAssistant(id: string, permanent = false): Promise<void> {
  const current = await getAssistant(id);
  if (permanent) {
    if (current.sessionCount > 0) throw new Error("Cannot permanently delete an assistant with sessions; archive it instead");
    await removeIfExists(current.path);
  } else {
    await updateAssistant(id, { manifest: { archived: true } });
  }
}

export async function cloneAssistant(id: string, newId: string, name?: string): Promise<AssistantSummary> {
  const bundle = await readAssistantBundle(id);
  const created = await createAssistant({ id: newId, manifest: { ...bundle.manifest, name: name?.trim() || `${bundle.manifest.name} copy`, archived: false }, files: bundle.files });
  try {
    await copyAssistantExtras(assistantPath(id), created.path);
    return getAssistant(newId);
  } catch (error) {
    await removeIfExists(created.path);
    throw error;
  }
}

export async function exportAssistantZip(id: string): Promise<Uint8Array> {
  const assistant = await getAssistant(id);
  const files: Record<string, Uint8Array> = {};
  await collectRegularFiles(assistant.path, assistant.path, files);
  return zipSync(files, { level: 6 });
}

export async function importAssistantZip(id: string, bytes: Uint8Array): Promise<AssistantSummary> {
  assertSafeId(id, "assistant id");
  if (bytes.byteLength > 20 * 1024 * 1024) throw new Error("Assistant bundle exceeds 20 MiB");
  let expandedBytes = 0;
  let fileCount = 0;
  const files = unzipSync(bytes, { filter: (entry) => {
    if (entry.name.startsWith("/") || entry.name.includes("..") || entry.name.includes("\\")) throw new Error("Unsafe path in assistant bundle");
    fileCount += 1;
    expandedBytes += entry.originalSize;
    if (fileCount > 2_000 || expandedBytes > 50 * 1024 * 1024 || entry.originalSize > 10 * 1024 * 1024) throw new Error("Assistant bundle expands beyond safety limits");
    return !entry.name.endsWith("/");
  } });
  if (!files["assistant.json"]) throw new Error("assistant.json is required");
  const manifest = validateManifest(JSON.parse(strFromU8(files["assistant.json"])) as AssistantManifestV1);
  const created = await createAssistant({
    id,
    manifest,
    files: {
      agents: files["AGENTS.md"] ? strFromU8(files["AGENTS.md"]) : DEFAULT_FILES.agents,
      memory: files["MEMORY.md"] ? strFromU8(files["MEMORY.md"]) : DEFAULT_FILES.memory,
      workspaces: files["WORKSPACES.md"] ? strFromU8(files["WORKSPACES.md"]) : DEFAULT_FILES.workspaces,
    },
  });
  try {
    for (const [name, data] of Object.entries(files)) {
      if (["assistant.json", "AGENTS.md", "MEMORY.md", "WORKSPACES.md"].includes(name)) continue;
      const target = path.join(created.path, name);
      if (!isPathInside(created.path, target)) throw new Error("Bundle path escaped assistant directory");
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, data, { mode: 0o600 });
    }
    return getAssistant(id);
  } catch (error) {
    await removeIfExists(created.path);
    throw error;
  }
}

export async function renameAssistant(id: string, newId: string): Promise<AssistantSummary> {
  const current = await getAssistant(id);
  if (current.sessionCount > 0) throw new Error("Cannot rename an assistant directory after sessions exist; clone it instead");
  const destination = assistantPath(newId);
  await rename(current.path, destination);
  return getAssistant(newId);
}

async function collectRegularFiles(
  root: string,
  current: string,
  output: Record<string, Uint8Array>,
  state: { count: number; totalBytes: number } = { count: 0, totalBytes: 0 },
): Promise<void> {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name);
    if (!isPathInside(root, absolute) || entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) await collectRegularFiles(root, absolute, output, state);
    else if (entry.isFile()) {
      const data = new Uint8Array(await readFile(absolute));
      if (data.byteLength > 10 * 1024 * 1024) throw new Error(`Assistant file exceeds 10 MiB: ${path.relative(root, absolute)}`);
      state.count += 1;
      state.totalBytes += data.byteLength;
      if (state.count > 2_000) throw new Error("Assistant contains more than 2,000 files");
      if (state.totalBytes > 50 * 1024 * 1024) throw new Error("Assistant export exceeds 50 MiB expanded size");
      output[path.relative(root, absolute).split(path.sep).join("/")] = data;
    }
  }
}

async function copyAssistantExtras(source: string, destination: string): Promise<void> {
  const files: Record<string, Uint8Array> = {};
  await collectRegularFiles(source, source, files);
  for (const [name, data] of Object.entries(files)) {
    if (["assistant.json", "AGENTS.md", "MEMORY.md", "WORKSPACES.md"].includes(name)) continue;
    const target = path.join(destination, name);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, data, { mode: 0o600 });
  }
}
