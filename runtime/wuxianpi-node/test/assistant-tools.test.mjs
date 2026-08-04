import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveConfiguredToolNames, WebServices } from "../dist/web-services.js";

test("assistant tool configuration resolves capability ids and package paths", () => {
  const extensionPath = "/data/data/com.termux/files/home/.pi/npm/node_modules/pi-mcp-adapter/index.ts";
  const resolved = resolveConfiguredToolNames([
    "read",
    "pi:read",
    "pi-extension:multi_platform_search",
    `extension:${extensionPath}`,
  ], [{
    id: extensionPath,
    path: extensionPath,
    kind: "pi",
    tools: ["mcp", "mcp_resource"],
  }]);

  assert.deepEqual(resolved, ["read", "multi_platform_search", "mcp", "mcp_resource"]);
});

test("selecting an MCP server activates the adapter tool", async (t) => {
  const agentDir = await mkdtemp(join(tmpdir(), "wuxianpi-assistant-tools-"));
  t.after(() => rm(agentDir, { recursive: true, force: true }));
  const services = new WebServices({
    agentDir,
    mcpConfigPath: join(agentDir, "mcp.json"),
    registry: {
      list: async () => ({ sessions: [] }),
      assistantSessionSummary: () => ({ sessionCount: 0 }),
    },
  });
  await services.createAssistant({
    id: "mcp-user",
    manifest: { schemaVersion: 1, name: "MCP User", tools: [], mcpServers: ["local"] },
  });
  await services.patchConfig({ mcpServers: [{ id: "local", name: "Local", transport: "stdio", command: "node", enabled: true }] });
  assert.deepEqual((await services.resolveAssistantToolNames("mcp-user")).toolNames, ["mcp"]);
});
