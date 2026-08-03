import { execFile } from "node:child_process";
import { chmod, readFile, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { writeAtomicJson } from "./package-storage.js";
import { RequestError } from "./protocol.js";
import type { MarketAuthCredential } from "./market-client.js";

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 30_000;

export interface HubAuthUser {
  userId: string;
  githubId: string;
  login: string;
  name: string;
  avatarUrl: string | null;
  profileUrl: string;
  role?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface HubAuthSessionMetadata {
  sessionId: string;
  userId?: string;
  kind?: string;
  label?: string;
  createdAt?: string;
  lastUsedAt?: string;
  expiresAt: string;
  revokedAt?: string | null;
}

export interface HubAuthStatus {
  authenticated: boolean;
  source: "hub_session" | null;
  hubUrl: string;
  user: HubAuthUser | null;
  session: HubAuthSessionMetadata | null;
  authenticatedAt: string | null;
}

export type HubAuthCredential = MarketAuthCredential;

interface StoredHubAuth {
  schemaVersion: 1;
  hubUrl: string;
  hubToken: string;
  user: HubAuthUser;
  session: HubAuthSessionMetadata;
  authenticatedAt: string;
}

export interface HubAuthOptions {
  baseUrl: string;
  statePath: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  runGhToken?: () => Promise<string>;
}

export class HubAuth {
  readonly baseUrl: string;
  readonly statePath: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly runGhToken: () => Promise<string>;
  private state?: StoredHubAuth;
  private initializePromise?: Promise<void>;
  private mutationTail: Promise<void> = Promise.resolve();
  private clearStatePromise?: Promise<void>;

  constructor(options: HubAuthOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.statePath = options.statePath;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.runGhToken = options.runGhToken ?? readGhToken;
  }

  initialize(): Promise<void> {
    this.initializePromise ??= this.load();
    return this.initializePromise;
  }

  token(): string | undefined {
    return this.activeState()?.hubToken;
  }

  credential(): HubAuthCredential | undefined {
    const state = this.activeState();
    return state ? { token: state.hubToken, sessionGeneration: state.session.sessionId } : undefined;
  }

  status(): HubAuthStatus {
    const state = this.activeState();
    return {
      authenticated: !!state,
      source: state ? "hub_session" : null,
      hubUrl: this.baseUrl,
      user: state?.user ?? null,
      session: state?.session ?? null,
      authenticatedAt: state?.authenticatedAt ?? null,
    };
  }

  async loginWithGh(label?: string): Promise<HubAuthStatus> {
    return this.mutate(async () => {
      await this.initialize();
      let githubToken: string;
      try {
        githubToken = (await this.runGhToken()).trim();
      } catch (error) {
        const code = errorCode(error);
        throw new RequestError(
          code === "ENOENT" ? "github_cli_not_found" : "github_cli_not_authenticated",
          code === "ENOENT"
            ? "GitHub CLI is not installed or is not available in PATH"
            : "GitHub CLI is not authenticated; run gh auth login first",
          { httpStatus: code === "ENOENT" ? 503 : 401 },
        );
      }
      if (!githubToken) {
        throw new RequestError("github_cli_token_missing", "GitHub CLI did not return an authentication token", { httpStatus: 401 });
      }
      return this.exchangeGithubTokenNow(githubToken, label);
    });
  }

  async exchangeGithubToken(githubToken: string, label?: string): Promise<HubAuthStatus> {
    return this.mutate(async () => {
      await this.initialize();
      return this.exchangeGithubTokenNow(githubToken, label);
    });
  }

  private async exchangeGithubTokenNow(githubToken: string, label?: string): Promise<HubAuthStatus> {
    const token = githubToken.trim();
    if (!token) throw new RequestError("github_token_required", "GitHub token is required", { httpStatus: 400 });
    const payload = await this.request("/api/v1/auth/github/token-exchange", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ githubToken: token, kind: "device", ...(label?.trim() ? { label: label.trim() } : {}) }),
    }, undefined, [token]);
    await this.acceptAuthPayload(payload);
    return this.status();
  }

  async startDeviceFlow(input: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    await this.initialize();
    return this.request("/api/v1/auth/github/device/start", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(input),
    });
  }

  async completeDeviceFlow(input: Record<string, unknown>): Promise<HubAuthStatus> {
    return this.mutate(async () => {
      await this.initialize();
      const payload = await this.request("/api/v1/auth/github/device/complete", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(input),
      });
      await this.acceptAuthPayload(payload);
      return this.status();
    });
  }

  async logout(): Promise<HubAuthStatus & { remoteRevoked: boolean }> {
    return this.mutate(async () => {
      await this.initialize();
      const hubToken = this.state?.hubToken;
      let remoteRevoked = true;
      if (hubToken) {
        try {
          await this.request("/api/v1/auth/logout", {
            method: "POST",
            headers: { authorization: `Bearer ${hubToken}`, accept: "application/json" },
          }, hubToken);
        } catch {
          remoteRevoked = false;
        }
      }
      this.state = undefined;
      await this.clearPersistedAuth();
      return { ...this.status(), remoteRevoked };
    });
  }

  async clearPersistedAuth(): Promise<void> {
    this.state = undefined;
    this.clearStatePromise ??= rm(this.statePath, { force: true }).finally(() => {
      this.clearStatePromise = undefined;
    });
    return this.clearStatePromise;
  }

  async clearPersistedAuthIfCurrent(failed: HubAuthCredential): Promise<boolean> {
    return this.mutate(async () => {
      await this.initialize();
      const current = this.credential();
      if (!current || current.token !== failed.token || current.sessionGeneration !== failed.sessionGeneration) return false;
      await this.clearPersistedAuth();
      return true;
    });
  }

  private async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.statePath, "utf8")) as unknown;
      const state = parseStoredState(parsed);
      if (state.hubUrl !== this.baseUrl || isExpired(state.session.expiresAt)) {
        await this.clearPersistedAuth();
        return;
      }
      this.state = state;
      await chmod(this.statePath, 0o600);
    } catch (error) {
      if (isMissing(error)) return;
      await this.clearPersistedAuth();
    }
  }

  private async acceptAuthPayload(payload: Record<string, unknown>): Promise<void> {
    const parsed = parseAuthPayload(payload);
    const state: StoredHubAuth = {
      schemaVersion: 1,
      hubUrl: this.baseUrl,
      hubToken: parsed.hubToken,
      user: parsed.user,
      session: parsed.session,
      authenticatedAt: new Date().toISOString(),
    };
    await writeAtomicJson(this.statePath, state);
    await chmod(this.statePath, 0o600);
    this.state = state;
  }

  private activeState(): StoredHubAuth | undefined {
    if (this.state && isExpired(this.state.session.expiresAt)) void this.clearPersistedAuth().catch(() => undefined);
    return this.state;
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation, operation);
    this.mutationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async request(
    path: string,
    init: RequestInit,
    hubToken?: string,
    secrets: string[] = [],
  ): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref();
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          ...(init.headers ?? {}),
          ...(hubToken ? { authorization: `Bearer ${hubToken}` } : {}),
        },
        signal: controller.signal,
      });
    } catch (error) {
      throw new RequestError("market_unavailable", redact(`Unable to reach WuxianPi Hub: ${errorMessage(error)}`, secrets), { httpStatus: 503 });
    } finally {
      clearTimeout(timer);
    }
    let payload: unknown = {};
    if (response.status !== 204) {
      try {
        payload = await response.json();
      } catch {
        if (hubToken && response.status === 401) await this.clearPersistedAuth();
        throw new RequestError("market_invalid_response", `WuxianPi Hub returned invalid JSON (${response.status})`, { httpStatus: 502 });
      }
    }
    if (!response.ok) {
      const error = isRecord(payload) && isRecord(payload.error) ? payload.error : {};
      if (hubToken && (response.status === 401 || isHubAuthFailure(error.code))) await this.clearPersistedAuth();
      throw new RequestError(
        typeof error.code === "string" ? error.code : "market_request_failed",
        redact(typeof error.message === "string" ? error.message : `WuxianPi Hub request failed (${response.status})`, secrets),
        { httpStatus: response.status },
      );
    }
    if (!isRecord(payload)) throw new RequestError("market_invalid_response", "WuxianPi Hub response must be an object", { httpStatus: 502 });
    return payload;
  }
}

