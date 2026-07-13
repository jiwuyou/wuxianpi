#!/usr/bin/env node
import { spawn } from "node:child_process";
import readline from "node:readline";

const running = new Map();
const input = readline.createInterface({ input: process.stdin });

const respond = (id, result, error) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, ...(error ? { error } : { result }) })}\n`);

const tools = [{
  id: "ubuntu:exec",
  name: "ubuntu.exec",
  description: "Run an executable with an argument array in the Ubuntu environment",
  source: "ubuntu",
  risk: ["execute", "write", "network"],
  status: "available",
  assistantSelectable: true,
  metadata: { inputSchema: { type: "object", properties: { command: { type: "string" }, args: { type: "array", items: { type: "string" } }, cwd: { type: "string" }, timeoutMs: { type: "number" } }, required: ["command"] } },
}];

function execTool(callId, args) {
  if (!args || typeof args.command !== "string" || !args.command || args.command.includes("\0")) throw new Error("command must be a non-empty executable name");
  if (args.args !== undefined && (!Array.isArray(args.args) || args.args.some((item) => typeof item !== "string"))) throw new Error("args must be a string array");
  if (args.cwd !== undefined && typeof args.cwd !== "string") throw new Error("cwd must be a string");
  const timeoutMs = Math.min(Math.max(Number(args.timeoutMs) || 120000, 1000), 600000);
  return new Promise((resolve, reject) => {
    const child = spawn(args.command, args.args ?? [], { cwd: args.cwd, shell: false, env: process.env });
    running.set(callId, child);
    let stdout = "", stderr = "";
    const limit = 4 * 1024 * 1024;
    child.stdout.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-limit); });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-limit); });
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      clearTimeout(timer); running.delete(callId);
      resolve({ content: [{ type: "text", text: stdout || stderr || `(exit ${code ?? signal})` }], details: { stdout, stderr, exitCode: code, signal }, isError: code !== 0 });
    });
  });
}

input.on("line", async (line) => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  const { id, method, params = {} } = request;
  try {
    if (method === "health") return respond(id, { ok: true });
    if (method === "tools/list") return respond(id, tools);
    if (method === "tools/call") {
      if (params.toolName !== "ubuntu.exec") throw new Error(`Unknown Ubuntu tool: ${params.toolName}`);
      return respond(id, await execTool(params.callId || id, params.arguments));
    }
    if (method === "cancel") {
      const child = running.get(params.callId); if (child) child.kill("SIGTERM"); return respond(id, { cancelled: Boolean(child) });
    }
    if (method === "shutdown") { respond(id, { ok: true }); return setTimeout(() => process.exit(0), 10); }
    throw new Error(`Unknown method: ${method}`);
  } catch (error) { respond(id, undefined, { code: -32000, message: error instanceof Error ? error.message : String(error) }); }
});
