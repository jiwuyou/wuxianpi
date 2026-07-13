import type { AssistantManifestV1, CapabilityDiagnostic, ResolvedAssistantRuntime, SessionRuntimeOverrides } from "./contracts";
import { getAssistant } from "./assistant-manager";
import { readWuxianPiConfig } from "./config-store";
import { createPermissionRequest, getPermissionDecision } from "./permission-manager";
import { listWebExtensions } from "./web-extension-manager";

const TOOL_RISKS: Record<string, Array<"read" | "write" | "execute" | "network">> = {
  read: ["read"], grep: ["read"], find: ["read"], ls: ["read"],
  write: ["write"], edit: ["write"], bash: ["execute", "write", "network"],
};
const BUILTIN_TOOL_NAMES = new Set(Object.keys(TOOL_RISKS));

function runtimeToolName(configuredName: string): string {
  return configuredName.replace(/^pi-extension:/, "").replace(/^pi:/, "").replace(/^builtin:/, "");
}

function inheritArray<T>(assistantValue: T[] | "inherit" | undefined, globalValue: T[] | undefined): T[] {
  return assistantValue === "inherit" || assistantValue === undefined ? [...(globalValue ?? [])] : [...assistantValue];
}

function inheritValue<T>(assistantValue: T | "inherit" | undefined, globalValue: T | undefined): T | undefined {
  return assistantValue === "inherit" || assistantValue === undefined ? globalValue : assistantValue;
}

export async function resolveAssistantRuntime(
  assistantId: string,
  overrides: SessionRuntimeOverrides = {},
): Promise<ResolvedAssistantRuntime> {
  const [assistant, config] = await Promise.all([getAssistant(assistantId), readWuxianPiConfig()]);
  const manifest: AssistantManifestV1 = assistant.manifest;
  const diagnostics: CapabilityDiagnostic[] = [...assistant.diagnostics];
  const selectedTools = overrides.tools ?? inheritArray(manifest.tools, config.defaults.tools);
  const toolNames: string[] = [];

  for (const tool of selectedTools) {
    const normalizedTool = runtimeToolName(tool);
    const capabilityId = tool.includes(":") ? tool : `${BUILTIN_TOOL_NAMES.has(normalizedTool) ? "pi" : "pi-extension"}:${normalizedTool}`;
    const decision = await getPermissionDecision(assistantId, capabilityId);
    if (decision === "deny") {
      diagnostics.push({ capabilityId, level: "warning", code: "permission.denied", message: `${tool} is denied for this assistant` });
    } else if (!decision && (TOOL_RISKS[normalizedTool] ?? ["execute"]).some((risk) => risk !== "read")) {
      createPermissionRequest({ assistantId, capabilityId, title: `Enable ${tool}`, description: `Allow this assistant to use ${tool}`, risk: TOOL_RISKS[normalizedTool] ?? ["execute"] });
      diagnostics.push({ capabilityId, level: "warning", code: "permission.required", message: `${tool} requires approval` });
    } else {
      toolNames.push(normalizedTool);
    }
  }

  const mcpServerIds = overrides.mcpServers ?? inheritArray(manifest.mcpServers, config.defaults.mcpServers);
  const enabledMcp = new Set(config.mcpServers.filter((server) => server.enabled !== false).map((server) => server.id));
  const validMcp: string[] = [];
  for (const id of mcpServerIds) {
    if (!enabledMcp.has(id)) {
      diagnostics.push({ capabilityId: `mcp:${id}`, level: "warning", code: "mcp.unavailable", message: `MCP server ${id} is unavailable or disabled` });
      continue;
    }
    const capabilityId = `mcp:${id}`;
    const decision = await getPermissionDecision(assistantId, capabilityId);
    if (decision === "assistant" || decision === "once") validMcp.push(id);
    else {
      if (decision !== "deny") createPermissionRequest({ assistantId, capabilityId, title: `Enable ${id}`, description: `Allow this assistant to use MCP server ${id}`, risk: ["network", "external", "write"] });
      diagnostics.push({ capabilityId, level: "warning", code: decision === "deny" ? "permission.denied" : "permission.required", message: `MCP server ${id} requires approval` });
    }
  }

  const selectedWebExtensions = overrides.webExtensions ?? inheritArray(manifest.webExtensions, config.defaults.webExtensions);
  const extensionManifests = new Map((await listWebExtensions()).map((extension) => [extension.id, extension]));
  const validWebExtensions: string[] = [];
  for (const id of selectedWebExtensions) {
    const extension = extensionManifests.get(id);
    if (!extension) {
      diagnostics.push({ capabilityId: `web-extension:${id}`, level: "warning", code: "web_extension.unavailable", message: `Web extension ${id} is unavailable` });
      continue;
    }
    const risky = extension.permissions?.some((permission) => permission === "storage.write" || permission === "tools.call" || permission === "tts.speak");
    if (!risky) { validWebExtensions.push(id); continue; }
    const capabilityId = `web-extension:${id}`;
    const decision = await getPermissionDecision(assistantId, capabilityId);
    if (decision === "assistant" || decision === "once") validWebExtensions.push(id);
    else {
      if (decision !== "deny") createPermissionRequest({ assistantId, capabilityId, title: `Enable ${extension.name}`, description: `Allow this assistant to use web extension ${extension.name}`, risk: ["external", ...(extension.permissions?.includes("tools.call") ? ["execute" as const] : []), ...(extension.permissions?.includes("storage.write") ? ["write" as const] : []), ...(extension.permissions?.includes("tts.speak") ? ["audio" as const] : [])] });
      diagnostics.push({ capabilityId, level: "warning", code: decision === "deny" ? "permission.denied" : "permission.required", message: `Web extension ${id} requires approval` });
    }
  }

  return {
    assistantId,
    cwd: assistant.path,
    model: overrides.model ?? inheritValue(manifest.model, config.defaults.model),
    thinkingLevel: overrides.thinkingLevel ?? inheritValue(manifest.thinkingLevel, config.defaults.thinkingLevel),
    toolNames,
    skillNames: overrides.skills ?? inheritArray(manifest.skills, config.defaults.skills),
    mcpServerIds: validMcp,
    webExtensionIds: validWebExtensions,
    tts: overrides.tts ?? inheritValue(manifest.tts, config.defaults.tts),
    diagnostics,
  };
}

export async function resolveLegacyRuntime(cwd: string, toolNames?: string[]): Promise<ResolvedAssistantRuntime> {
  return {
    assistantId: "legacy",
    cwd,
    toolNames: toolNames ?? ["read", "bash", "edit", "write", "grep", "find", "ls"],
    skillNames: [],
    mcpServerIds: [],
    webExtensionIds: [],
    diagnostics: [],
  };
}
