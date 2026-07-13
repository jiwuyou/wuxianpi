import { DefaultResourceLoader, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { CapabilityCatalog, CapabilityDescriptor, CapabilityDiagnostic, CapabilityRisk } from "./contracts";
import { readWuxianPiConfig } from "./config-store";
import { listWebExtensions } from "./web-extension-manager";

const BUILTIN_TOOLS: Array<[string, string, CapabilityRisk[]]> = [
  ["read", "Read files", ["read"]], ["grep", "Search file contents", ["read"]], ["find", "Find files", ["read"]], ["ls", "List directories", ["read"]],
  ["write", "Write files", ["write"]], ["edit", "Edit files", ["write"]], ["bash", "Run shell commands", ["execute", "write", "network"]],
];

export async function buildCapabilityCatalog(cwd?: string): Promise<CapabilityCatalog> {
  const config = await readWuxianPiConfig();
  const capabilities: CapabilityDescriptor[] = BUILTIN_TOOLS.map(([id, description, risk]) => ({
    id: `pi:${id}`, name: id, description, source: "pi-builtin", risk, status: "available", assistantSelectable: true,
  }));
  const diagnostics: CapabilityDiagnostic[] = [];

  try {
    const loader = new DefaultResourceLoader({ cwd: cwd ?? process.cwd(), agentDir: getAgentDir() });
    await loader.reload();
    const skillsResult = loader.getSkills();
    for (const skill of skillsResult.skills) capabilities.push({
      id: `skill:${skill.name}`, name: skill.name, description: skill.description, source: "skill", risk: ["read"], status: "available", assistantSelectable: true,
      metadata: { filePath: skill.filePath ?? "" },
    });
    for (const diagnostic of skillsResult.diagnostics) diagnostics.push({ level: "warning", code: "skill.diagnostic", message: String(diagnostic.message ?? diagnostic) });
    const extensionsResult = loader.getExtensions();
    for (const extension of extensionsResult.extensions) {
      for (const [name, tool] of extension.tools) capabilities.push({
        id: `pi-extension:${name}`, name, description: tool.definition.description, source: "pi-extension", risk: ["execute"], status: "available", assistantSelectable: true,
        metadata: { extensionPath: extension.path },
      });
    }
    for (const extensionError of extensionsResult.errors) diagnostics.push({ level: "warning", code: "extension.load_failed", message: `${extensionError.path}: ${extensionError.error}` });
  } catch (error) {
    diagnostics.push({ level: "warning", code: "skill.discovery_failed", message: String(error) });
  }

  for (const server of config.mcpServers) capabilities.push({
    id: `mcp:${server.id}`, name: server.name, description: `${server.transport} MCP server`, source: "mcp", risk: ["external", "network"],
    status: server.enabled === false ? "unavailable" : "available", assistantSelectable: true, metadata: { runtime: server.runtime ?? "termux", transport: server.transport },
  });
  for (const profile of config.ttsProfiles) capabilities.push({
    id: `tts:${profile.id}`, name: profile.name, description: profile.provider, source: "tts", risk: profile.provider === "browser-speech" || profile.provider === "termux-api" ? ["audio"] : ["audio", "network"],
    status: profile.enabled === false ? "unavailable" : "available", assistantSelectable: true,
  });
  for (const extension of await listWebExtensions()) capabilities.push({
    id: `web-extension:${extension.id}`, name: extension.name, description: extension.description, source: "web-extension", risk: [
      ...(extension.permissions?.includes("assistant.read") || extension.permissions?.includes("storage.read") ? ["read" as const] : []),
      ...(extension.permissions?.includes("storage.write") ? ["write" as const] : []),
      ...(extension.permissions?.includes("tools.call") ? ["execute" as const, "external" as const] : []),
      ...(extension.permissions?.includes("tts.speak") ? ["audio" as const] : []),
    ],
    status: "available", assistantSelectable: true, metadata: { version: extension.version },
  });
  if (config.ubuntu?.enabled) capabilities.push({ id: "ubuntu:worker", name: "Ubuntu tool worker", source: "ubuntu", risk: ["execute", "write"], status: "available", assistantSelectable: true });

  return { generatedAt: new Date().toISOString(), capabilities, diagnostics };
}
