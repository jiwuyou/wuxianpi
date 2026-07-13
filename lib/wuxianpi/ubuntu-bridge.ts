import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import type { CapabilityDescriptor, JsonValue, UbuntuStatusData } from "./contracts";
import { readWuxianPiConfig } from "./config-store";
import { getWuxianPiPaths } from "./paths";
import { requireExecutionPermission } from "./permission-manager";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

interface RpcResponse { id: string; result?: JsonValue; error?: { code: number; message: string } }
interface Pending { resolve: (value: JsonValue) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; cleanup: () => void }

declare global {
  var __wuxianpiUbuntuBridge: UbuntuBridge | undefined;
}

class UbuntuBridge {
  private process?: ChildProcessWithoutNullStreams;
  private pending = new Map<string, Pending>();
  private stderr = "";
  private idleTimer?: ReturnType<typeof setTimeout>;
  private startPromise?: Promise<void>;

  isRunning(): boolean { return Boolean(this.process && !this.process.killed && this.process.exitCode === null); }

  async start(): Promise<void> {
    if (this.isRunning()) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startProcess().finally(() => { this.startPromise = undefined; });
    return this.startPromise;
  }

  private async startProcess(): Promise<void> {
    const config = (await readWuxianPiConfig()).ubuntu;
    if (!config?.enabled) throw new Error("Ubuntu worker is disabled");
    const workerPath = process.env.WUXIANPI_UBUNTU_WORKER ?? path.join(process.cwd(), "workers", "ubuntu-worker.mjs");
    const childEnv: NodeJS.ProcessEnv = {
      NODE_ENV: process.env.NODE_ENV ?? "production",
      ...Object.fromEntries(["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "TERM", "PREFIX", "LD_PRELOAD"].flatMap((key) => process.env[key] ? [[key, process.env[key]!]] : [])),
      WUXIANPI_ASSISTANTS_ROOT: getWuxianPiPaths().assistants,
    };
    const child = spawn("proot-distro", ["login", config.distro ?? "ubuntu", "--", config.nodePath ?? "node", workerPath], {
      stdio: ["pipe", "pipe", "pipe"] as const, env: { ...childEnv, WUXIANPI_UBUNTU_WORKER_CHILD: "1" },
    });
    this.process = child;
    this.stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { this.stderr = `${this.stderr}${chunk.toString("utf8")}`.slice(-4000); });
    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => this.onLine(line));
    child.once("exit", (code, signal) => {
      this.process = undefined;
      const error = new Error(`Ubuntu worker exited (${code ?? signal ?? "unknown"}): ${this.stderr}`);
      for (const pending of this.pending.values()) { pending.cleanup(); pending.reject(error); }
      this.pending.clear();
    });
    try { await this.request("health", {}, 15_000); }
    catch (error) {
      child.kill("SIGTERM");
      this.process = undefined;
      throw error;
    }
  }

