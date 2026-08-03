import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HubAuth } from "../dist/hub-auth.js";
import { MarketClient } from "../dist/market-client.js";

const USER = {
  userId: "usr_123",
  githubId: "4242",
  login: "wuxianpi-user",
  name: "WuxianPi User",
  avatarUrl: "https://avatars.example/user.png",
  profileUrl: "https://github.com/wuxianpi-user",
  role: "user",
};

const SESSION = {
  sessionId: "ses_123",
  kind: "device",
  label: "phone",
  createdAt: "2026-08-03T00:00:00.000Z",
  expiresAt: "2099-08-03T00:00:00.000Z",
};

test("HubAuth exchanges gh token without persisting or returning the GitHub credential", async () => {
  const root = await mkdtemp(join(tmpdir(), "wuxianpi-hub-auth-"));
  const statePath = join(root, "state", "hub-auth.json");
  const githubToken = "github-secret-token";
  const hubToken = "hub-device-token";
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url: String(url), init });
    if (String(url).endsWith("/api/v1/auth/github/token-exchange")) {
      const body = JSON.parse(String(init.body));
      assert.equal(body.githubToken, githubToken);
      assert.equal(body.kind, "device");
      assert.equal(body.label, "phone");
      return jsonResponse({ token: hubToken, user: USER, session: SESSION });
    }
    if (String(url).endsWith("/api/v1/auth/logout")) {
      assert.equal(new Headers(init.headers).get("authorization"), `Bearer ${hubToken}`);
      return jsonResponse({ revoked: true });
    }
    return jsonResponse({ error: { code: "not_found", message: "Not found" } }, 404);
  };

  try {
    const auth = new HubAuth({
      baseUrl: "https://hub.example",
      statePath,
      fetchImpl,
      runGhToken: async () => `${githubToken}\n`,
    });
    const status = await auth.loginWithGh("phone");
    assert.equal(status.authenticated, true);
    assert.equal(status.user.login, USER.login);
    assert.equal(JSON.stringify(status).includes(githubToken), false);
    assert.equal(JSON.stringify(status).includes(hubToken), false);

    const persisted = await readFile(statePath, "utf8");
    assert.equal(persisted.includes(githubToken), false);
    assert.equal(persisted.includes(hubToken), true);
    assert.equal((await stat(statePath)).mode & 0o777, 0o600);

    const restored = new HubAuth({ baseUrl: "https://hub.example", statePath, fetchImpl });
    await restored.initialize();
    assert.equal(restored.status().authenticated, true);
    assert.equal(restored.status().user.login, USER.login);
    assert.equal(restored.token(), hubToken);

    const loggedOut = await restored.logout();
    assert.equal(loggedOut.authenticated, false);
    assert.equal(loggedOut.remoteRevoked, true);
    await assert.rejects(readFile(statePath, "utf8"), { code: "ENOENT" });
    assert.equal(requests.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("HubAuth reports local gh failures without contacting Hub", async () => {
  const root = await mkdtemp(join(tmpdir(), "wuxianpi-hub-auth-failure-"));
  let fetchCalls = 0;
  try {
    const auth = new HubAuth({
      baseUrl: "https://hub.example",
      statePath: join(root, "hub-auth.json"),
      fetchImpl: async () => {
        fetchCalls += 1;
        throw new Error("unexpected fetch");
      },
      runGhToken: async () => {
        throw Object.assign(new Error("not logged in"), { code: 1 });
      },
    });
    await assert.rejects(auth.loginWithGh(), (error) => error?.code === "github_cli_not_authenticated");
    assert.equal(fetchCalls, 0);
    assert.equal(auth.status().authenticated, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("MarketClient reads the current Hub token for every authenticated request", async () => {
  let hubToken;
  const authorizations = [];
  const client = new MarketClient({
    baseUrl: "https://hub.example",
    publisherToken: "",
    authToken: () => hubToken,
    fetchImpl: async (_url, init = {}) => {
      authorizations.push(new Headers(init.headers).get("authorization"));
      return jsonResponse({ submission: { submissionId: `sub_${authorizations.length}` } }, 202);
    },
  });

  await assert.rejects(async () => client.submitPackage({ repositoryUrl: "https://github.com/example/package" }), (error) => error?.code === "hub_auth_required");
  hubToken = "hub-token-one";
  await client.submitPackage({ repositoryUrl: "https://github.com/example/package" });
  hubToken = "hub-token-two";
  await client.authenticatedRequest("/api/v1/packages/example/proposals", { method: "POST", body: { title: "Update" } });
  assert.deepEqual(authorizations, ["Bearer hub-token-one", "Bearer hub-token-two"]);
  assert.deepEqual(client.authStatus(), { authenticated: true, source: "hub_session" });
});

test("a delayed 401 from an older session cannot clear a newer session", async () => {
  const root = await mkdtemp(join(tmpdir(), "wuxianpi-hub-auth-generation-"));
  const statePath = join(root, "hub-auth.json");
  let releaseMarketRequest;
  let marketRequestStarted;
  const marketStarted = new Promise((resolve) => { marketRequestStarted = resolve; });
  const hubFetch = async (_url, init = {}) => {
    const body = JSON.parse(String(init.body));
    const suffix = body.githubToken === "github-a" ? "a" : "b";
    return jsonResponse({
      token: `hub-token-${suffix}`,
      user: USER,
      session: { ...SESSION, sessionId: `ses_${suffix}` },
    });
  };
  try {
    const auth = new HubAuth({ baseUrl: "https://hub.example", statePath, fetchImpl: hubFetch });
    await auth.exchangeGithubToken("github-a");
    const client = new MarketClient({
      baseUrl: "https://hub.example",
      publisherToken: "",
      authTokenSnapshot: () => auth.credential(),
      onAuthFailure: (failed) => auth.clearPersistedAuthIfCurrent(failed),
      fetchImpl: async () => {
        marketRequestStarted();
        return await new Promise((resolve) => {
          releaseMarketRequest = () => resolve(new Response(
            JSON.stringify({ error: { code: "hub_session_expired", message: "Expired" } }),
            { status: 401, headers: { "content-type": "application/json" } },
          ));
        });
      },
    });
    const pending = client.submitPackage({ repositoryUrl: "https://github.com/example/package" });
    await marketStarted;
    assert.equal(auth.credential().token, "hub-token-a");
    await auth.exchangeGithubToken("github-b");
    assert.equal(auth.credential().token, "hub-token-b");
    releaseMarketRequest();
    await assert.rejects(pending, (error) => error?.code === "hub_session_expired");
    assert.equal(auth.status().authenticated, true);
    assert.equal(auth.credential().token, "hub-token-b");
    assert.equal((await readFile(statePath, "utf8")).includes("hub-token-b"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("HubAuth removes invalid, expired, and Hub-mismatched state files", async () => {
  const root = await mkdtemp(join(tmpdir(), "wuxianpi-hub-auth-stale-"));
  const statePath = join(root, "hub-auth.json");
  const baseState = {
    schemaVersion: 1,
    hubUrl: "https://hub.example",
    hubToken: "hub-token",
    user: USER,
    session: SESSION,
    authenticatedAt: "2026-08-03T00:00:00.000Z",
  };
  try {
    for (const value of [
      { ...baseState, session: { ...SESSION, expiresAt: "not-a-date" } },
      { ...baseState, session: { ...SESSION, expiresAt: undefined } },
      { ...baseState, hubUrl: "https://another-hub.example" },
    ]) {
      await writeFile(statePath, JSON.stringify(value), { mode: 0o600 });
      const auth = new HubAuth({ baseUrl: "https://hub.example", statePath });
      await auth.initialize();
      assert.equal(auth.status().authenticated, false);
      await assert.rejects(readFile(statePath, "utf8"), { code: "ENOENT" });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("HubAuth clears persisted state when Hub rejects the active session", async () => {
  const root = await mkdtemp(join(tmpdir(), "wuxianpi-hub-auth-401-"));
  const statePath = join(root, "hub-auth.json");
  let requestCount = 0;
  try {
    const auth = new HubAuth({
      baseUrl: "https://hub.example",
      statePath,
      fetchImpl: async (_url, init = {}) => {
        requestCount += 1;
        if (requestCount === 1) return jsonResponse({ token: "hub-token", user: USER, session: SESSION });
        assert.equal(new Headers(init.headers).get("authorization"), "Bearer hub-token");
        return new Response("not-json", { status: 401 });
      },
      runGhToken: async () => "github-token",
    });
    await auth.loginWithGh();
    assert.equal(auth.status().authenticated, true);
    const loggedOut = await auth.logout();
    assert.equal(loggedOut.authenticated, false);
    assert.equal(loggedOut.remoteRevoked, false);
    await assert.rejects(readFile(statePath, "utf8"), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}
