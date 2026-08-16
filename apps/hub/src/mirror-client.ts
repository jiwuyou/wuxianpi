import type { GitSource, ReleaseRecord } from "./types.js";

export interface HubMirrorClient {
  registerRelease(release: ReleaseRecord): Promise<void>;
  findSource(repositoryUrl: string, approvedCommit: string): Promise<GitSource | null>;
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
    });
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

  private async request(path: string, init: RequestInit): Promise<Record<string, unknown>> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${this.token}`,
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`Mirror service request failed (${response.status})`);
    const body = await response.json() as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Mirror service returned invalid JSON");
    return body as Record<string, unknown>;
  }
}
