import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import type { CapabilityDescriptor } from "../lib/wuxianpi/contracts";

const bundled = process.env.WUXIANPI_BACKEND_TEST_BUNDLE === "1";

if (!bundled) {
  test("WuxianPi backend bundled test suite", async () => {
    const { resolveWuxianPiRuntimeTempDir } = await import("../lib/wuxianpi/runtime-temp");
    const temporaryRoot = await resolveWuxianPiRuntimeTempDir();
    const suiteDirectory = await mkdtemp(path.join(temporaryRoot, "wuxianpi-backend-tests-"));
    const output = path.join(suiteDirectory, "backend-tests.mjs");
    try {
      await symlink(path.join(process.cwd(), "node_modules"), path.join(suiteDirectory, "node_modules"), "dir");
      execFileSync(path.join(process.cwd(), "node_modules/.bin/esbuild"), [
        path.join(process.cwd(), "tests/wuxianpi-backend.test.ts"), "--bundle", "--platform=node", "--format=esm", "--packages=external",
        `--outfile=${output}`,
      ], { stdio: "inherit" });
      const childEnv: NodeJS.ProcessEnv = {
        ...process.env,
        WUXIANPI_BACKEND_TEST_BUNDLE: "1",
        WUXIANPI_TEST_RUNTIME_DIR: suiteDirectory,
        PI_CODING_AGENT_DIR: path.join(suiteDirectory, "agent"),
      };
      delete childEnv.NODE_TEST_CONTEXT;
      execFileSync(process.execPath, ["--test", output], {
        cwd: process.cwd(), stdio: "inherit",
        env: childEnv,
      });
    } finally {
      await rm(suiteDirectory, { recursive: true, force: true });
    }
  });
} else {
  const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const agentDir = process.env.PI_CODING_AGENT_DIR!;

  test("backend security and runtime invariants", async (t) => {
    await rm(agentDir, { recursive: true, force: true });
    const assistants = await import("../lib/wuxianpi/assistant-manager");
    const paths = await import("../lib/wuxianpi/paths");
    const permissions = await import("../lib/wuxianpi/permission-manager");
    const secrets = await import("../lib/wuxianpi/secret-store");
    const configStore = await import("../lib/wuxianpi/config-store");
    const rpc = await import("../lib/rpc-manager");
    const web = await import("../lib/wuxianpi/web-extension-manager");
    const fflate = await import("fflate");

    await t.test("runtime temp resolver handles Termux without TMPDIR and regular Linux", async () => {
      const runtimeRoot = process.env.WUXIANPI_TEST_RUNTIME_DIR!;
      const termuxHome = path.join(runtimeRoot, "termux-home");
      const termuxPrefix = path.join(runtimeRoot, "unwritable-prefix");
      const termuxResolved = await paths.resolveWuxianPiRuntimeTempDir({
        env: { NODE_ENV: "test", HOME: termuxHome, PREFIX: termuxPrefix, TERMUX_VERSION: "1" },
        osTmpDir: "/tmp",
        probeDirectory: async (directory) => {
          if (directory === path.resolve("/tmp") || directory === path.resolve(termuxPrefix, "tmp")) return false;
          await mkdir(directory, { recursive: true, mode: 0o700 });
          const probe = path.join(directory, "probe"); await writeFile(probe, "ok"); await rm(probe);
          return true;
        },
      });
      assert.equal(termuxResolved, path.resolve(termuxHome, ".cache", "wuxianpi", "tmp"));
      const linuxTmp = path.join(runtimeRoot, "linux-tmp");
      const linuxResolved = await paths.resolveWuxianPiRuntimeTempDir({ env: { NODE_ENV: "test", TMPDIR: linuxTmp }, osTmpDir: "/tmp" });
      assert.equal(linuxResolved, path.resolve(linuxTmp));
      await writeFile(path.join(linuxResolved, "writable"), "ok");
    });

    await t.test("assistant traversal and ZIP expansion are rejected", async () => {
      await assert.rejects(() => assistants.createAssistant({ id: "../escape", manifest: { schemaVersion: 1, name: "bad" } }));
      const manifest = fflate.strToU8(JSON.stringify({ schemaVersion: 1, name: "Imported" }));
      const traversal = fflate.zipSync({ "assistant.json": manifest, "../outside.txt": fflate.strToU8("bad") });
      await assert.rejects(() => assistants.importAssistantZip("traversal", traversal), /Unsafe path/);
      const bomb = fflate.zipSync({ "assistant.json": manifest, "knowledge/huge.bin": new Uint8Array(10 * 1024 * 1024 + 1) }, { level: 9 });
      await assert.rejects(() => assistants.importAssistantZip("bomb", bomb), /safety limits/);
    });

    const alpha = await assistants.createAssistant({
      id: "alpha", manifest: { schemaVersion: 1, name: "Alpha", tools: ["read"], skills: ["skill:demo"] },
      files: { agents: "# Identity\n\nROLE_MARKER", memory: "memory", workspaces: "workspace" },
    });

    await t.test("secrets are mode 0600 and config APIs mask inline values", async () => {
      await secrets.setSecret("secret:test", "top-secret");
      assert.equal((await stat(paths.getWuxianPiPaths().secrets)).mode & 0o777, 0o600);
      const config = await configStore.readWuxianPiConfig();
      await configStore.writeWuxianPiConfig({
        ...config,
        mcpServers: [{ id: "masked", name: "masked", transport: "stdio", command: "node", env: { TOKEN: "inline-secret" }, headers: { Authorization: "header-secret" }, envSecretRefs: { API_KEY: "secret:test" } }],
        ttsProfiles: [{ id: "http:test", name: "HTTP", provider: "http", baseUrl: "https://example.test/tts", headers: { Authorization: "tts-secret" }, secretRef: "secret:test" }],
      });
      const masked = secrets.maskWuxianPiConfig(await configStore.readWuxianPiConfig());
      assert.equal(masked.mcpServers[0].env?.TOKEN, "***");
      assert.equal(masked.mcpServers[0].headers?.Authorization, "***");
      assert.equal(masked.mcpServers[0].envSecretRefs?.API_KEY, "secret:test");
      assert.equal(masked.ttsProfiles[0].headers?.Authorization, "***");
      assert.equal(masked.ttsProfiles[0].secretRef, "secret:test");
    });

    await t.test("one-shot grants are consumed and strict set_tools cannot elevate", async () => {
      await permissions.setPermissionDecision("alpha", "pi:bash", "once");
      assert.equal(await permissions.getPermissionDecision("alpha", "pi:bash"), "once");
      assert.equal(await permissions.consumePermissionDecision("alpha", "pi:bash"), "once");
      assert.equal(await permissions.consumePermissionDecision("alpha", "pi:bash"), undefined);
      await permissions.setPermissionDecision("alpha", "pi:bash", "deny");
      assert.equal(await permissions.getPermissionDecision("alpha", "pi:bash"), "deny");
      await assert.rejects(() => permissions.setPermissionDecision("alpha", "pi:bash", "once"));

      let active: string[] = [];
      let streaming = true;
      const fake = {
        sessionId: "fake", sessionFile: undefined, get isStreaming() { return streaming; }, isCompacting: false, autoCompactionEnabled: true, autoRetryEnabled: true,
        model: undefined, modelRegistry: {}, agent: { state: {} }, promptTemplates: [], resourceLoader: { getSkills: () => ({ skills: [] }) },
        extensionRunner: { setUIContext: () => undefined, getRegisteredCommands: () => [] }, sessionManager: { getCwd: () => alpha.path },
        subscribe: () => () => undefined, getActiveToolNames: () => active, getAllTools: () => [], setActiveToolsByName: (names: string[]) => { active = names; },
      };
      const wrapper = new rpc.AgentSessionWrapper(fake as never, 20, true, [], new Set(["read"]));
      wrapper.start();
      await wrapper.send({ type: "set_tools", toolNames: ["bash", "write", "read"] });
      assert.deepEqual(active, ["read"]);
      await delay(45);
      assert.equal(wrapper.isAlive(), true, "busy session must survive idle timeout");
      streaming = false;
      await delay(30);
      assert.equal(wrapper.isAlive(), false);
    });

    await t.test("skill IDs normalize and no-tools retains assistant resources", async () => {
      assert.deepEqual(rpc.normalizeSkillNames(["skill:demo"]), ["demo"]);
      assert.equal(rpc.getPiNoToolsMode([], 0), "all");
      const { DefaultResourceLoader } = await import("@earendil-works/pi-coding-agent");
      const loader = new DefaultResourceLoader({ cwd: alpha.path, agentDir });
      await loader.reload();
      assert.ok(loader.getAgentsFiles().agentsFiles.some((file) => file.content.includes("ROLE_MARKER")));
    });

    await t.test("MCP result conversion, cancellation, timeout, and offline isolation", async () => {
      const serverFile = path.join(process.env.WUXIANPI_TEST_RUNTIME_DIR!, `mcp-server-${process.pid}.mjs`);
      await writeFile(serverFile, `
        import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
        import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
        import { z } from "zod";
        const server = new McpServer({name:"test",version:"1"});
        server.registerTool("echo", {inputSchema:{text:z.string()}}, async ({text}) => ({content:[{type:"text",text}]}));
        server.registerTool("wait", {inputSchema:{milliseconds:z.number()}}, async ({milliseconds}, extra) => { await new Promise((resolve,reject) => { const timer=setTimeout(resolve,milliseconds); extra.signal.addEventListener("abort",()=>{clearTimeout(timer);reject(new Error("cancelled"));},{once:true}); }); return {content:[{type:"text",text:"done"}]}; });
        await server.connect(new StdioServerTransport());
      `);
      const base = await configStore.readWuxianPiConfig();
      await configStore.writeWuxianPiConfig({ ...base, mcpServers: [
        { id: "fake", name: "Fake", transport: "stdio", command: process.execPath, args: [serverFile], timeoutMs: 5_000 },
        { id: "offline", name: "Offline", transport: "stdio", command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], timeoutMs: 100 },
      ] });
      await permissions.revokePermission("alpha", "mcp:fake");
      await permissions.setPermissionDecision("alpha", "mcp:fake", "assistant");
      const mcp = await import("../lib/wuxianpi/mcp-manager");
      const definitions = await mcp.createMcpToolDefinitions(["fake", "offline"], "alpha");
      assert.ok(definitions.diagnostics.some((item) => item.capabilityId === "mcp:offline"));
      const echo = definitions.tools.find((tool) => tool.label.includes("echo"))!;
      assert.ok(echo, JSON.stringify(definitions.diagnostics));
      const echoResult = await echo.execute("echo-call", { text: "hello" }, undefined, undefined, {} as never);
      assert.equal(echoResult.content[0].type === "text" ? echoResult.content[0].text : "", "hello");
      const pending = mcp.callMcpTool("fake", "wait", { milliseconds: 5_000 }, { callId: "cancel-me", assistantId: "alpha" });
      await assert.rejects(() => mcp.callMcpTool("fake", "echo", { text: "duplicate" }, { callId: "cancel-me", assistantId: "alpha" }), /already exists/);
      await delay(100);
      assert.equal(mcp.cancelMcpCall("cancel-me", "other"), false);
      assert.equal(mcp.cancelMcpCall("cancel-me", "alpha"), true);
      await assert.rejects(pending);
      await mcp.closeMcpClient("fake"); await mcp.closeMcpClient("offline"); await rm(serverFile, { force: true });
    });

    await t.test("web extension traversal, bridge declaration, storage limits and id mismatch", async () => {
      const extensionZip = fflate.zipSync({
        "wuxianpi-extension.json": fflate.strToU8(JSON.stringify({ schemaVersion: 1, apiVersion: "1", id: "safe.ext", name: "Safe", version: "1", entry: "ui/index.html", permissions: ["assistant.read", "storage.read"] })),
        "ui/index.html": fflate.strToU8("<!doctype html><title>safe</title>"),
      });
      await web.installWebExtensionZip(extensionZip);
      await assert.rejects(() => web.readWebExtensionAsset("safe.ext", "../assistant.json"));
      await assert.rejects(() => web.extensionStorageSet("safe.ext", "alpha", "huge", "x".repeat(256 * 1024 + 1)));
      await Promise.all([web.extensionStorageSet("safe.ext", "alpha", "a", 1), web.extensionStorageSet("safe.ext", "alpha", "b", 2)]);
      assert.equal(await web.extensionStorageGet("safe.ext", "alpha", "a"), 1);
      assert.equal(await web.extensionStorageGet("safe.ext", "alpha", "b"), 2);
      const installed = await web.getWebExtensionSummary("safe.ext");
      assert.throws(() => web.assertWebExtensionBridgePermission(installed.manifest, "storage.set"), /did not declare/);
      const badDir = path.join(paths.getWuxianPiPaths().webExtensions, "bad.ext");
      await mkdir(badDir, { recursive: true });
      await writeFile(path.join(badDir, "wuxianpi-extension.json"), JSON.stringify({ schemaVersion: 1, apiVersion: "1", id: "other.ext", name: "Bad", version: "1" }));
      assert.equal((await web.listWebExtensionSummaries()).find((item) => item.id === "bad.ext")?.enabled, false);
    });

    await t.test("Ubuntu worker exposes allowlisted tools and isolates cancellation by assistant", async () => {
      const ubuntu = await import("../lib/wuxianpi/ubuntu-bridge");
      const descriptor: CapabilityDescriptor = { id: "ubuntu:test", name: "ubuntu.test_wait", source: "ubuntu", risk: ["execute"], status: "available", assistantSelectable: false, metadata: { inputSchema: { type: "object" } } };
      let receivedSignal: AbortSignal | undefined;
      const definitions = ubuntu.buildUbuntuToolDefinitions([descriptor], "alpha", async (_toolName, _args, _callId, _assistantId, signal) => {
        receivedSignal = signal;
        return new Promise((_resolve, reject) => {
          if (signal?.aborted) return reject(new DOMException("aborted", "AbortError"));
          signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
        });
      });
      const controller = new AbortController();
      const throughToolDefinition = definitions[0].execute("pi-abort", {}, controller.signal, undefined, {} as never);
      controller.abort();
      await assert.rejects(throughToolDefinition, /aborted/i);
      assert.equal(receivedSignal, controller.signal);

      const worker = spawn(process.execPath, [path.join(process.cwd(), "workers/ubuntu-worker.mjs")], {
        stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, WUXIANPI_ASSISTANTS_ROOT: paths.getWuxianPiPaths().assistants, WUXIANPI_TEST_MODE: "1" },
      });
      const pending = new Map<string, (value: Record<string, unknown>) => void>();
      readline.createInterface({ input: worker.stdout }).on("line", (line) => { const message = JSON.parse(line) as Record<string, unknown> & { id: string }; pending.get(message.id)?.(message); pending.delete(message.id); });
      const rpcCall = (id: string, method: string, params: Record<string, unknown> = {}) => new Promise<Record<string, unknown>>((resolve) => { pending.set(id, resolve); worker.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`); });
      const listed = await rpcCall("list", "tools/list") as { result: Array<{ name: string }> };
      assert.equal(listed.result.some((tool) => tool.name === "ubuntu.exec"), false);
      const rejected = await rpcCall("bad", "tools/call", { assistantId: "alpha", callId: "bad", toolName: "ubuntu.exec", arguments: { command: "sh" } }) as { error?: unknown };
      assert.ok(rejected.error);
      const waiting = rpcCall("wait", "tools/call", { assistantId: "alpha", callId: "wait", toolName: "ubuntu.test_wait", arguments: { milliseconds: 3_000 } });
      await delay(100);
      const wrong = await rpcCall("wrong", "cancel", { assistantId: "other", callId: "wait" }) as { result: { cancelled: boolean } };
      assert.equal(wrong.result.cancelled, false);
      const cancelled = await rpcCall("cancel", "cancel", { assistantId: "alpha", callId: "wait" }) as { result: { cancelled: boolean } };
      assert.equal(cancelled.result.cancelled, true);
      await waiting;
      await rpcCall("stop", "shutdown");
    });

    await rm(agentDir, { recursive: true, force: true });
  });
}