async function readGhToken(): Promise<string> {
  const { stdout } = await execFileAsync("gh", ["auth", "token"], {
    timeout: 15_000,
    maxBuffer: 64 * 1024,
    windowsHide: true,
  });
  return stdout;
}

function parseStoredState(value: unknown): StoredHubAuth {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.hubUrl !== "string" || typeof value.hubToken !== "string" ||
      typeof value.authenticatedAt !== "string" || !isRecord(value.session)) throw new Error("Invalid Hub auth state");
  return {
    schemaVersion: 1,
    hubUrl: value.hubUrl,
    hubToken: value.hubToken,
    user: parseUser(value.user),
    session: parseSession(value.session),
    authenticatedAt: value.authenticatedAt,
  };
}

function parseAuthPayload(payload: Record<string, unknown>): { hubToken: string; user: HubAuthUser; session: HubAuthSessionMetadata } {
  const data = isRecord(payload.data) ? payload.data : payload;
  const auth = isRecord(data.auth) ? data.auth : data;
  const sessionContainer = isRecord(auth.session) ? auth.session : isRecord(data.session) ? data.session : undefined;
  const hubToken = firstString(auth.hubToken, auth.token, auth.accessToken, auth.deviceToken, sessionContainer?.token, sessionContainer?.hubToken);
  const userValue = auth.user ?? data.user ?? sessionContainer?.user;
  if (!hubToken) throw new RequestError("hub_token_missing", "WuxianPi Hub did not return a Hub access token", { httpStatus: 502 });
  return {
    hubToken,
    user: parseUser(userValue),
    session: sessionContainer ? parseSession(sessionContainer) : parseSession({}),
  };
}

