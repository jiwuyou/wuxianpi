import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";
import { RequestError } from "./protocol.js";
import { assertEntityId, normalizeAbsolutePath } from "./profile-state-store.js";
import type {
  AssembleProfileContextInput,
  AssembledProfileContext,
  ProfileContextResource,
  ProfileContextResourceKind,
  SuppliedProfileContext,
} from "./profile-types.js";
import type { WorkspaceManager } from "./workspace-manager.js";

export interface ProfileContextAssemblerOptions {
  sharedUserPath: string;
  assistantsRoot: string;
  workspaceManager: WorkspaceManager;
}

interface ContextSection {
  kind: ProfileContextResourceKind;
  id: string;
  title: string;
  content: string;
  sourcePath?: string;
}

export class ProfileContextAssembler {
  private readonly sharedUserPath: string;
  private readonly assistantsRoot: string;
  private readonly workspaceManager: WorkspaceManager;

  constructor(options: ProfileContextAssemblerOptions) {
    this.sharedUserPath = normalizeAbsolutePath(options.sharedUserPath, "shared USER.md path");
    this.assistantsRoot = normalizeAbsolutePath(options.assistantsRoot, "assistants root");
    this.workspaceManager = options.workspaceManager;
  }

  async assemble(input: AssembleProfileContextInput): Promise<AssembledProfileContext> {
    assertEntityId(input.assistantId, "assistant id");
    if (input.workspaceId !== undefined && input.workspaceId !== null) assertEntityId(input.workspaceId, "workspace id");
    const assistantDirectory = join(this.assistantsRoot, input.assistantId);
    const assistantInfo = await lstat(assistantDirectory).catch((error: unknown) => {
      if (isMissing(error)) throw new RequestError("assistant_not_found", `Assistant not found: ${input.assistantId}`);
      throw error;
    });
    if (!assistantInfo.isDirectory() || assistantInfo.isSymbolicLink()) {
      throw new RequestError("assistant_not_found", `Assistant is not a regular directory: ${input.assistantId}`);
    }

    const [sharedUser, agents, memory, workspace] = await Promise.all([
      readOptional(this.sharedUserPath),
      readOptional(join(assistantDirectory, "AGENTS.md")),
      readOptional(join(assistantDirectory, "MEMORY.md")),
      input.workspaceId ? this.workspaceManager.get(input.workspaceId) : undefined,
    ]);

    const sections: ContextSection[] = [];
    addSection(sections, "shared-user", "shared-user", "Shared user profile", sharedUser, this.sharedUserPath);
    addSection(sections, "assistant-agents", input.assistantId, "Assistant identity and behavior", agents,
      join(assistantDirectory, "AGENTS.md"));
    addSection(sections, "assistant-memory", input.assistantId, "Assistant long-term memory", memory,
      join(assistantDirectory, "MEMORY.md"));
    if (workspace) {
      addSection(sections, "workspace-instructions", workspace.workspace.id, "Workspace instructions", workspace.instructions,
        workspace.instructionsPath);
      addSection(sections, "workspace-memory", workspace.workspace.id, "Workspace memory", workspace.memory,
        workspace.memoryPath);
    }
    addSuppliedSections(sections, "package-context", "Package context", input.packageContexts ?? []);
    addSuppliedSections(sections, "functional-assistant-context", "Functional assistant context",
      input.functionalAssistantContexts ?? []);

    const resources: ProfileContextResource[] = sections.map((section, order) => ({
      order,
      kind: section.kind,
      id: section.id,
      title: section.title,
      ...(section.sourcePath ? { sourcePath: section.sourcePath } : {}),
      sha256: createHash("sha256").update(section.content).digest("hex"),
      sizeBytes: Buffer.byteLength(section.content),
    }));
    return {
      assistantId: input.assistantId,
      workspaceId: input.workspaceId ?? null,
      prompt: sections.length === 0 ? "" : `${sections.map(renderSection).join("\n\n")}\n`,
      resources,
    };
  }
}

function addSection(
  sections: ContextSection[],
  kind: ProfileContextResourceKind,
  id: string,
  title: string,
  content: string,
  sourcePath?: string,
): void {
  const normalized = normalizeContent(content);
  if (!normalized) return;
  sections.push({ kind, id, title, content: normalized, ...(sourcePath ? { sourcePath } : {}) });
}

function addSuppliedSections(
  sections: ContextSection[],
  kind: "package-context" | "functional-assistant-context",
  defaultTitle: string,
  supplied: SuppliedProfileContext[],
): void {
  const seen = new Set<string>();
  const normalized = supplied.map((item) => {
    assertContextId(item.id, `${defaultTitle} id`);
    if (seen.has(item.id)) throw new RequestError("duplicate_profile_context", `Duplicate ${defaultTitle} id: ${item.id}`);
    seen.add(item.id);
    if (item.sourcePath !== undefined && (!isAbsolute(item.sourcePath) || item.sourcePath.includes("\0"))) {
      throw new RequestError("invalid_profile_path", `${defaultTitle} sourcePath must be absolute`);
    }
    return {
      kind,
      id: item.id,
      title: item.title?.trim() || `${defaultTitle}: ${item.id}`,
      content: normalizeContent(item.content),
      ...(item.sourcePath ? { sourcePath: normalize(item.sourcePath) } : {}),
    } satisfies ContextSection;
  }).filter((item) => item.content);
  normalized.sort((left, right) => compareText(left.id, right.id) || compareText(left.title, right.title));
  sections.push(...normalized);
}

function renderSection(section: ContextSection): string {
  return `## ${section.title}\n${section.content}`;
}

function normalizeContent(content: string): string {
  if (typeof content !== "string") throw new RequestError("invalid_profile_context", "Profile context content must be text");
  return content.replaceAll("\r\n", "\n").trim();
}

function assertContextId(value: string, label: string): void {
  if (typeof value !== "string" || !value || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new RequestError("invalid_profile_context_id", `${label} must be a non-empty printable string`);
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function readOptional(path: string): Promise<string> {
  try { return await readFile(path, "utf8"); }
  catch (error) {
    if (isMissing(error)) return "";
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT";
}
