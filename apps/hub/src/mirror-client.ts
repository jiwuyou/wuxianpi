import type { GitSource, ReleaseRecord } from "./types.js";

export type MirrorTargetStatus = "active" | "paused" | "ready" | "oversized" | "failed";
export type MirrorJobStatus = "pending" | "running" | "succeeded" | "failed" | "oversized";

const TARGET_STATUSES = new Set<MirrorTargetStatus>(["active", "paused", "ready", "oversized", "failed"]);
const JOB_STATUSES = new Set<MirrorJobStatus>(["pending", "running", "succeeded", "failed", "oversized"]);

export interface MirrorTarget {
  id: string;
  repositoryUrl: string;
  mode: "tracking" | "pinned";
  branch: string | null;
  approvedCommit: string | null;
  mirrorUrl: string;
  maxSizeBytes: number;
  intervalSeconds: number;
  status: MirrorTargetStatus;
  currentSizeBytes: number | null;
  lastSyncedCommit: string | null;
  lastError: string | null;
  nextSyncAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MirrorJob {
  id: string;
  targetId: string;
  releaseId: string | null;
  packageId: string | null;
  requestedCommit: string | null;
  status: MirrorJobStatus;
  attempts: number;
  availableAt: string;
  leaseUntil: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateMirrorTargetInput {
  repositoryUrl: string;
  branch: string;
  intervalSeconds: number;
  maxSizeBytes: number;
}

export interface UpdateMirrorTargetInput {
  branch?: string;
  intervalSeconds?: number;
  maxSizeBytes?: number;
}

export interface HubMirrorClient {
  registerRelease(release: ReleaseRecord): Promise<void>;
  findSource(repositoryUrl: string, approvedCommit: string): Promise<GitSource | null>;
  listTargets(): Promise<MirrorTarget[]>;
  createTarget(input: CreateMirrorTargetInput): Promise<MirrorTarget>;
  updateTarget(targetId: string, input: UpdateMirrorTargetInput): Promise<MirrorTarget>;
  listJobs(targetId: string): Promise<MirrorJob[]>;
  sync(targetId: string): Promise<MirrorJob>;
  pause(targetId: string): Promise<MirrorTarget>;
  resume(targetId: string): Promise<MirrorTarget>;
}

export class HubMirrorRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HubMirrorRequestError";
  }
}

