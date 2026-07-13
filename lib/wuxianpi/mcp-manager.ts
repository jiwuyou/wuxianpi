import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createHash } from "node:crypto";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { CapabilityDescriptor, CapabilityDiagnostic, JsonValue, McpServerConfig } from "./contracts";
import { readWuxianPiConfig } from "./config-store";
import { resolveSecretMap } from "./secret-store";
import { requireExecutionPermission } from "./permission-manager";

interface ManagedMcpClient {
  client: Client;
  configFingerprint: string;
  lastUsedAt: number;
  closeTimer?: ReturnType<typeof setTimeout>;
}

declare global {
  var __wuxianpiMcpClients: Map<string, ManagedMcpClient> | undefined;
  var __wuxianpiMcpCalls: Map<string, { controller: AbortController; assistantId?: string; serverId: string }> | undefined;
  var __wuxianpiMcpClientLocks: Map<string, Promise<{ client: Client; config: McpServerConfig }>> | undefined;
}

const clients = () => globalThis.__wuxianpiMcpClients ??= new Map();
const calls = () => globalThis.__wuxianpiMcpCalls ??= new Map<string, { controller: AbortController; assistantId?: string; serverId: string }>();
const clientLocks = () => globalThis.__wuxianpiMcpClientLocks ??= new Map();

function normalizeJson(value: unknown): JsonValue {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function getToolRisk(tool: { annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean } }): CapabilityDescriptor["risk"] {
  const risk: CapabilityDescriptor["risk"] = [];
  if (tool.annotations?.readOnlyHint) risk.push("read"); else risk.push("write");
  if (tool.annotations?.destructiveHint) risk.push("execute");
  if (tool.annotations?.openWorldHint !== false) risk.push("network", "external");
  return [...new Set(risk)];
}

function fingerprint(config: McpServerConfig): string {
  return JSON.stringify(config);
}

async function configById(serverId: string): Promise<McpServerConfig> {
  const server = (await readWuxianPiConfig()).mcpServers.find((item) => item.id === serverId);
  if (!server) throw new Error(`Unknown MCP server: ${serverId}`);
  if (server.enabled === false) throw new Error(`MCP server is disabled: ${serverId}`);
  return server;
}

async function createTransport(config: McpServerConfig) {
  if (config.transport === "stdio") {
    if (!config.command) throw new Error(`MCP stdio server ${config.id} is missing command`);
    const env = { ...getDefaultEnvironment(), ...(await resolveSecretMap(config.env, config.envSecretRefs)) };
    let command = config.command;
    let args = config.args ?? [];
    if (config.runtime === "ubuntu") {
      const ubuntu = (await readWuxianPiConfig()).ubuntu;
      if (!ubuntu?.enabled) throw new Error("Ubuntu runtime is disabled");
      command = "proot-distro";
      args = ["login", ubuntu.distro ?? "ubuntu", "--", config.command, ...args];
    }
    return new StdioClientTransport({ command, args, cwd: config.cwd, env, stderr: "pipe" });
  }
  if (!config.url) throw new Error(`MCP HTTP server ${config.id} is missing url`);
  const headers = await resolveSecretMap(config.headers, config.headerSecretRefs);
  return new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers } });
}

async function connectClient(serverId: string): Promise<{ client: Client; config: McpServerConfig }> {
  const config = await configById(serverId);
  const key = serverId;
  const existing = clients().get(key);
  const currentFingerprint = fingerprint(config);
  if (existing && existing.configFingerprint === currentFingerprint) {
    existing.lastUsedAt = Date.now();
    if (existing.closeTimer) clearTimeout(existing.closeTimer);
    existing.closeTimer = setTimeout(() => closeMcpClient(serverId), 10 * 60 * 1000);
    return { client: existing.client, config };
  }
  if (existing) await closeMcpClient(serverId);
  const client = new Client({ name: "wuxianpi", version: "1.0.0" }, { capabilities: {} });
  const transport = await createTransport(config);
  if (transport instanceof StdioClientTransport) transport.stderr?.on("data", () => undefined);
  let connectTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      client.connect(transport),
      new Promise<never>((_, reject) => { connectTimer = setTimeout(() => reject(new Error(`MCP connection timed out: ${serverId}`)), config.timeoutMs ?? 30_000); }),
    ]);
  } catch (error) {
    await transport.close().catch(() => undefined);
    throw error;
  } finally {
    if (connectTimer) clearTimeout(connectTimer);
  }
  const managed: ManagedMcpClient = { client, configFingerprint: currentFingerprint, lastUsedAt: Date.now() };
  managed.closeTimer = setTimeout(() => closeMcpClient(serverId), 10 * 60 * 1000);
  clients().set(key, managed);
  return { client, config };
}

async function getClient(serverId: string): Promise<{ client: Client; config: McpServerConfig }> {
  const existingLock = clientLocks().get(serverId);
  if (existingLock) return existingLock;
  const lock = connectClient(serverId).finally(() => clientLocks().delete(serverId));
  clientLocks().set(serverId, lock);
  return lock;
}