  private onLine(line: string): void {
    let response: RpcResponse;
    try { response = JSON.parse(line) as RpcResponse; } catch { return; }
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id); pending.cleanup();
    if (response.error) pending.reject(new Error(`${response.error.code}: ${response.error.message}`));
    else pending.resolve(response.result ?? null);
  }

  async request(method: string, params: JsonValue, timeoutMs = 120_000, signal?: AbortSignal): Promise<JsonValue> {
    if (signal?.aborted) throw new DOMException("Ubuntu RPC aborted", "AbortError");
    if (!this.isRunning() && method !== "ping") await this.start();
    if (signal?.aborted) throw new DOMException("Ubuntu RPC aborted", "AbortError");
    if (!this.process) throw new Error("Ubuntu worker is not running");
    this.resetIdleTimer();
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const paramsRecord = params && typeof params === "object" && !Array.isArray(params) ? params as Record<string, JsonValue> : {};
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); };
      const onAbort = () => {
        if (!this.pending.delete(id)) return;
        cleanup();
        if (method === "tools/call") this.sendCancellation(String(paramsRecord.assistantId ?? ""), String(paramsRecord.callId ?? ""));
        reject(new DOMException("Ubuntu RPC aborted", "AbortError"));
      };
      const timer = setTimeout(() => {
        this.pending.delete(id);
        cleanup();
        if (method === "tools/call") this.sendCancellation(String(paramsRecord.assistantId ?? ""), String(paramsRecord.callId ?? ""));
        reject(new Error(`Ubuntu RPC timed out: ${method}`));
      }, timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, { resolve, reject, timer, cleanup });
      this.process!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, (error) => {
        if (error) { this.pending.delete(id); cleanup(); reject(error); }
      });
    });
  }

  private sendCancellation(assistantId: string, callId: string): void {
    if (!this.process || !assistantId || !callId) return;
    this.process.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method: "cancel", params: { assistantId, callId } })}\n`);
  }

  async shutdown(): Promise<void> {
    if (!this.isRunning()) return;
    await this.request("shutdown", {}, 5_000).catch(() => undefined);
    this.process?.kill("SIGTERM");
    this.process = undefined;
    if (this.idleTimer) clearTimeout(this.idleTimer);
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    void readWuxianPiConfig().then((config) => {
      const timeout = config.ubuntu?.idleTimeoutMs ?? 5 * 60 * 1000;
      this.idleTimer = setTimeout(() => {
        if (this.pending.size > 0) this.resetIdleTimer();
        else void this.shutdown();
      }, timeout);
    });
  }
}

const bridge = () => globalThis.__wuxianpiUbuntuBridge ??= new UbuntuBridge();

export async function getUbuntuStatus(includeTools = false): Promise<UbuntuStatusData> {
  const config = (await readWuxianPiConfig()).ubuntu;
  const diagnostics: UbuntuStatusData["diagnostics"] = [];
  if (!config?.enabled) diagnostics.push({ level: "info", code: "ubuntu.disabled", message: "Ubuntu worker is disabled" });
  let tools: CapabilityDescriptor[] | undefined;
  if (includeTools && config?.enabled) {
    try { tools = (await bridge().request("tools/list", {})) as unknown as CapabilityDescriptor[]; }
    catch (error) { diagnostics.push({ level: "error", code: "ubuntu.unavailable", message: String(error) }); }
  }
  return { available: Boolean(config?.enabled), running: bridge().isRunning(), distro: config?.distro, tools, diagnostics };
}

export async function startUbuntuWorker(): Promise<void> { await bridge().start(); }
export async function callUbuntuTool(toolName: string, args: JsonValue | undefined, callId: string | undefined, assistantId: string, signal?: AbortSignal): Promise<JsonValue> {
  if (signal?.aborted) throw new DOMException("Ubuntu tool call aborted", "AbortError");
  await requireExecutionPermission(assistantId, "ubuntu:worker", {
    title: "Use Ubuntu worker",
    description: `Allow this assistant to call ${toolName} in its Ubuntu workspace`,
    risk: ["execute", "write"],
  });
  if (signal?.aborted) throw new DOMException("Ubuntu tool call aborted", "AbortError");
  return bridge().request("tools/call", { toolName, arguments: args ?? {}, callId: callId ?? randomUUID(), assistantId }, 120_000, signal);
}
export async function cancelUbuntuCall(callId: string, assistantId: string): Promise<JsonValue> { return bridge().request("cancel", { callId, assistantId }, 10_000); }
export async function shutdownUbuntuWorker(): Promise<void> { await bridge().shutdown(); }

export interface UbuntuToolDefinitionsResult { tools: ToolDefinition[]; diagnostics: UbuntuStatusData["diagnostics"] }

type UbuntuToolInvoker = (toolName: string, args: JsonValue | undefined, callId: string | undefined, assistantId: string, signal?: AbortSignal) => Promise<JsonValue>;

export function buildUbuntuToolDefinitions(descriptors: CapabilityDescriptor[], assistantId: string, invoke: UbuntuToolInvoker = callUbuntuTool): ToolDefinition[] {
  return descriptors.map<ToolDefinition>((tool) => ({
    name: `ubuntu__${tool.name.replace(/^ubuntu\./, "").replace(/[^a-zA-Z0-9_-]/g, "_")}`,
    label: tool.name,
    description: tool.description ?? tool.name,
    promptSnippet: `${tool.name}: ${tool.description ?? "Ubuntu workspace tool"}`,
    parameters: Type.Unsafe<Record<string, unknown>>((tool.metadata?.inputSchema ?? { type: "object" }) as Record<string, unknown>),
    execute: async (toolCallId, params, signal) => {
      const result = await invoke(tool.name, JSON.parse(JSON.stringify(params)) as JsonValue, toolCallId, assistantId, signal);
      const raw = result as { content?: unknown[]; isError?: boolean };
      const content = Array.isArray(raw.content) ? raw.content.filter((item): item is { type: "text"; text: string } => Boolean(item && typeof item === "object" && (item as Record<string, unknown>).type === "text" && typeof (item as Record<string, unknown>).text === "string")) : [];
      return { content: content.length ? content : [{ type: "text" as const, text: JSON.stringify(result) }], details: result, isError: Boolean(raw.isError) };
    },
  }));
}

export async function createUbuntuToolDefinitions(assistantId: string): Promise<UbuntuToolDefinitionsResult> {
  const status = await getUbuntuStatus(true);
  if (!status.tools?.length) return { tools: [], diagnostics: status.diagnostics };
  return { tools: buildUbuntuToolDefinitions(status.tools, assistantId), diagnostics: status.diagnostics };
}
