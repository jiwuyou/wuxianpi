import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { test } from "node:test";
import { HubAuthService, type HubAuthDatabase, type StoredHubSession } from "../src/auth-service.js";
import { loadConfig } from "../src/config.js";
import { HubDatabase } from "../src/database.js";
import { HubError } from "../src/errors.js";
import {
  RealGitHubAuthGateway,
  type GitHubAuthGateway,
  type GitHubDeviceAuthorization,
  type GitHubIdentity,
} from "../src/github-auth.js";
import type { GlobalRole, HubActor, HubSession, HubUser } from "../src/types.js";

const IDENTITY: GitHubIdentity = {
  githubId: "1234567",
  login: "wuxian-user",
  name: "Wuxian User",
  avatarUrl: "https://avatars.githubusercontent.com/u/1234567",
  profileUrl: "https://github.com/wuxian-user",
};

class MemoryAuthDatabase implements HubAuthDatabase {
  readonly users = new Map<string, HubUser>();
  readonly userIdByGitHubId = new Map<string, string>();
  readonly sessions = new Map<string, StoredHubSession>();
  readonly sessionIdByTokenHash = new Map<string, string>();

  upsertUser(identity: GitHubIdentity, now: string): HubUser {
    const existingId = this.userIdByGitHubId.get(identity.githubId);
    const existing = existingId ? this.users.get(existingId) : undefined;
    const user: HubUser = {
      userId: existing?.userId ?? `usr_gh_${identity.githubId}`,
      githubId: identity.githubId,
      login: identity.login,
      name: identity.name,
      avatarUrl: identity.avatarUrl,
      profileUrl: identity.profileUrl,
      role: existing?.role ?? "user",
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.users.set(user.userId, user);
    this.userIdByGitHubId.set(user.githubId, user.userId);
    return { ...user };
  }

  getUser(userId: string): HubUser | null {
    const user = this.users.get(userId);
    return user ? { ...user } : null;
  }

  updateUserRole(userId: string, role: GlobalRole, now: string): boolean {
    const current = this.users.get(userId);
    if (!current) return false;
    const user = { ...current, role, updatedAt: now };
    this.users.set(userId, user);
    return true;
  }

  insertSession(session: StoredHubSession): void {
    if (this.sessions.has(session.sessionId) || this.sessionIdByTokenHash.has(session.tokenHash)) throw new Error("duplicate session");
    this.sessions.set(session.sessionId, { ...session });
    this.sessionIdByTokenHash.set(session.tokenHash, session.sessionId);
  }

  getSessionByTokenHash(tokenHash: string): HubSession | null {
    const id = this.sessionIdByTokenHash.get(tokenHash);
    const stored = id ? this.sessions.get(id) : undefined;
    if (!stored) return null;
    const { tokenHash: _tokenHash, ...session } = stored;
    return { ...session };
  }

  touchSession(sessionId: string, lastUsedAt: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || session.revokedAt) return false;
    this.sessions.set(sessionId, { ...session, lastUsedAt });
    return true;
  }

  listSessions(userId: string): HubSession[] {
    return [...this.sessions.values()]
      .filter((session) => session.userId === userId)
      .map(({ tokenHash: _tokenHash, ...session }) => ({ ...session }))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  revokeSession(sessionId: string, revokedAt: string, userId?: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || (userId !== undefined && session.userId !== userId) || session.revokedAt) return false;
    this.sessions.set(sessionId, { ...session, revokedAt });
    return true;
  }
}

class FakeGitHubGateway implements GitHubAuthGateway {
  identity = { ...IDENTITY };
  seenTokens: string[] = [];
  startedClientIds: string[] = [];
  completed: Array<{ clientId: string; deviceCode: string }> = [];

  async getIdentity(token: string): Promise<GitHubIdentity> {
    this.seenTokens.push(token);
    return { ...this.identity };
  }

  async startDeviceFlow(clientId: string): Promise<GitHubDeviceAuthorization> {
    this.startedClientIds.push(clientId);
    return {
      deviceCode: "device_code_123456",
      userCode: "ABCD-EFGH",
      verificationUri: "https://github.com/login/device",
      expiresIn: 900,
      interval: 5,
    };
  }

  async completeDeviceFlow(clientId: string, deviceCode: string): Promise<GitHubIdentity> {
    this.completed.push({ clientId, deviceCode });
    return { ...this.identity };
  }
}

