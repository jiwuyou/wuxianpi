import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebServices } from "../dist/web-services.js";

test("WuxianPi reads standard MCP configuration and preserves adapter fields on save", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "wuxianpi-mcp-config-"));
  const agentDir = join(root, "agent");
  const mcpConfigPath = join(root, "config", "mcp.json");
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "config"), { recursive: true });
  await writeFile(mcpConfigPath, JSON.stringify({
    settings: { hostConfigDiscovery: "off" },
    mcpServers: {
      "cloudflare-api": {
        url: "https://mcp.cloudflare.com/mcp",
        headers: { Authorization: "Bearer existing" },
        lifecycle: "lazy",
        requestTimeoutMs: 3210,
        customAdapterField: true,
      },
    },
  }, null, 2));
  const services = new WebServices({ agentDir, mcpConfigPath, registry: { list: async () => ({ sessions: [] }) } });

  const initial = await services.readConfig();
  assert.deepEqual(initial.mcpServers, [{
    id: "cloudflare-api", name: "cloudflare-api", transport: "streamable-http",
    url: "https://mcp.cloudflare.com/mcp", headers: { Authorization: "Bearer existing" },
    timeoutMs: 3210, lifecycle: "lazy", enabled: true,
  }]);

  await services.createAssistant({
    id: "cloudflare-user",
    manifest: { schemaVersion: 1, name: "Cloudflare user", tools: [], mcpServers: ["cloudflare-api"] },
  });
  assert.deepEqual((await services.resolveAssistantToolNames("cloudflare-user")).toolNames, ["mcp"]);

  await services.patchConfig({ defaults: { mcpServers: ["cloudflare-api"] } });
  const preserved = JSON.parse(await readFile(mcpConfigPath, "utf8"));
  assert.equal(preserved.mcpServers["cloudflare-api"].customAdapterField, true);
  assert.equal(preserved.mcpServers["cloudflare-api"].lifecycle, "lazy");

  await services.patchConfig({ mcpServers: [{
    id: "cloudflare-api", name: "Cloudflare", transport: "streamable-http",
    url: "https://mcp.cloudflare.com/mcp", headers: {}, auth: "oauth", enabled: true,
  }] });
  const updated = JSON.parse(await readFile(mcpConfigPath, "utf8"));
  assert.equal(updated.mcpServers["cloudflare-api"].auth, "oauth");
  assert.deepEqual(updated.mcpServers["cloudflare-api"].headers, {});
  assert.equal(updated.mcpServers["cloudflare-api"].customAdapterField, true);
  assert.equal(updated.mcpServers["cloudflare-api"].lifecycle, "lazy");
});

test("MCP HTTP test reports invalid OAuth tokens without pretending the adapter connected", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "wuxianpi-mcp-probe-"));
  const agentDir = join(root, "agent");
  const mcpConfigPath = join(root, "config", "mcp.json");
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "config"), { recursive: true });
  const server = createServer((_request, response) => {
    response.writeHead(401, { "www-authenticate": 'Bearer realm="OAuth", error="invalid_token"' });
    response.end(JSON.stringify({ error: "invalid_token" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await writeFile(mcpConfigPath, JSON.stringify({ mcpServers: {
    cloudflare: { url: `http://127.0.0.1:${address.port}/mcp`, headers: { Authorization: "Bearer invalid" } },
  } }));
  const services = new WebServices({ agentDir, mcpConfigPath, registry: { list: async () => ({ sessions: [] }) } });

  const result = await services.mcpAction({ action: "test", serverId: "cloudflare" });
  assert.equal(result.diagnostics.some((item) => item.code === "mcp.oauth_invalid_token"), true);
});
