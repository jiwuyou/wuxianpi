import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRuntimeServer } from "../dist/server.js";

test("local Package API proxies Hub discovery and exposes installed state", async () => {
  const root = await mkdtemp(join(tmpdir(), "wuxianpi-package-api-"));
  const hub = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === "/api/v1/packages") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ packages: [{ id: "io.test.api", name: "API fixture", categories: ["skill"] }], nextCursor: null }));
      return;
    }
    if (url.pathname === "/api/v1/packages/io.test.rate-limited") {
      response.writeHead(429, { "content-type": "application/json", "retry-after": "30" });
      response.end(JSON.stringify({ error: { code: "rate_limited", message: "Try later" } }));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { code: "not_found", message: "Not found" } }));
  });
  await new Promise((resolve) => hub.listen(0, "127.0.0.1", resolve));
  const hubAddress = hub.address();
  const server = createRuntimeServer({
    host: "127.0.0.1", port: 0, agentDir: join(root, "agent"), idleTimeoutMs: 0,
    hubUrl: `http://127.0.0.1:${hubAddress.port}`,
    packageManagerRoot: join(root, "packages"), maintenanceRoot: join(root, "maintenance"),
  });
  try {
    const address = await server.start();
    const origin = `http://${address.host}:${address.port}`;
    const market = await fetch(`${origin}/api/web/v1/market/packages?q=api`).then((response) => response.json());
    assert.equal(market.ok, true);
    assert.equal(market.data.packages[0].id, "io.test.api");
    const installed = await fetch(`${origin}/api/web/v1/packages`).then((response) => response.json());
    assert.deepEqual(installed, { ok: true, data: { packages: [] } });
    const invalidBindingResponse = await fetch(`${origin}/api/web/v1/packages/bindings/main`, {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabledContributionIds: ["io.test.missing/skill.none"] }),
    });
    const invalidBinding = await invalidBindingResponse.json();
    assert.equal(invalidBindingResponse.status, 400);
    assert.equal(invalidBinding.error.code, "contribution_unavailable");
    const upstreamFailureResponse = await fetch(`${origin}/api/web/v1/market/packages/io.test.rate-limited`);
    const upstreamFailure = await upstreamFailureResponse.json();
    assert.equal(upstreamFailureResponse.status, 429);
    assert.equal(upstreamFailure.error.code, "rate_limited");
    const contextResponse = await fetch(`${origin}/api/web/v1/packages/execution-context`, {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ packageIds: ["io.test.current"], contributionIds: ["io.test.current/web.main"], serviceIds: ["pi-agent"] }),
    });
    assert.equal(contextResponse.status, 200);
    const context = await fetch(`${origin}/api/web/v1/packages/execution-context`).then((response) => response.json());
    assert.deepEqual(context.data.context.packageIds, ["io.test.current"]);
    const experiences = await fetch(`${origin}/api/web/v1/packages/experiences`).then((response) => response.json());
    assert.deepEqual(experiences.data.experiences, []);
  } finally {
    await server.stop().catch(() => undefined);
    await new Promise((resolve) => hub.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
