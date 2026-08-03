import { RequestError } from "./protocol.js";
import type { InstallPlan } from "./package-types.js";

export const DEFAULT_HUB_URL = "https://wuxianpihub.webefficacy.com";

export interface MarketAuthCredential {
  token: string;
  sessionGeneration: string;
}

export interface MarketClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  publisherToken?: string;
  authToken?: () => string | undefined;
  authTokenSnapshot?: () => MarketAuthCredential | undefined;
  onAuthFailure?: (credential: MarketAuthCredential) => Promise<void> | void;
}

export class MarketClient {
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly publisherToken?: string;
  private readonly authTokenProvider?: () => string | undefined;
  private readonly authTokenSnapshot?: () => MarketAuthCredential | undefined;
  private readonly onAuthFailure?: (credential: MarketAuthCredential) => Promise<void> | void;

  constructor(options: MarketClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? process.env.WUXIANPI_HUB_URL ?? DEFAULT_HUB_URL).replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.publisherToken = options.publisherToken ?? process.env.WUXIANPI_HUB_PUBLISHER_TOKEN;
    this.authTokenProvider = options.authToken;
    this.authTokenSnapshot = options.authTokenSnapshot;
    this.onAuthFailure = options.onAuthFailure;
  }

  listPackages(query: URLSearchParams | Record<string, string | number | undefined> = {}): Promise<Record<string, unknown>> {
    return this.get("/api/v1/packages", query);
  }

  packageDetail(packageId: string): Promise<Record<string, unknown>> {
    return this.get(`/api/v1/packages/${encodeURIComponent(packageId)}`);
  }

  releases(packageId: string, query: URLSearchParams | Record<string, string | number | undefined> = {}): Promise<Record<string, unknown>> {
    return this.get(`/api/v1/packages/${encodeURIComponent(packageId)}/releases`, query);
  }

  async installPlan(packageId: string, options: {
    releaseId?: string;
    hostCapabilities?: Array<{ id: string; contractVersion: number }>;
  } = {}): Promise<InstallPlan> {
    const query = new URLSearchParams();
    if (options.releaseId) query.set("releaseId", options.releaseId);
    for (const capability of options.hostCapabilities ?? []) {
      query.append("hostCapability", `${capability.id}@${capability.contractVersion}`);
    }
    const plan = await this.get(`/api/v1/packages/${encodeURIComponent(packageId)}/install-plan`, query) as unknown as InstallPlan;
    validateInstallPlan(plan, packageId);
    return plan;
  }

  async installPlanForCommit(packageId: string, approvedCommit: string, options: {
    hostCapabilities?: Array<{ id: string; contractVersion: number }>;
  } = {}): Promise<InstallPlan> {
    if (!/^[a-f0-9]{40}$/.test(approvedCommit)) throw new RequestError("invalid_dependency_commit", "Dependency commit must be a full Git commit");
    let cursor: string | undefined;
    do {
      const page = await this.releases(packageId, { limit: 100, ...(cursor ? { cursor } : {}) });
      const releases = Array.isArray(page.releases) ? page.releases : [];
      const release = releases.find((item) => isRecord(item) && item.approvedCommit === approvedCommit);
      if (release && typeof release.releaseId === "string") {
        const plan = await this.installPlan(packageId, { releaseId: release.releaseId, hostCapabilities: options.hostCapabilities });
        if (plan.approvedCommit !== approvedCommit) throw new RequestError("package_dependency_release_unavailable", `Hub release ${release.releaseId} did not resolve to ${approvedCommit}`);
        return plan;
      }
      cursor = typeof page.nextCursor === "string" && page.nextCursor ? page.nextCursor : undefined;
    } while (cursor);
    throw new RequestError("package_dependency_release_unavailable", `No immutable Hub release resolves ${packageId}@${approvedCommit}`, { httpStatus: 404 });
  }

  submitPackage(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.authenticatedRequest("/api/v1/publisher/submissions", { method: "POST", body: input });
  }

  authStatus(): { authenticated: boolean; source: "hub_session" | "legacy_publisher_token" | null } {
    const fallbackToken = this.authTokenProvider?.();
    const dynamic = this.authTokenSnapshot?.() ?? (fallbackToken ? { token: fallbackToken, sessionGeneration: "legacy" } : undefined);
    return {
      authenticated: !!(dynamic || this.publisherToken),
      source: dynamic ? "hub_session" : this.publisherToken ? "legacy_publisher_token" : null,
    };
  }

  authenticatedGet(path: string, query: URLSearchParams | Record<string, string | number | undefined> = {}): Promise<Record<string, unknown>> {
    const url = new URL(`${this.baseUrl}${requireAuthenticatedPath(path)}`);
    if (query instanceof URLSearchParams) url.search = query.toString();
    else for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, String(value));
    return this.authenticatedRequest(url.pathname + url.search);
  }

  authenticatedRequest(path: string, options: {
    method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
    body?: Record<string, unknown>;
  } = {}): Promise<Record<string, unknown>> {
    const dynamicCredential = this.authTokenSnapshot?.();
    const dynamicToken = dynamicCredential?.token ?? this.authTokenProvider?.();
    const token = dynamicToken ?? this.publisherToken;
    if (!token) {
      throw new RequestError("hub_auth_required", "Sign in to WuxianPi Hub before using publisher or management operations", { httpStatus: 401 });
    }
    return this.request(requireAuthenticatedPath(path), {
      method: options.method ?? "GET",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }, dynamicToken && this.onAuthFailure
      ? () => this.onAuthFailure!(dynamicCredential ?? { token: dynamicToken, sessionGeneration: "legacy" })
      : undefined);
  }

  private async get(path: string, query: URLSearchParams | Record<string, string | number | undefined> = {}): Promise<Record<string, unknown>> {
    const url = new URL(`${this.baseUrl}${path}`);
    if (query instanceof URLSearchParams) url.search = query.toString();
    else for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, String(value));
    return this.request(url.pathname + url.search, { headers: { accept: "application/json" } });
  }

  private async request(path: string, init: RequestInit, onAuthFailure?: () => Promise<void> | void): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref();
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, signal: controller.signal });
    } catch (error) {
      throw new RequestError("market_unavailable", `Unable to reach WuxianPi Hub: ${errorMessage(error)}`, { httpStatus: 503 });
    } finally {
      clearTimeout(timer);
    }
    let payload: unknown;
    try { payload = await response.json(); }
    catch {
      if (onAuthFailure && response.status === 401) await onAuthFailure();
      throw new RequestError("market_invalid_response", `WuxianPi Hub returned invalid JSON (${response.status})`, { httpStatus: 502, hubStatus: response.status });
    }
    if (!response.ok) {
      const error = isRecord(payload) && isRecord(payload.error) ? payload.error : {};
      if (onAuthFailure && (response.status === 401 || isHubAuthFailure(error.code))) await onAuthFailure();
      throw new RequestError(
        typeof error.code === "string" ? error.code : "market_request_failed",
        typeof error.message === "string" ? error.message : `WuxianPi Hub request failed (${response.status})`,
        { httpStatus: response.status, hubError: error },
      );
    }
    if (!isRecord(payload)) throw new RequestError("market_invalid_response", "WuxianPi Hub response must be an object", { httpStatus: 502, hubStatus: response.status });
    return payload;
  }
}

