import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import type { CapabilityDescriptor, JsonValue, UbuntuStatusData } from "./contracts";
import { readWuxianPiConfig } from "./config-store";

interface RpcResponse { id: string; result?: JsonValue; error?: { code: number; message: string } }
interface Pending { resolve: (value: JsonValue) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }

declare global {
  var __wuxianpiUbuntuBridge: UbuntuBridge | undefined;
}

class UbuntuBridge {
  private process?: ChildProcessWithoutNullStreams;
  private pending = new Map<string, Pending>();
  private stderr = "";
  private idleTimer?: ReturnType<typeof setTimeout>;

  isRunning(): boolean { return Boolean(this.process && !this.process.killed && this.process.exitCode === null); }

  async start(): Promise<void> {
    if (this.isRunning()) return;
    const config = (await readWuxianPiConfig()).ubuntu;
    if (!config?.enabled) throw new Error("Ubuntu worker is disabled");
    const workerPath = process.env.WUXIANPI_UBUNTU_WORKER ?? path.join(process.cwd(), "workers", "ubuntu-worker.mjs");
    const childEnv: NodeJS.ProcessEnv = {
      NODE_ENV: process.env.NODE_ENV ?? "production",
      ...Object.fromEntries(["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "TERM", "PREFIX", "LD_PRELOAD"].flatMap((key) => process.env[key] ? [[key, process.env[key]!]] : [])),
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
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
      this.pending.clear();
    });
    await this.request("health", {}, 15_000);
  }

  private onLine(line: string): void {
    let response: RpcResponse;
    try { response = JSON.parse(line) as RpcResponse; } catch { return; }
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id); clearTimeout(pending.timer);
    if (response.error) pending.reject(new Error(`${response.error.code}: ${response.error.message}`));
    else pending.resolve(response.result ?? null);
  }

  async request(method: string, params: JsonValue, timeoutMs = 120_000): Promise<JsonValue> {
    if (!this.isRunning() && method !== "ping") await this.start();
    if (!this.process) throw new Error("Ubuntu worker is not running");
    this.resetIdleTimer();
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Ubuntu RPC timed out: ${method}`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.process!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, (error) => {
        if (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
      });
    });
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
      this.idleTimer = setTimeout(() => void this.shutdown(), config.ubuntu?.idleTimeoutMs ?? 5 * 60 * 1000);
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
export async function callUbuntuTool(toolName: string, args: JsonValue | undefined, callId?: string, assistantId?: string): Promise<JsonValue> {
  return bridge().request("tools/call", { toolName, arguments: args ?? {}, callId: callId ?? randomUUID(), ...(assistantId ? { assistantId } : {}) });
}
export async function cancelUbuntuCall(callId: string): Promise<JsonValue> { return bridge().request("cancel", { callId }, 10_000); }
export async function shutdownUbuntuWorker(): Promise<void> { await bridge().shutdown(); }