export class HttpHubMirrorClient implements HubMirrorClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  async registerRelease(release: ReleaseRecord): Promise<void> {
    await this.request("/api/v1/releases", {
      method: "POST",
      body: JSON.stringify({
        packageId: release.packageId,
        releaseId: release.releaseId,
        repositoryUrl: release.repositoryUrl,
        approvedCommit: release.approvedCommit,
      }),
    }, 35_000);
  }

  async findSource(repositoryUrl: string, approvedCommit: string): Promise<GitSource | null> {
    const query = new URLSearchParams({ repositoryUrl, approvedCommit });
    const body = await this.request(`/api/v1/sources?${query.toString()}`, { method: "GET" });
    const source = body.source;
    if (source === null) return null;
    if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error("Mirror service returned an invalid source");
    const value = source as Record<string, unknown>;
    if (
      value.kind !== "mirror" || typeof value.url !== "string" || !value.url.startsWith("https://") ||
      value.verifiedCommit !== approvedCommit || typeof value.priority !== "number"
    ) {
      throw new Error("Mirror service returned an unverified source");
    }
    return { kind: "mirror", url: value.url, priority: value.priority };
  }

  async listTargets(): Promise<MirrorTarget[]> {
    const body = await this.request("/api/v1/targets", { method: "GET" });
    return mirrorArray(body.targets, mirrorTarget, "targets");
  }

  async createTarget(input: CreateMirrorTargetInput): Promise<MirrorTarget> {
    const body = await this.request("/api/v1/targets", {
      method: "POST",
      body: JSON.stringify({ ...input, mode: "tracking" }),
    }, 35_000);
    return mirrorTarget(body.target);
  }

  async updateTarget(targetId: string, input: UpdateMirrorTargetInput): Promise<MirrorTarget> {
    const body = await this.request(`/api/v1/targets/${encodeURIComponent(targetId)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    });
    return mirrorTarget(body.target);
  }

  async listJobs(targetId: string): Promise<MirrorJob[]> {
    const body = await this.request(`/api/v1/targets/${encodeURIComponent(targetId)}/jobs`, { method: "GET" });
    return mirrorArray(body.jobs, mirrorJob, "jobs");
  }

  async sync(targetId: string): Promise<MirrorJob> {
    const body = await this.request(`/api/v1/targets/${encodeURIComponent(targetId)}/sync`, { method: "POST" });
    return mirrorJob(body.job);
  }

  async pause(targetId: string): Promise<MirrorTarget> {
    const body = await this.request(`/api/v1/targets/${encodeURIComponent(targetId)}/pause`, { method: "POST" });
    return mirrorTarget(body.target);
  }

  async resume(targetId: string): Promise<MirrorTarget> {
    const body = await this.request(`/api/v1/targets/${encodeURIComponent(targetId)}/resume`, { method: "POST" });
    return mirrorTarget(body.target);
  }

  private async request(path: string, init: RequestInit, timeoutMs = 5_000): Promise<Record<string, unknown>> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${this.token}`,
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    let body: unknown;
    try { body = await response.json(); }
    catch { throw new Error("Mirror service returned invalid JSON"); }
    if (!response.ok) {
      const error = body && typeof body === "object" && !Array.isArray(body)
        ? (body as Record<string, unknown>).error : null;
      const detail = error && typeof error === "object" && !Array.isArray(error) ? error as Record<string, unknown> : {};
      throw new HubMirrorRequestError(
        response.status,
        typeof detail.code === "string" ? detail.code : "mirror_request_failed",
        typeof detail.message === "string" ? detail.message : `Mirror service request failed (${response.status})`,
      );
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Mirror service returned invalid JSON");
    return body as Record<string, unknown>;
  }
}

function mirrorArray<T>(value: unknown, parse: (item: unknown) => T, name: string): T[] {
  if (!Array.isArray(value)) throw new Error(`Mirror service returned invalid ${name}`);
  return value.map(parse);
}

function mirrorTarget(value: unknown): MirrorTarget {
  const item = object(value, "target");
  if (
    typeof item.id !== "string" || typeof item.repositoryUrl !== "string" ||
    (item.mode !== "tracking" && item.mode !== "pinned") ||
    typeof item.mirrorUrl !== "string" || typeof item.maxSizeBytes !== "number" ||
    typeof item.intervalSeconds !== "number" ||
    !TARGET_STATUSES.has(item.status as MirrorTargetStatus) ||
    !nullableString(item.branch) || !nullableString(item.approvedCommit) ||
    !nullableNumber(item.currentSizeBytes) || !nullableString(item.lastSyncedCommit) ||
    !nullableString(item.lastError) || !nullableString(item.nextSyncAt) ||
    typeof item.createdAt !== "string" || typeof item.updatedAt !== "string"
  ) throw new Error("Mirror service returned an invalid target");
  return item as unknown as MirrorTarget;
}

function mirrorJob(value: unknown): MirrorJob {
  const item = object(value, "job");
  if (
    typeof item.id !== "string" || typeof item.targetId !== "string" ||
    !JOB_STATUSES.has(item.status as MirrorJobStatus) || typeof item.attempts !== "number" ||
    !nullableString(item.releaseId) || !nullableString(item.packageId) ||
    !nullableString(item.requestedCommit) || !nullableString(item.leaseUntil) ||
    !nullableString(item.lastError) || typeof item.availableAt !== "string" ||
    typeof item.createdAt !== "string" || typeof item.updatedAt !== "string"
  ) throw new Error("Mirror service returned an invalid job");
  return item as unknown as MirrorJob;
}

function nullableString(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function nullableNumber(value: unknown): boolean {
  return value === null || typeof value === "number";
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Mirror service returned an invalid ${name}`);
  return value as Record<string, unknown>;
}