function fixture(now = "2026-08-03T12:00:00.000Z") {
  let current = new Date(now);
  const database = new MemoryAuthDatabase();
  const github = new FakeGitHubGateway();
  const service = new HubAuthService({
    database,
    github,
    githubClientId: "github-client-id",
    sessionDays: 30,
    now: () => new Date(current),
  });
  return {
    database,
    github,
    service,
    advance(ms: number) { current = new Date(current.getTime() + ms); },
  };
}

function expectHubError(error: unknown, status: number, code: string): boolean {
  assert.ok(error instanceof HubError);
  assert.equal(error.status, status);
  assert.equal(error.code, code);
  return true;
}

test("GitHub exchange binds by numeric ID and stores only the Hub token digest", async () => {
  const { database, github, service, advance } = fixture();
  const credential = await service.exchangeGitHubToken("github-secret-token", { kind: "browser", label: "Firefox on phone" });

  assert.deepEqual(github.seenTokens, ["github-secret-token"]);
  assert.equal(credential.user.githubId, IDENTITY.githubId);
  assert.equal(credential.session.kind, "browser");
  assert.equal(credential.session.label, "Firefox on phone");
  assert.match(credential.token, /^wph_[A-Za-z0-9_-]{43}$/);
  const stored = database.sessions.get(credential.session.sessionId);
  assert.ok(stored);
  assert.equal(stored.tokenHash, createHash("sha256").update(credential.token).digest("hex"));
  assert.equal(JSON.stringify({ users: [...database.users.values()], sessions: [...database.sessions.values()] }).includes("github-secret-token"), false);

  database.updateUserRole(credential.user.userId, "reviewer", "2026-08-03T12:01:00.000Z");
  advance(120_000);
  github.identity = { ...IDENTITY, login: "renamed-user", name: "Renamed User" };
  const second = await service.exchangeGitHubToken("another-github-token", { kind: "device" });
  assert.equal(second.user.userId, credential.user.userId);
  assert.equal(second.user.login, "renamed-user");
  assert.equal(second.user.role, "reviewer");
  assert.equal(database.users.size, 1);
});

test("HubAuthService uses the production HubDatabase contract", async () => {
  const database = new HubDatabase(":memory:");
  try {
    const service = new HubAuthService({
      database,
      github: new FakeGitHubGateway(),
      githubClientId: "github-client-id",
      sessionDays: 30,
      now: () => new Date("2026-08-03T12:00:00.000Z"),
    });
    const credential = await service.exchangeGitHubToken("github-token", { kind: "device", label: "Termux" });
    const row = database.sqlite.prepare("SELECT token_hash FROM sessions WHERE session_id = ?")
      .get(credential.session.sessionId) as { token_hash: string } | undefined;
    assert.equal(row?.token_hash, createHash("sha256").update(credential.token).digest("hex"));
    assert.notEqual(row?.token_hash, credential.token);
    assert.equal(service.getMe(credential.token).user.githubId, IDENTITY.githubId);
  } finally {
    database.close();
  }
});

test("device flow uses configured client ID and never exposes the GitHub access token", async () => {
  const { github, service } = fixture();
  const authorization = await service.startGitHubDeviceFlow();
  assert.equal(authorization.userCode, "ABCD-EFGH");
  assert.deepEqual(github.startedClientIds, ["github-client-id"]);

  const credential = await service.completeGitHubDeviceFlow("device_code_123456");
  assert.equal(credential.session.kind, "device");
  assert.equal(credential.session.label, "WuxianPi device");
  assert.deepEqual(github.completed, [{ clientId: "github-client-id", deviceCode: "device_code_123456" }]);
  assert.deepEqual(Object.keys(credential).sort(), ["session", "token", "user"]);

  const unconfigured = new HubAuthService({
    database: new MemoryAuthDatabase(),
    github,
    githubClientId: "",
    sessionDays: 30,
  });
  await assert.rejects(() => unconfigured.startGitHubDeviceFlow(), (error) => expectHubError(error, 503, "github_device_auth_not_configured"));
});

