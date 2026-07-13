import { NextResponse } from "next/server";
import { existsSync } from "fs";
import { allowFileRoot } from "@/lib/file-access";
import { startRpcSession } from "@/lib/rpc-manager";
import type { NewAgentSessionRequest } from "@/lib/wuxianpi/contracts";
import { resolveAssistantRuntime } from "@/lib/wuxianpi/runtime-resolver";
import { createMcpToolDefinitions } from "@/lib/wuxianpi/mcp-manager";
import { readWuxianPiConfig } from "@/lib/wuxianpi/config-store";
import { createUbuntuToolDefinitions } from "@/lib/wuxianpi/ubuntu-bridge";

const DEFAULT_TOOL_NAMES = ["read", "bash", "edit", "write"];
const FULL_TOOL_NAMES = ["bash", "read", "edit", "write", "grep", "find", "ls"];

function sameToolSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const normalizedA = [...a].sort().join(",");
  const normalizedB = [...b].sort().join(",");
  return normalizedA === normalizedB;
}

function normalizeNewSessionToolNames(toolNames: unknown): string[] {
  if (!Array.isArray(toolNames)) return FULL_TOOL_NAMES;
  const names = toolNames.filter((name): name is string => typeof name === "string");
  if (names.length !== toolNames.length) return FULL_TOOL_NAMES;
  if (names.length === 0) return [];
  if (sameToolSet(names, DEFAULT_TOOL_NAMES)) return FULL_TOOL_NAMES;
  return names;
}

// POST /api/agent/new  body: { cwd: string; type: string; message?: string; ... }
// Spawns a brand-new pi session. Most calls immediately send the first command;
// type:"ensure_session" only creates the runtime so clients can query commands.
// Returns { sessionId, data } where sessionId is pi's real session id.
export async function POST(req: Request) {
  try {
    const body = await req.json() as NewAgentSessionRequest;
    const { assistantId, overrides, cwd: requestedCwd, ...command } = body;
    const resolved = assistantId ? await resolveAssistantRuntime(assistantId, overrides) : undefined;
    const cwd = resolved?.cwd ?? requestedCwd;

    if (!cwd || typeof cwd !== "string") {
      return NextResponse.json({ error: "cwd is required" }, { status: 400 });
    }
    if (!existsSync(cwd)) {
      return NextResponse.json({ error: `Directory does not exist: ${cwd}` }, { status: 400 });
    }

    // Use a one-time key so startRpcSession's lock doesn't conflict with real session ids
    const { provider, modelId, toolNames, thinkingLevel, ...promptCommand } = command;
    const selectedModel = resolved?.model ?? (provider && modelId ? { provider, modelId } : undefined);
    const selectedThinkingLevel = resolved?.thinkingLevel ?? thinkingLevel;
    const selectedToolNames = resolved?.toolNames ?? normalizeNewSessionToolNames(toolNames);
    const startupToolNames = selectedToolNames.filter((name) => name !== "ubuntu:worker");
    const mcpRuntime = resolved?.mcpServerIds.length ? await createMcpToolDefinitions(resolved.mcpServerIds, assistantId) : { tools: [], diagnostics: [] };
    const ubuntuRuntime = assistantId && selectedToolNames.includes("ubuntu:worker") ? await createUbuntuToolDefinitions(assistantId) : { tools: [], diagnostics: [] };
    const customTools = [...mcpRuntime.tools, ...ubuntuRuntime.tools];
    const runtimeDiagnostics = [...(resolved?.diagnostics ?? []), ...mcpRuntime.diagnostics, ...ubuntuRuntime.diagnostics];
    const runtimeConfig = await readWuxianPiConfig();

    const tempKey = `__new__${Date.now()}`;
    const { session, realSessionId } = await startRpcSession(tempKey, "", cwd, {
      toolNames: startupToolNames,
      skillNames: resolved?.skillNames,
      customTools,
      idleSessionMs: runtimeConfig.defaults.idleSessionMs,
      maxLiveSessions: runtimeConfig.defaults.maxLiveSessions,
      strictToolSelection: Boolean(resolved),
      assistantContextFiles: resolved ? ["MEMORY.md", "WORKSPACES.md"] : [],
      permissionAssistantId: assistantId,
      runtimeDiagnostics,
    });

    // Keep the files-route allowed-roots cache (see app/api/files/[...path]/route.ts)
    // in sync so the new cwd is immediately readable via /api/files. Without this,
    // a file request under a brand-new cwd would 403 for up to the cache TTL.
    allowFileRoot(cwd);

    // Apply pre-selected model before sending the prompt
    if (selectedModel) {
      await session.send({ type: "set_model", provider: selectedModel.provider, modelId: selectedModel.modelId });
    }

    // Apply pre-selected thinking level before sending the prompt
    if (selectedThinkingLevel) {
      await session.send({ type: "set_thinking_level", level: selectedThinkingLevel });
    }

    if (promptCommand.type === "ensure_session") {
      return NextResponse.json({ success: true, sessionId: realSessionId, data: null, diagnostics: runtimeDiagnostics });
    }

    const result = await session.send(promptCommand);

    return NextResponse.json({ success: true, sessionId: realSessionId, data: result, diagnostics: runtimeDiagnostics });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