function parseUser(value: unknown): HubAuthUser {
  if (!isRecord(value)) throw new RequestError("hub_user_missing", "WuxianPi Hub did not return user metadata", { httpStatus: 502 });
  const userId = firstString(value.userId, value.id);
  const githubId = firstString(value.githubId, value.githubUserId);
  const login = firstString(value.login, value.githubLogin, value.username);
  if (!userId || !githubId || !login) throw new RequestError("hub_user_invalid", "WuxianPi Hub returned invalid user metadata", { httpStatus: 502 });
  return {
    userId,
    githubId,
    login,
    name: firstString(value.name) ?? login,
    avatarUrl: firstString(value.avatarUrl, value.avatar_url) ?? null,
    profileUrl: firstString(value.profileUrl, value.html_url) ?? `https://github.com/${encodeURIComponent(login)}`,
    ...(firstString(value.role) ? { role: firstString(value.role) } : {}),
    ...(firstString(value.createdAt) ? { createdAt: firstString(value.createdAt) } : {}),
    ...(firstString(value.updatedAt) ? { updatedAt: firstString(value.updatedAt) } : {}),
  };
}

function parseSession(value: Record<string, unknown>): HubAuthSessionMetadata {
  const sessionId = firstString(value.sessionId, value.id);
  const expiresAt = firstString(value.expiresAt);
  if (!sessionId || !expiresAt || !Number.isFinite(Date.parse(expiresAt))) {
    throw new RequestError("hub_session_invalid", "WuxianPi Hub returned invalid session metadata", { httpStatus: 502 });
  }
  return {
    sessionId,
    ...(firstString(value.userId) ? { userId: firstString(value.userId) } : {}),
    ...(firstString(value.kind) ? { kind: firstString(value.kind) } : {}),
    ...(firstString(value.label) ? { label: firstString(value.label) } : {}),
    ...(firstString(value.createdAt) ? { createdAt: firstString(value.createdAt) } : {}),
    ...(firstString(value.lastUsedAt) ? { lastUsedAt: firstString(value.lastUsedAt) } : {}),
    expiresAt,
    ...(value.revokedAt === null ? { revokedAt: null } : firstString(value.revokedAt) ? { revokedAt: firstString(value.revokedAt) } : {}),
  };
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim();
}

function isExpired(value: string | undefined): boolean {
  if (!value) return true;
  const timestamp = Date.parse(value);
  return !Number.isFinite(timestamp) || timestamp <= Date.now();
}

function isHubAuthFailure(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return /(?:auth|token|session).*(?:invalid|expired|revoked)|(?:invalid|expired|revoked).*(?:auth|token|session)/i.test(value);
}

function redact(message: string, secrets: string[]): string {
  return secrets.filter(Boolean).reduce((current, secret) => current.split(secret).join("[redacted]"), message);
}

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