test("me, authentication, session listing, and revocation share one session authority", async () => {
  const { database, service, advance } = fixture();
  const browser = await service.exchangeGitHubToken("github-token-a", { kind: "browser" });
  advance(60_000);
  const device = await service.exchangeGitHubToken("github-token-b", { kind: "device", label: "Phone CLI" });

  const me = service.getMe(browser.token);
  assert.equal(me.user.userId, browser.user.userId);
  assert.equal(me.session.sessionId, browser.session.sessionId);
  assert.equal(me.session.lastUsedAt, "2026-08-03T12:01:00.000Z");
  assert.equal(service.authenticate(browser.token).sessionId, browser.session.sessionId);
  assert.equal(service.listSessions(browser.token).length, 2);

  service.revokeOwnSession(browser.token, device.session.sessionId);
  assert.throws(() => service.getMe(device.token), (error) => expectHubError(error, 401, "hub_auth_invalid"));
  service.logout(browser.token);
  assert.throws(() => service.authenticate(browser.token), (error) => expectHubError(error, 401, "hub_auth_invalid"));
  assert.equal([...database.sessions.values()].every((session) => session.revokedAt !== null), true);
});

test("expired sessions are rejected and persistently revoked", async () => {
  const { database, service, advance } = fixture();
  const credential = await service.exchangeGitHubToken("github-token", { kind: "browser" });
  advance(31 * 86_400_000);

  assert.throws(() => service.getMe(credential.token), (error) => expectHubError(error, 401, "hub_session_expired"));
  assert.equal(database.sessions.get(credential.session.sessionId)?.revokedAt, "2026-09-03T12:00:00.000Z");
});

test("only an administrator can change a global user role", async () => {
  const { service } = fixture();
  const credential = await service.exchangeGitHubToken("github-token", { kind: "browser" });
  const ordinaryActor = service.authenticate(credential.token);
  assert.throws(
    () => service.updateUserRole(ordinaryActor, credential.user.userId, "reviewer"),
    (error) => expectHubError(error, 403, "admin_required"),
  );

  const adminActor: HubActor = { kind: "admin", id: "bootstrap-admin", name: "Bootstrap administrator" };
  const updated = service.updateUserRole(adminActor, credential.user.userId, "reviewer");
  assert.equal(updated.role, "reviewer");
});

test("the real GitHub gateway uses form device requests and keeps its OAuth token internal", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const responses = [
    new Response(JSON.stringify({ access_token: "transient-oauth-token", token_type: "bearer" }), { status: 200 }),
    new Response(JSON.stringify({ id: 42, login: "octocat", name: null, avatar_url: null, html_url: "https://github.com/octocat" }), { status: 200 }),
  ];
  const gateway = new RealGitHubAuthGateway(async (input, init) => {
    requests.push({ url: String(input), ...(init === undefined ? {} : { init }) });
    const response = responses.shift();
    if (!response) throw new Error("unexpected request");
    return response;
  });

  const identity = await gateway.completeDeviceFlow("client-id", "device-code-1234");
  assert.equal(identity.githubId, "42");
  assert.equal(identity.name, "octocat");
  assert.equal(requests[0]?.init?.headers && new Headers(requests[0].init.headers).get("content-type"), "application/x-www-form-urlencoded");
  assert.match(String(requests[0]?.init?.body), /client_id=client-id/);
  assert.equal(new Headers(requests[1]?.init?.headers).get("authorization"), "Bearer transient-oauth-token");
  assert.equal(JSON.stringify(identity).includes("transient-oauth-token"), false);
});

test("Hub auth configuration preserves static credentials and validates session lifetime", () => {
  const packageSchema = resolve(import.meta.dirname, "../../../packages/contracts/wuxianpi-package.schema.json");
  const config = loadConfig({
    HUB_PORT: "20879",
    HUB_PACKAGE_SCHEMA: packageSchema,
    HUB_ADMIN_TOKEN: "admin-secret",
    HUB_PUBLISHER_TOKENS: JSON.stringify({ legacy: { token: "publisher-secret", name: "Legacy Publisher" } }),
    HUB_GITHUB_CLIENT_ID: " client-id ",
    HUB_SESSION_DAYS: "45",
  });
  assert.equal(config.adminToken, "admin-secret");
  assert.equal(config.publisherCredentials.get("legacy")?.token, "publisher-secret");
  assert.equal(config.githubClientId, "client-id");
  assert.equal(config.sessionDays, 45);

  assert.throws(
    () => loadConfig({
      HUB_PACKAGE_SCHEMA: packageSchema,
      HUB_SESSION_DAYS: "0",
    }),
    /HUB_SESSION_DAYS is invalid/,
  );
});
