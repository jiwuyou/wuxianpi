import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { RequestError } from "./protocol.js";
import type { CardWorkflow, ExecutableCardSpec, JsonValue, TemplateValue } from "./executable-card.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 50 * 1024;

export interface CardExecutionContext {
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
}

interface TemplateContext {
  fields: Record<string, JsonValue>;
  steps: Record<string, unknown>;
  env: NodeJS.ProcessEnv;
}

export class CardExecutor {
  async execute(spec: ExecutableCardSpec, values: Record<string, JsonValue>, context: CardExecutionContext): Promise<unknown> {
    const template: TemplateContext = { fields: values, steps: {}, env: context.env };
    return this.executeWorkflow(spec.workflow, template, { ...context, cwd: spec.cwd ? resolve(context.cwd, spec.cwd) : context.cwd });
  }

  private async executeWorkflow(workflow: CardWorkflow, template: TemplateContext, context: CardExecutionContext): Promise<unknown> {
    if (workflow.type === "sequence") {
      const results: unknown[] = [];
      for (let index = 0; index < workflow.steps.length; index += 1) {
        try {
          const result = await this.executeWorkflow(workflow.steps[index]!, template, context);
          results.push(result);
          template.steps[String(index)] = result;
        } catch (error) {
          if (workflow.stopOnError !== false) throw error;
          const failed = { error: error instanceof Error ? error.message : String(error) };
          results.push(failed);
          template.steps[String(index)] = failed;
        }
      }
      return { steps: results };
    }
    if (workflow.type === "http") return this.executeHttp(workflow, template, context);
    if (workflow.type === "script") return this.executeScript(workflow, template, context);
    const cwd = workflow.cwd === undefined ? context.cwd : resolveCwd(resolveTemplate(workflow.cwd, template), context.cwd);
    const env = resolveEnv(workflow.env, template, context.env);
    if (workflow.type === "process") {
      const command = asString(resolveTemplate(workflow.command, template), "process.command");
      const args = (workflow.args ?? []).map((value) => asArgument(resolveTemplate(value, template)));
      return executeProcess(command, args, { cwd, env, timeoutMs: workflow.timeoutMs, signal: context.signal });
    }
    const shell = workflow.shell || process.env.SHELL || "sh";
    const script = asString(resolveTemplate(workflow.script, template), "shell.script");
    return executeProcess(shell, ["-lc", script], { cwd, env, timeoutMs: workflow.timeoutMs, signal: context.signal });
  }

