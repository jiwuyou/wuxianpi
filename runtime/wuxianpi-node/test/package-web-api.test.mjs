import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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

test("local market auth routes persist Hub identity and drive publisher requests", async () => {
  const root = await mkdtemp(join(tmpdir(), "wuxianpi-market-auth-api-"));
  const githubTokens = [];
  const publisherAuthorizations = [];
  const logoutAuthorizations = [];
  let publisherRejectsAuth = false;
  const user = {
    userId: "usr_phone",
    githubId: "9001",
    login: "phone-user",
    name: "Phone User",
    avatarUrl: null,
    profileUrl: "https://github.com/phone-user",
    role: "user",
  };
  let issuedHubToken = "hub-token-from-gh";
  const hub = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === "/api/v1/packages" && request.method === "GET") {
      return sendJson(response, 200, { packages: [{ id: "io.test.market" }], nextCursor: null });
    }
    if (url.pathname === "/api/v1/auth/github/token-exchange" && request.method === "POST") {
      const body = await readBody(request);
      githubTokens.push(body.githubToken);
      issuedHubToken = body.githubToken === "manual-github-token" ? "hub-token-from-manual" : "hub-token-from-gh";
      return sendJson(response, 200, authPayload(issuedHubToken, user));
    }
    if (url.pathname === "/api/v1/auth/github/device/start" && request.method === "POST") {
      return sendJson(response, 200, {
        deviceCode: "device-code-private",
        userCode: "ABCD-EFGH",
        verificationUri: "https://github.com/login/device",
        expiresIn: 900,
        interval: 5,
      });
    }
    if (url.pathname === "/api/v1/auth/github/device/complete" && request.method === "POST") {
      const body = await readBody(request);
      assert.equal(body.deviceCode, "device-code-private");
      issuedHubToken = "hub-token-from-device";
      return sendJson(response, 200, authPayload(issuedHubToken, user, "ses_device"));
    }
    if (url.pathname === "/api/v1/auth/logout" && request.method === "POST") {
      logoutAuthorizations.push(request.headers.authorization);
      return sendJson(response, 200, { revoked: true });
    }
    if (url.pathname === "/api/v1/publisher/submissions" && request.method === "POST") {
      publisherAuthorizations.push(request.headers.authorization);
      if (publisherRejectsAuth) return sendJson(response, 401, { error: { code: "hub_session_expired", message: "Session expired" } });
      return sendJson(response, 202, { submission: { submissionId: `sub_${publisherAuthorizations.length}` } });
    }
    return sendJson(response, 404, { error: { code: "not_found", message: "Not found" } });
  });
  await new Promise((resolve) => hub.listen(0, "127.0.0.1", resolve));
  const hubAddress = hub.address();
  const options = {
    host: "127.0.0.1",
    port: 0,
    agentDir: join(root, "agent"),
    idleTimeoutMs: 0,
    hubUrl: `http://127.0.0.1:${hubAddress.port}`,
    packageManagerRoot: join(root, "packages"),
    maintenanceRoot: join(root, "maintenance"),
  };
  let server = createRuntimeServer({ ...options, hubAuthRunGhToken: async () => "gh-github-token\n" });
  try {
    let address = await server.start();
    let origin = `http://${address.host}:${address.port}`;
    const anonymous = await fetch(`${origin}/api/web/v1/market/auth`).then((response) => response.json());
    assert.equal(anonymous.data.authenticated, false);
    const blockedAuth = await fetch(`${origin}/api/web/v1/market/auth`, {
      headers: { Origin: "https://evil.example" },
    });
    assert.equal(blockedAuth.status, 403);
    assert.equal(blockedAuth.headers.get("access-control-allow-origin"), null);
    assert.equal((await blockedAuth.json()).error.code, "origin_not_allowed");
    const blockedPreflight = await fetch(`${origin}/api/web/v1/market/auth/github/gh`, {
      method: "OPTIONS", headers: { Origin: "https://evil.example", "access-control-request-method": "POST" },
    });
    assert.equal(blockedPreflight.status, 403);
    assert.equal(blockedPreflight.headers.get("access-control-allow-origin"), null);
    const anonymousBrowse = await fetch(`${origin}/api/web/v1/market/packages`, {
      headers: { Origin: "https://evil.example" },
    });
    assert.equal(anonymousBrowse.status, 200);
    const anonymousInstall = await fetch(`${origin}/api/web/v1/packages`, {
      method: "POST", headers: { Origin: "https://evil.example", "content-type": "application/json" }, body: "{}",
    });
    assert.equal(anonymousInstall.status, 400);
    assert.notEqual((await anonymousInstall.json()).error.code, "origin_not_allowed");

    const ghLogin = await fetch(`${origin}/api/web/v1/market/auth/github/gh`, {
      method: "POST",
      headers: { "content-type": "application/json", Origin: `http://${address.host}:${address.port}` },
      body: JSON.stringify({ label: "phone" }),
    }).then((response) => response.json());
    assert.equal(ghLogin.data.authenticated, true);
    assert.equal(ghLogin.data.user.login, "phone-user");
    assert.equal(JSON.stringify(ghLogin).includes("gh-github-token"), false);
    assert.equal(JSON.stringify(ghLogin).includes("hub-token-from-gh"), false);

    let submitted = await fetch(`${origin}/api/web/v1/packages/publisher/submissions`, {
      method: "POST", headers: { "content-type": "application/json", Origin: `http://${address.host}:${address.port}` }, body: JSON.stringify({ repositoryUrl: "https://github.com/example/package" }),
    });
    assert.equal(submitted.status, 202);
    assert.equal(publisherAuthorizations.at(-1), "Bearer hub-token-from-gh");
    const authorizationsBeforeBlockedPublish = publisherAuthorizations.length;
    const blockedPublish = await fetch(`${origin}/api/web/v1/packages/publisher/submissions`, {
      method: "POST", headers: { "content-type": "application/json", Origin: "https://evil.example" }, body: "{}",
    });
    assert.equal(blockedPublish.status, 403);
    assert.equal((await blockedPublish.json()).error.code, "origin_not_allowed");
    assert.equal(publisherAuthorizations.length, authorizationsBeforeBlockedPublish);

    await server.stop();
    server = createRuntimeServer({
      ...options,
      hubAuthRunGhToken: async () => { throw new Error("gh should not run while restoring"); },
    });
    address = await server.start();
    origin = `http://${address.host}:${address.port}`;
    const restored = await fetch(`${origin}/api/web/v1/market/auth`).then((response) => response.json());
    assert.equal(restored.data.authenticated, true);
    assert.equal(restored.data.user.login, "phone-user");

    const deviceStart = await fetch(`${origin}/api/web/v1/market/auth/github/device/start`, { method: "POST" }).then((response) => response.json());
    assert.equal(deviceStart.data.userCode, "ABCD-EFGH");
    const deviceComplete = await fetch(`${origin}/api/web/v1/market/auth/github/device/complete`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ deviceCode: "device-code-private" }),
    }).then((response) => response.json());
    assert.equal(deviceComplete.data.authenticated, true);
    assert.equal(JSON.stringify(deviceComplete).includes("hub-token-from-device"), false);

    submitted = await fetch(`${origin}/api/web/v1/packages/publisher/submissions`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ repositoryUrl: "https://github.com/example/package" }),
    });
    assert.equal(submitted.status, 202);
    assert.equal(publisherAuthorizations.at(-1), "Bearer hub-token-from-device");

    publisherRejectsAuth = true;
    const expiredPublish = await fetch(`${origin}/api/web/v1/packages/publisher/submissions`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ repositoryUrl: "https://github.com/example/package" }),
    });
    assert.equal(expiredPublish.status, 401);
    assert.equal((await expiredPublish.json()).error.code, "hub_session_expired");
    assert.equal((await fetch(`${origin}/api/web/v1/market/auth`).then((response) => response.json())).data.authenticated, false);
    await assert.rejects(readFile(join(root, "packages", "hub-auth.json"), "utf8"), { code: "ENOENT" });

    await server.stop();
    publisherRejectsAuth = false;
    server = createRuntimeServer({
      ...options,
      hubAuthRunGhToken: async () => { throw new Error("gh should not run while checking cleared state"); },
    });
    address = await server.start();
    origin = `http://${address.host}:${address.port}`;
    const clearedAfterRestart = await fetch(`${origin}/api/web/v1/market/auth`).then((response) => response.json());
    assert.equal(clearedAfterRestart.data.authenticated, false);

    const logout = await fetch(`${origin}/api/web/v1/market/auth/logout`, { method: "POST" }).then((response) => response.json());
    assert.equal(logout.data.authenticated, false);
    assert.equal(logoutAuthorizations.at(-1), undefined);
    const unauthenticatedPublish = await fetch(`${origin}/api/web/v1/packages/publisher/submissions`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    });
    assert.equal(unauthenticatedPublish.status, 401);
    assert.equal((await unauthenticatedPublish.json()).error.code, "hub_auth_required");

    const manualLogin = await fetch(`${origin}/api/web/v1/market/auth/github/token`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ githubToken: "manual-github-token" }),
    }).then((response) => response.json());
    assert.equal(manualLogin.data.authenticated, true);
    assert.equal(JSON.stringify(manualLogin).includes("manual-github-token"), false);
    assert.equal((await readFile(join(root, "packages", "hub-auth.json"), "utf8")).includes("manual-github-token"), false);
    assert.deepEqual(githubTokens, ["gh-github-token", "manual-github-token"]);
  } finally {
    await server.stop().catch(() => undefined);
    await new Promise((resolve) => hub.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

function authPayload(token, user, sessionId = "ses_phone") {
  return {
    token,
    user,
    session: {
      sessionId,
      kind: "device",
      label: "phone",
      createdAt: "2026-08-03T00:00:00.000Z",
      expiresAt: "2099-08-03T00:00:00.000Z",
    },
  };
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function sendJson(response, status, value) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}
