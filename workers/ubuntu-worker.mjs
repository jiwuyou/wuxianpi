#!/usr/bin/env node
import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

const running = new Map();
const input = readline.createInterface({ input: process.stdin });
const assistantsRoot = process.env.WUXIANPI_ASSISTANTS_ROOT;
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_OUTPUT = 4 * 1024 * 1024;

const respond = (id, result, error) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, ...(error ? { error } : { result }) })}\n`);

const tools = [
  {
    id: "ubuntu:search_text", name: "ubuntu.search_text", description: "Search text inside the assistant workspace using ripgrep", source: "ubuntu",
    risk: ["read", "execute"], status: "available", assistantSelectable: true,
    metadata: { inputSchema: { type: "object", properties: { pattern: { type: "string" }, relativePath: { type: "string" }, glob: { type: "string" }, maxResults: { type: "number" } }, required: ["pattern"] } },
  },
  {
    id: "ubuntu:convert_document", name: "ubuntu.convert_document", description: "Convert a document inside the assistant workspace with pandoc", source: "ubuntu",
    risk: ["read", "write", "execute"], status: "available", assistantSelectable: true,
    metadata: { inputSchema: { type: "object", properties: { input: { type: "string" }, output: { type: "string" }, format: { type: "string", enum: ["markdown", "html", "pdf", "docx", "plain"] } }, required: ["input", "output", "format"] } },
  },
  {
    id: "ubuntu:inspect_media", name: "ubuntu.inspect_media", description: "Inspect media metadata inside the assistant workspace with ffprobe", source: "ubuntu",
    risk: ["read", "execute"], status: "available", assistantSelectable: true,
    metadata: { inputSchema: { type: "object", properties: { relativePath: { type: "string" } }, required: ["relativePath"] } },
  },
];
if (process.env.WUXIANPI_TEST_MODE === "1") tools.push({
  id: "ubuntu:test_wait", name: "ubuntu.test_wait", description: "Deterministic cancellation probe", source: "ubuntu",
  risk: ["execute"], status: "available", assistantSelectable: false,
  metadata: { inputSchema: { type: "object", properties: { milliseconds: { type: "number" } } } },
});

function callKey(assistantId, callId) { return `${assistantId}\u0000${callId}`; }
function assertAssistantId(value) { if (!SAFE_ID.test(value ?? "")) throw new Error("Invalid assistantId"); return value; }
function assertRelative(value, label) {
  if (typeof value !== "string" || !value || path.isAbsolute(value) || value.includes("\0") || value.split(/[\\/]/).includes("..")) throw new Error(`${label} must be a safe relative path`);
  return value;
}
function isInside(root, candidate) { const relative = path.relative(root, candidate); return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)); }

async function workspaceFor(assistantId) {
  if (!assistantsRoot) throw new Error("WUXIANPI_ASSISTANTS_ROOT is not configured");
  assertAssistantId(assistantId);
  const root = await realpath(path.join(assistantsRoot, assistantId));
  const realAssistantsRoot = await realpath(assistantsRoot);
  if (!isInside(realAssistantsRoot, root)) throw new Error("Assistant workspace escapes assistants root");
  return root;
}

async function existingPath(root, relativePath, label) {
  const target = await realpath(path.join(root, assertRelative(relativePath, label)));
  if (!isInside(root, target)) throw new Error(`${label} escapes assistant workspace`);
  return target;
}

async function outputPath(root, relativePath) {
  const relative = assertRelative(relativePath, "output");
  const target = path.resolve(root, relative);
  const parent = await realpath(path.dirname(target));
  if (!isInside(root, parent) || !isInside(root, target)) throw new Error("output escapes assistant workspace");
  return target;
}

function spawnControlled(assistantId, callId, command, args, cwd, timeoutMs = 120_000) {
  const key = callKey(assistantId, callId);
  if (running.has(key)) throw new Error("Duplicate callId for assistant");
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell: false, env: process.env });
    const state = { child, killTimer: undefined };
    running.set(key, state);
    let stdout = "", stderr = "", settled = false;
    child.stdout.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-MAX_OUTPUT); });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-MAX_OUTPUT); });
    const timer = setTimeout(() => { child.kill("SIGTERM"); state.killTimer = setTimeout(() => child.kill("SIGKILL"), 2_000); }, Math.min(Math.max(timeoutMs, 1_000), 600_000));
    child.once("error", (error) => { if (!settled) { settled = true; clearTimeout(timer); running.delete(key); reject(error); } });
    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true; clearTimeout(timer); if (state.killTimer) clearTimeout(state.killTimer); running.delete(key);
      resolve({ content: [{ type: "text", text: stdout || stderr || `(exit ${code ?? signal})` }], details: { stdout, stderr, exitCode: code, signal }, isError: code !== 0 });
    });
  });
}

async function executeTool(assistantId, callId, toolName, args) {
  const workspace = await workspaceFor(assistantId);
  if (toolName === "ubuntu.test_wait" && process.env.WUXIANPI_TEST_MODE === "1") {
    const milliseconds = Math.min(Math.max(Number(args?.milliseconds) || 1_000, 100), 5_000);
    return spawnControlled(assistantId, callId, "sleep", [String(milliseconds / 1_000)], workspace, milliseconds + 5_000);
  }
  if (toolName === "ubuntu.search_text") {
    if (!args || typeof args.pattern !== "string" || !args.pattern) throw new Error("pattern is required");
    const target = args.relativePath ? await existingPath(workspace, args.relativePath, "relativePath") : workspace;
    const maxResults = Math.min(Math.max(Number(args.maxResults) || 200, 1), 2_000);
    const commandArgs = ["--color", "never", "--line-number", "--max-count", String(maxResults)];
    if (args.glob !== undefined) { if (typeof args.glob !== "string" || args.glob.length > 200) throw new Error("Invalid glob"); commandArgs.push("--glob", args.glob); }
    commandArgs.push("--", args.pattern, target);
    return spawnControlled(assistantId, callId, "rg", commandArgs, workspace, 120_000);
  }
  if (toolName === "ubuntu.convert_document") {
    const formats = { markdown: "gfm", html: "html", pdf: "pdf", docx: "docx", plain: "plain" };
    if (!args || typeof args.format !== "string" || !Object.hasOwn(formats, args.format)) throw new Error("Unsupported document format");
    const source = await existingPath(workspace, args.input, "input");
    const destination = await outputPath(workspace, args.output);
    return spawnControlled(assistantId, callId, "pandoc", [source, "--to", formats[args.format], "--output", destination], workspace, 300_000);
  }
  if (toolName === "ubuntu.inspect_media") {
    const source = await existingPath(workspace, args?.relativePath, "relativePath");
    return spawnControlled(assistantId, callId, "ffprobe", ["-v", "error", "-show_format", "-show_streams", "-of", "json", "--", source], workspace, 120_000);
  }
  throw new Error(`Unknown or disallowed Ubuntu tool: ${toolName}`);
}

function cancelCall(assistantId, callId) {
  assertAssistantId(assistantId);
  const state = running.get(callKey(assistantId, callId));
  if (!state) return false;
  state.child.kill("SIGTERM");
  state.killTimer = setTimeout(() => state.child.kill("SIGKILL"), 2_000);
  return true;
}

function cancelAll() {
  for (const state of running.values()) state.child.kill("SIGTERM");
}

input.on("line", async (line) => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  const { id, method, params = {} } = request;
  try {
    if (method === "health") return respond(id, { ok: true });
    if (method === "tools/list") return respond(id, tools);
    if (method === "tools/call") return respond(id, await executeTool(params.assistantId, params.callId || id, params.toolName, params.arguments));
    if (method === "cancel") return respond(id, { cancelled: cancelCall(params.assistantId, params.callId) });
    if (method === "shutdown") { cancelAll(); respond(id, { ok: true }); return setTimeout(() => process.exit(0), 100); }
    throw new Error(`Unknown method: ${method}`);
  } catch (error) { respond(id, undefined, { code: -32000, message: error instanceof Error ? error.message : String(error) }); }
});

process.once("SIGTERM", () => { cancelAll(); setTimeout(() => process.exit(0), 100); });
process.once("SIGINT", () => { cancelAll(); setTimeout(() => process.exit(0), 100); });