export async function closeMcpClient(serverId: string): Promise<void> {
  const managed = clients().get(serverId);
  if (!managed) return;
  clients().delete(serverId);
  if (managed.closeTimer) clearTimeout(managed.closeTimer);
  await managed.client.close().catch(() => undefined);
}

export async function testMcpServer(serverId: string): Promise<void> {
  const { client, config } = await getClient(serverId);
  await client.ping({ signal: AbortSignal.timeout(config.timeoutMs ?? 30_000) });
}

export async function listMcpTools(serverId: string): Promise<CapabilityDescriptor[]> {
  const { client, config } = await getClient(serverId);
  const result = await client.listTools(undefined, { signal: AbortSignal.timeout(config.timeoutMs ?? 30_000) });
  return result.tools.map((tool) => ({
    id: `mcp:${serverId}:${tool.name}`,
    name: tool.name,
    description: tool.description,
    source: "mcp",
    risk: getToolRisk(tool),
    status: "available",
    assistantSelectable: true,
    metadata: { serverId, inputSchema: normalizeJson(tool.inputSchema) },
  }));
}

export async function callMcpTool(
  serverId: string,
  toolName: string,
  args: JsonValue | undefined,
  options: { callId?: string; signal?: AbortSignal; assistantId?: string } = {},
): Promise<JsonValue> {
  const callId = options.callId ?? `${serverId}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
  if (calls().has(callId)) throw new Error(`MCP callId already exists: ${callId}`);
  if (options.assistantId) {
    await requireExecutionPermission(options.assistantId, `mcp:${serverId}`, {
      title: "Use MCP server",
      description: `Allow this assistant to call ${serverId}`,
      risk: ["network", "external", "write"],
    });
  }
  const { client, config } = await getClient(serverId);
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  calls().set(callId, { controller, assistantId: options.assistantId, serverId });
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? 60_000);
  try {
    const result = await client.callTool(
      { name: toolName, arguments: (args && typeof args === "object" && !Array.isArray(args) ? args : {}) as Record<string, unknown> },
      undefined,
      { signal: controller.signal },
    );
    return normalizeJson(result);
  } finally {
    clearTimeout(timeout);
    calls().delete(callId);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

export function cancelMcpCall(callId: string, assistantId?: string): boolean {
  const call = calls().get(callId);
  if (!call || (call.assistantId && call.assistantId !== assistantId)) return false;
  call.controller.abort();
  return true;
}

function piToolName(serverId: string, toolName: string): string {
  const hash = createHash("sha256").update(`${serverId}\u0000${toolName}`).digest("hex").slice(0, 8);
  return `mcp__${serverId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 24)}__${toolName.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 32)}__${hash}`;
}

export interface McpToolDefinitionsResult { tools: ToolDefinition[]; diagnostics: CapabilityDiagnostic[] }

export async function createMcpToolDefinitions(serverIds: string[], assistantId?: string): Promise<McpToolDefinitionsResult> {
  const definitions: ToolDefinition[] = [];
  const diagnostics: CapabilityDiagnostic[] = [];
  for (const serverId of serverIds) {
    let result: Awaited<ReturnType<Client["listTools"]>>;
    try {
      const { client, config } = await getClient(serverId);
      result = await client.listTools(undefined, { signal: AbortSignal.timeout(config.timeoutMs ?? 30_000) });
    } catch (error) {
      diagnostics.push({ capabilityId: `mcp:${serverId}`, level: "error", code: "mcp.connection_failed", message: error instanceof Error ? error.message : String(error) });
      continue;
    }
    for (const tool of result.tools) {
      const schema = Type.Unsafe<Record<string, unknown>>(tool.inputSchema);
      definitions.push({
        name: piToolName(serverId, tool.name),
        label: `${serverId}: ${tool.name}`,
        description: tool.description ?? `Call ${tool.name} on MCP server ${serverId}`,
        promptSnippet: `${tool.name}: ${tool.description ?? "MCP tool"}`,
        parameters: schema,
        execute: async (toolCallId, params, signal) => {
          const resultValue = await callMcpTool(serverId, tool.name, normalizeJson(params), { callId: toolCallId, signal, assistantId });
          const raw = resultValue as { content?: unknown[]; isError?: boolean };
          const supportedContent = Array.isArray(raw.content) ? raw.content.filter((item): item is { type: "text"; text: string } | { type: "image"; data: string; mimeType: string } => {
            if (!item || typeof item !== "object") return false;
            const candidate = item as Record<string, unknown>;
            return (candidate.type === "text" && typeof candidate.text === "string") || (candidate.type === "image" && typeof candidate.data === "string" && typeof candidate.mimeType === "string");
          }) : [];
          const content = supportedContent.length ? supportedContent : [{ type: "text" as const, text: JSON.stringify(resultValue) }];
          return { content, details: { serverId, toolName: tool.name, raw: resultValue }, isError: Boolean(raw.isError) };
        },
      });
    }
  }
  return { tools: definitions, diagnostics };
}