  private async executeScript(workflow: Extract<CardWorkflow, { type: "script" }>, template: TemplateContext, context: CardExecutionContext): Promise<unknown> {
    const directory = await mkdtemp(join(tmpdir(), "wuxianpi-card-"));
    const extension = workflow.runtime === "node" ? ".cjs" : workflow.runtime === "python" ? ".py" : ".sh";
    const scriptPath = join(directory, `card-script${extension}`);
    try {
      await writeFile(scriptPath, asString(resolveTemplate(workflow.source, template), "script.source"), { mode: 0o700 });
      const command = workflow.runtime === "node" ? process.execPath : workflow.runtime === "python" ? "python" : (process.env.SHELL || "sh");
      const args = [scriptPath, ...(workflow.args ?? []).map((value) => asArgument(resolveTemplate(value, template)))];
      const cwd = workflow.cwd === undefined ? context.cwd : resolveCwd(resolveTemplate(workflow.cwd, template), context.cwd);
      return await executeProcess(command, args, {
        cwd,
        env: resolveEnv(workflow.env, template, context.env),
        timeoutMs: workflow.timeoutMs,
        signal: context.signal,
      });
    } finally {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async executeHttp(workflow: Extract<CardWorkflow, { type: "http" }>, template: TemplateContext, context: CardExecutionContext): Promise<unknown> {
    const signal = AbortSignal.any([context.signal, AbortSignal.timeout(normalizeTimeout(workflow.timeoutMs))]);
    const headers = Object.fromEntries(Object.entries(workflow.headers ?? {}).map(([key, value]) => [key, asString(resolveTemplate(value, template), `header ${key}`)]));
    const bodyValue = workflow.body === undefined ? undefined : resolveTemplate(workflow.body, template);
    const response = await fetch(asString(resolveTemplate(workflow.url, template), "http.url"), {
      method: workflow.method.toUpperCase(),
      headers,
      signal,
      ...(bodyValue === undefined ? {} : { body: typeof bodyValue === "string" ? bodyValue : JSON.stringify(bodyValue) }),
    });
    const text = (await response.text()).slice(0, MAX_OUTPUT_BYTES);
    let body: unknown = text;
    try { body = text ? JSON.parse(text) : null; } catch { /* Keep text response. */ }
    const result = { status: response.status, ok: response.ok, headers: Object.fromEntries(response.headers.entries()), body };
    if (!response.ok) throw new RequestError("card_http_failed", `HTTP ${response.status}`, result);
    return result;
  }
}

function executeProcess(command: string, args: string[], options: {
  cwd: string; env: NodeJS.ProcessEnv; timeoutMs?: number; signal: AbortSignal;
}): Promise<unknown> {
  return new Promise((resolvePromise, reject) => {
    const detached = process.platform !== "win32";
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"], detached });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    let timedOut = false;
    let forceKill: NodeJS.Timeout | undefined;
    const terminate = () => {
      try {
        if (detached && child.pid) process.kill(-child.pid, "SIGTERM");
        else child.kill("SIGTERM");
      } catch { child.kill("SIGTERM"); }
      forceKill ??= setTimeout(() => {
        try {
          if (detached && child.pid) process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch { child.kill("SIGKILL"); }
      }, 2000);
      forceKill.unref();
    };
    const timeout = setTimeout(() => { timedOut = true; terminate(); }, normalizeTimeout(options.timeoutMs));
    timeout.unref();
    const append = (current: Buffer, chunk: Buffer) => Buffer.concat([current, chunk]).subarray(0, MAX_OUTPUT_BYTES);
    child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
    const abort = () => terminate();
    options.signal.addEventListener("abort", abort, { once: true });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      options.signal.removeEventListener("abort", abort);
      reject(error);
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      options.signal.removeEventListener("abort", abort);
      const result = { command, args, exitCode: code, signal, stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8") };
      if (options.signal.aborted) reject(new RequestError("card_cancelled", "Card execution was cancelled", result));
      else if (timedOut) reject(new RequestError("card_timeout", "Card execution timed out", result));
      else if (code !== 0) reject(new RequestError("card_process_failed", `Process exited with code ${code ?? "unknown"}`, result));
      else resolvePromise(result);
    });
  });
}

export function resolveTemplate(value: TemplateValue, context: TemplateContext): unknown {
  if (Array.isArray(value)) return value.map((item) => resolveTemplate(item, context));
  if (typeof value === "string") {
    const shorthand = /^\$(field|env|step)\.(.+)$/.exec(value);
    if (shorthand?.[1] === "field") return context.fields[shorthand[2]!];
    if (shorthand?.[1] === "env") return context.env[shorthand[2]!] ?? "";
    if (shorthand?.[1] === "step") return readPath(context.steps, shorthand[2]!);
    return value;
  }
  if (!value || typeof value !== "object") return value;
  if ("$field" in value && typeof value.$field === "string") return context.fields[value.$field];
  if ("$env" in value && typeof value.$env === "string") return context.env[value.$env] ?? "";
  if ("$literal" in value) return value.$literal;
  if ("$step" in value && typeof value.$step === "string") return readPath(context.steps, value.$step);
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, resolveTemplate(child as TemplateValue, context)]));
}

function readPath(root: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((value, key) => value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined, root);
}
function resolveEnv(values: Record<string, TemplateValue> | undefined, template: TemplateContext, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...base, ...Object.fromEntries(Object.entries(values ?? {}).map(([key, value]) => [key, asArgument(resolveTemplate(value, template))])) };
}
function resolveCwd(value: unknown, base: string): string {
  const path = asString(value, "workflow.cwd");
  return isAbsolute(path) ? path : resolve(base, path);
}
function asString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) throw new RequestError("invalid_card_template", `${name} must resolve to a non-empty string`);
  return value;
}
function asArgument(value: unknown): string { return typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value); }
function normalizeTimeout(value?: number): number { return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.min(value, 30 * 60_000) : DEFAULT_TIMEOUT_MS; }
