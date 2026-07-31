import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parse as parseJsonc, printParseErrorCode, type ParseError } from "jsonc-parser";

export type McpTransport = "stdio" | "streamable-http";
export type McpAuthMode = "oauth" | "bearer" | false;

export interface McpServerConfig {
  id: string;
  name: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  cwd?: string;
  url?: string;
  env?: Record<string, string>;
  envSecretRefs?: Record<string, string>;
  headers?: Record<string, string>;
  headerSecretRefs?: Record<string, string>;
  timeoutMs?: number;
  lifecycle?: "keep-alive" | "lazy" | "lazy-keep-alive" | "eager";
  auth?: McpAuthMode;
  enabled?: boolean;
}

const SAFE_SERVER_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

export class McpConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpConfigError";
  }
}

/**
 * Owns the standard user-global MCP document consumed by pi-mcp-adapter.
 * WuxianPi stores only assistant/default server selections in its own config.
 */
export class StandardMcpConfigStore {
  readonly path: string;

  constructor(path = join(homedir(), ".config", "mcp", "mcp.json")) {
    this.path = path;
  }

  async list(): Promise<McpServerConfig[]> {
    const document = await this.readDocument();
    const servers = isRecord(document.mcpServers) ? document.mcpServers : {};
    const configured: McpServerConfig[] = [];
    for (const [id, definition] of Object.entries(servers)) {
      if (!SAFE_SERVER_ID.test(id) || !isRecord(definition)) continue;
      configured.push(fromStandardServer(id, definition));
    }
    return configured.sort((left, right) => left.id.localeCompare(right.id));
  }

  async replace(servers: McpServerConfig[]): Promise<McpServerConfig[]> {
    const document = await this.readDocument();
    const previous = isRecord(document.mcpServers) ? document.mcpServers : {};
    const next: Record<string, unknown> = {};
    const ids = new Set<string>();

    for (const requested of servers) {
      const server = validateServer(requested);
      if (ids.has(server.id)) throw new McpConfigError(`Duplicate MCP server id: ${server.id}`);
      ids.add(server.id);
      const previousServer = previous[server.id];
      next[server.id] = toStandardServer(server, isRecord(previousServer) ? previousServer : {});
    }

    document.mcpServers = next;
    await writeJson(this.path, document);
    return Object.entries(next).map(([id, definition]) => fromStandardServer(id, definition as Record<string, unknown>));
  }

  async upsert(servers: McpServerConfig[]): Promise<McpServerConfig[]> {
    const document = await this.readDocument();
    const previous = isRecord(document.mcpServers) ? document.mcpServers : {};
    const next: Record<string, unknown> = { ...previous };
    const ids = new Set<string>();
    for (const requested of servers) {
      const server = validateServer(requested);
      if (ids.has(server.id)) throw new McpConfigError(`Duplicate MCP server id: ${server.id}`);
      ids.add(server.id);
      const previousServer = previous[server.id];
      next[server.id] = toStandardServer(server, isRecord(previousServer) ? previousServer : {});
    }
    document.mcpServers = next;
    await writeJson(this.path, document);
    return Object.entries(next).flatMap(([id, definition]) => isRecord(definition) ? [fromStandardServer(id, definition)] : []);
  }

  async remove(ids: string[]): Promise<McpServerConfig[]> {
    const document = await this.readDocument();
    const previous = isRecord(document.mcpServers) ? document.mcpServers : {};
    const next: Record<string, unknown> = { ...previous };
    for (const id of ids) delete next[id];
    document.mcpServers = next;
    await writeJson(this.path, document);
    return Object.entries(next).flatMap(([id, definition]) => isRecord(definition) ? [fromStandardServer(id, definition)] : []);
  }

  private async readDocument(): Promise<Record<string, unknown>> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if (isMissingFile(error)) return {};
      throw error;
    }

    const errors: ParseError[] = [];
    const parsed = parseJsonc(text, errors, { allowTrailingComma: true, disallowComments: false });
    if (errors.length > 0) {
      const detail = errors.map((error) => printParseErrorCode(error.error)).join(", ");
      throw new McpConfigError(`Unable to parse standard MCP config ${this.path}: ${detail}`);
    }
    if (!isRecord(parsed)) throw new McpConfigError(`Standard MCP config ${this.path} must be an object`);
    return parsed;
  }
}