function validateInstallPlan(plan: InstallPlan, requestedPackageId: string): void {
  if (!plan || plan.schemaVersion !== 1 || plan.packageId !== requestedPackageId) {
    throw new RequestError("invalid_install_plan", "Install plan identity is invalid");
  }
  if (!/^[a-f0-9]{40}$/.test(plan.approvedCommit) || !/^[a-f0-9]{64}$/.test(plan.manifestDigest)) {
    throw new RequestError("invalid_install_plan", "Install plan commit or manifest digest is invalid");
  }
  if (!Array.isArray(plan.gitSources) || plan.gitSources.length === 0) {
    throw new RequestError("invalid_install_plan", "Install plan has no Git sources");
  }
  if (plan.revoked) throw new RequestError("release_revoked", `Release ${plan.releaseId} is revoked`);
  if (plan.verification?.status !== "passed") throw new RequestError("release_unverified", `Release ${plan.releaseId} is not verified`);
}

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireAuthenticatedPath(path: string): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  if (!normalized.startsWith("/api/v1/")) {
    throw new RequestError("invalid_market_path", "Authenticated Hub path must be under /api/v1/", { httpStatus: 400 });
  }
  return normalized;
}

function isHubAuthFailure(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return /(?:auth|token|session).*(?:invalid|expired|revoked)|(?:invalid|expired|revoked).*(?:auth|token|session)/i.test(value);
}