function fromStandardServer(id: string, definition: Record<string, unknown>): McpServerConfig {
  const url = stringValue(definition.url);
  const command = stringValue(definition.command);
  return {
    id,
    name: stringValue(definition.name) ?? id,
    transport: url ? "streamable-http" : "stdio",
    ...(command ? { command } : {}),
    ...(stringList(definition.args) ? { args: stringList(definition.args) } : {}),
    ...(stringValue(definition.cwd) ? { cwd: stringValue(definition.cwd) } : {}),
    ...(url ? { url } : {}),
    ...(stringRecord(definition.env) ? { env: stringRecord(definition.env) } : {}),
    ...(stringRecord(definition.envSecretRefs) ? { envSecretRefs: stringRecord(definition.envSecretRefs) } : {}),
    ...(stringRecord(definition.headers) ? { headers: stringRecord(definition.headers) } : {}),
    ...(stringRecord(definition.headerSecretRefs) ? { headerSecretRefs: stringRecord(definition.headerSecretRefs) } : {}),
    ...(positiveNumber(definition.requestTimeoutMs) ?? positiveNumber(definition.timeoutMs) ? {
      timeoutMs: positiveNumber(definition.requestTimeoutMs) ?? positiveNumber(definition.timeoutMs),
    } : {}),
    ...(isLifecycle(definition.lifecycle) ? { lifecycle: definition.lifecycle } : {}),
    ...(isAuthMode(definition.auth) ? { auth: definition.auth } : {}),
    enabled: definition.disabled !== true,
  };
}

function toStandardServer(server: McpServerConfig, previous: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...previous, name: server.name };
  if (server.transport === "stdio") {
    next.command = server.command;
    next.args = server.args ?? [];
    assignOptional(next, "cwd", server.cwd);
    delete next.url;
  } else {
    next.url = server.url;
    delete next.command;
    delete next.args;
    delete next.cwd;
  }
  assignRecord(next, "env", server.env);
  assignRecord(next, "envSecretRefs", server.envSecretRefs);
  assignRecord(next, "headers", server.headers);
  assignRecord(next, "headerSecretRefs", server.headerSecretRefs);
  if (server.timeoutMs !== undefined) next.requestTimeoutMs = server.timeoutMs;
  if (server.lifecycle !== undefined) next.lifecycle = server.lifecycle;
  if (server.auth !== undefined) next.auth = server.auth;
  else delete next.auth;
  if (server.enabled === false) next.disabled = true;
  else delete next.disabled;
  return next;
}

function validateServer(value: McpServerConfig): McpServerConfig {
  if (!value || typeof value !== "object") throw new McpConfigError("MCP server must be an object");
  const id = typeof value.id === "string" ? value.id.trim() : "";
  if (!SAFE_SERVER_ID.test(id)) throw new McpConfigError(`Invalid MCP server id: ${id || "(empty)"}`);
  const name = typeof value.name === "string" && value.name.trim() ? value.name.trim() : id;
  const transport = value.transport;
  if (transport !== "stdio" && transport !== "streamable-http") {
    throw new McpConfigError(`Invalid transport for MCP server ${id}`);
  }
  if (transport === "stdio" && (!value.command || !value.command.trim())) {
    throw new McpConfigError(`MCP server ${id} requires a command`);
  }
  if (transport === "streamable-http") {
    try {
      const url = new URL(value.url ?? "");
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsupported protocol");
    } catch {
      throw new McpConfigError(`MCP server ${id} requires an HTTP URL`);
    }
  }
  if (value.timeoutMs !== undefined && (!Number.isFinite(value.timeoutMs) || value.timeoutMs <= 0)) {
    throw new McpConfigError(`MCP server ${id} timeout must be positive`);
  }
  return {
    ...value,
    id,
    name,
    ...(value.command ? { command: value.command.trim() } : {}),
    ...(value.url ? { url: value.url.trim() } : {}),
    ...(value.args ? { args: value.args.map(String) } : {}),
  };
}

function assignOptional(target: Record<string, unknown>, key: string, value: string | undefined): void {
  if (value === undefined || value === "") delete target[key];
  else target[key] = value;
}

function assignRecord(target: Record<string, unknown>, key: string, value: Record<string, string> | undefined): void {
  if (value !== undefined) target[key] = value;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value);
  return entries.every(([, item]) => typeof item === "string") ? Object.fromEntries(entries) as Record<string, string> : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function isLifecycle(value: unknown): value is NonNullable<McpServerConfig["lifecycle"]> {
  return value === "keep-alive" || value === "lazy" || value === "lazy-keep-alive" || value === "eager";
}

function isAuthMode(value: unknown): value is McpAuthMode {
  return value === "oauth" || value === "bearer" || value === false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT";
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}
