import { randomUUID } from "node:crypto";
import type { HubDatabase } from "./database.js";
import { asErrorMessage, HubError } from "./errors.js";
import type { GitGateway } from "./git.js";
import type { PackageValidator } from "./validator.js";
import type {
  GitSource,
  PackagePresentationMetadata,
  PublisherIdentity,
  ReleaseRecord,
  SourceHealth,
  SubmissionRecord,
} from "./types.js";
import { CONTRIBUTION_TYPES, PACKAGE_CATEGORIES } from "./types.js";
import { validatePublisherMetadata } from "./metadata.js";

const FULL_COMMIT = /^[a-f0-9]{40}$/;
const HTTPS_URL = /^https:\/\/[^\s]+$/;

const now = () => new Date().toISOString();
const id = (prefix: string) => `${prefix}_${randomUUID().replaceAll("-", "")}`;

function parseRepositoryUrl(value: unknown): string {
  if (typeof value !== "string" || !HTTPS_URL.test(value)) throw new HubError(400, "invalid_repository", "repositoryUrl must be an HTTPS URL");
  const url = new URL(value);
  if (url.hostname !== "github.com") throw new HubError(400, "invalid_repository", "The primary repository must be hosted on github.com");
  if (!url.pathname.endsWith(".git")) url.pathname = `${url.pathname.replace(/\/$/, "")}.git`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function parseRef(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 240) throw new HubError(400, "invalid_ref", "ref must be a non-empty Git ref");
  return value.trim();
}

function parseMirrorUrls(value: unknown): string[] {
  if (!Array.isArray(value)) throw new HubError(400, "invalid_mirrors", "mirrorUrls must be an array");
  const result = value.map((item) => {
    if (typeof item !== "string" || !HTTPS_URL.test(item)) throw new HubError(400, "invalid_mirrors", "Every mirror must be an HTTPS Git URL");
    return item;
  });
  if (new Set(result).size !== result.length) throw new HubError(400, "invalid_mirrors", "mirrorUrls must be unique");
  return result;
}

function cursorOffset(cursor: string | null): number {
  if (!cursor) return 0;
  try {
    const value = Number.parseInt(Buffer.from(cursor, "base64url").toString("utf8"), 10);
    if (!Number.isInteger(value) || value < 0) throw new Error("invalid");
    return value;
  } catch {
    throw new HubError(400, "invalid_cursor", "The pagination cursor is invalid");
  }
}

function nextCursor(offset: number, limit: number, count: number): string | null {
  return offset + limit < count ? Buffer.from(String(offset + limit)).toString("base64url") : null;
}

function pageLimit(value: string | null): number {
  if (value === null) return 24;
  const limit = Number.parseInt(value, 10);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new HubError(400, "invalid_limit", "limit must be between 1 and 100");
  return limit;
}

function publicSubmission(record: SubmissionRecord) {
  return {
    submissionId: record.submissionId,
    repositoryUrl: record.repositoryUrl,
    requestedRef: record.requestedRef,
    resolvedCommit: record.resolvedCommit,
    mirrorUrls: record.mirrorUrls,
    metadata: record.metadata,
    status: record.status,
    diagnostics: record.diagnostics,
    verification: record.verification,
    revision: record.revision,
    sourceHealth: record.sourceHealth,
    packageId: record.manifest?.id ?? null,
    version: record.manifest?.version ?? null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export interface HubServiceOptions {
  database: HubDatabase;
  git: GitGateway;
  validator: PackageValidator;
  publicUrl: string;
}

export class HubService {
  private readonly pending = new Map<string, Promise<void>>();

  constructor(private readonly options: HubServiceOptions) {}

  resumePendingSubmissions(): void {
    for (const submissionId of this.options.database.listPendingSubmissionIds()) {
      this.options.database.updateSubmission(submissionId, { status: "queued", updatedAt: now() });
      this.enqueueVerification(submissionId);
    }
  }

  async createSubmission(publisher: PublisherIdentity, body: unknown): Promise<ReturnType<typeof publicSubmission>> {
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new HubError(400, "invalid_request", "A JSON object is required");
    const input = body as Record<string, unknown>;
    const repositoryUrl = parseRepositoryUrl(input.repositoryUrl);
    const requestedRef = parseRef(input.ref);
    const mirrorUrls = parseMirrorUrls(input.mirrorUrls);
    const metadata = validatePublisherMetadata(input.metadata);
    const resolvedCommit = await this.resolveCommit(repositoryUrl, requestedRef);
    const timestamp = now();
    this.options.database.upsertPublisher(publisher, timestamp);
    const record: SubmissionRecord = {
      submissionId: id("sub"),
      publisherId: publisher.id,
      repositoryUrl,
      requestedRef,
      resolvedCommit,
      mirrorUrls,
      metadata,
      status: "queued",
      diagnostics: [],
      verification: null,
      manifest: null,
      manifestDigest: null,
      sourceHealth: [],
      revision: 1,
      verifiedRevision: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.options.database.insertSubmission(record);
    this.enqueueVerification(record.submissionId);
    return publicSubmission(record);
  }

  getSubmission(publisherId: string, submissionId: string): ReturnType<typeof publicSubmission> {
    const record = this.requireSubmission(submissionId);
    if (record.publisherId !== publisherId) throw new HubError(404, "submission_not_found", "The requested submission does not exist");
    return publicSubmission(record);
  }

  async updateSubmission(publisherId: string, submissionId: string, body: unknown): Promise<ReturnType<typeof publicSubmission>> {
    await this.pending.get(submissionId);
    const record = this.requireSubmission(submissionId);
    if (record.publisherId !== publisherId) throw new HubError(404, "submission_not_found", "The requested submission does not exist");
    if (record.status === "approved") throw new HubError(409, "immutable_submission", "An approved submission is immutable");
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new HubError(400, "invalid_request", "A JSON object is required");
    const input = body as Record<string, unknown>;
    const requestedRef = Object.hasOwn(input, "ref") ? parseRef(input.ref) : record.requestedRef;
    const mirrorUrls = Object.hasOwn(input, "mirrorUrls") ? parseMirrorUrls(input.mirrorUrls) : record.mirrorUrls;
    const metadata = Object.hasOwn(input, "metadata") ? validatePublisherMetadata(input.metadata) : record.metadata;
    const resolvedCommit = requestedRef !== record.requestedRef
      ? await this.resolveCommit(record.repositoryUrl, requestedRef)
      : record.resolvedCommit ?? await this.resolveCommit(record.repositoryUrl, requestedRef);
    const updated = this.options.database.updateSubmissionIf(submissionId, record.revision, record.status, {
      requestedRef,
      resolvedCommit,
      mirrorUrls,
      metadata,
      status: "queued",
      diagnostics: [],
      verification: null,
      manifest: null,
      manifestDigest: null,
      sourceHealth: [],
      revision: record.revision + 1,
      verifiedRevision: null,
      updatedAt: now(),
    });
    if (!updated) {
      const current = this.requireSubmission(submissionId);
      if (current.status === "approved") throw new HubError(409, "immutable_submission", "An approved submission is immutable");
      throw new HubError(409, "submission_changed", "Submission changed while the publisher update was being prepared");
    }
    this.enqueueVerification(submissionId);
    return publicSubmission(this.requireSubmission(submissionId));
  }

  async syncSubmission(publisherId: string, submissionId: string): Promise<ReturnType<typeof publicSubmission>> {
    const source = this.requireSubmission(submissionId);
    if (source.publisherId !== publisherId) throw new HubError(404, "submission_not_found", "The requested submission does not exist");
    const publisher = this.options.database.getPublisher(publisherId);
    if (!publisher) throw new HubError(404, "publisher_not_found", "Publisher does not exist");
    return await this.createSubmission(publisher, {
      repositoryUrl: source.repositoryUrl,
      ref: source.requestedRef,
      mirrorUrls: source.mirrorUrls,
      metadata: source.metadata,
    });
  }

  async waitForVerification(submissionId: string): Promise<void> {
    await this.pending.get(submissionId);
  }

  private async resolveCommit(repositoryUrl: string, requestedRef: string): Promise<string> {
    try {
      const commit = await this.options.git.resolveRef(repositoryUrl, requestedRef);
      if (!FULL_COMMIT.test(commit)) throw new Error("Git source did not return a full commit hash");
      return commit;
    } catch (error) {
      throw new HubError(422, "ref_not_found", `Unable to resolve Git ref: ${asErrorMessage(error)}`);
    }
  }

  private enqueueVerification(submissionId: string): void {
    const existing = this.pending.get(submissionId);
    if (existing) return;
    const task = this.verifySubmission(submissionId).finally(() => this.pending.delete(submissionId));
    this.pending.set(submissionId, task);
  }

  private async verifySubmission(submissionId: string): Promise<void> {
    const record = this.requireSubmission(submissionId);
    if (!record.resolvedCommit) return;
    if (!this.options.database.updateSubmissionIf(submissionId, record.revision, "queued", { status: "verifying", updatedAt: now() })) return;
    const sources: GitSource[] = [
      { kind: "github", url: record.repositoryUrl, priority: 100 },
      ...record.mirrorUrls.map((url, index) => ({ kind: "mirror" as const, url, priority: Math.max(0, 80 - index) })),
    ];
    let sourceHealth: SourceHealth[] = [];
    try {
      const checkout = await this.options.git.checkoutExact(sources, record.resolvedCommit);
      sourceHealth = checkout.sourceHealth;
      for (const health of sourceHealth) this.options.database.recordSourceHealth(health);
      try {
        const output = await this.options.validator.verify(checkout.directory, record.metadata);
        this.options.database.updateSubmissionIf(submissionId, record.revision, "verifying", {
          status: "awaiting_review",
          diagnostics: output.diagnostics,
          verification: output.verification,
          manifest: output.manifest,
          manifestDigest: output.manifestDigest,
          sourceHealth,
          verifiedRevision: record.revision,
          updatedAt: now(),
        });
      } finally {
        await checkout.cleanup();
      }
    } catch (error) {
      const attached = (error as { sourceHealth?: SourceHealth[] }).sourceHealth;
      if (attached) sourceHealth = attached;
      for (const health of sourceHealth) this.options.database.recordSourceHealth(health);
      this.options.database.updateSubmissionIf(submissionId, record.revision, "verifying", {
        status: "failed",
        diagnostics: [asErrorMessage(error)],
        verification: { status: "failed", verifiedAt: now(), checks: [] },
        sourceHealth,
        updatedAt: now(),
      });
    }
  }

  async approveSubmission(submissionId: string, notes: string | null, actor: string): Promise<{ releaseId: string; packageId: string; approvedCommit: string }> {
    const record = this.requireSubmission(submissionId);
    if (
      record.status !== "awaiting_review" || record.verification?.status !== "passed" ||
      record.verifiedRevision !== record.revision || !record.manifest || !record.manifestDigest || !record.resolvedCommit
    ) {
      throw new HubError(409, "submission_not_ready", "Submission verification is not passing and unchanged");
    }
    const currentCommit = await this.resolveCommit(record.repositoryUrl, record.requestedRef);
    if (currentCommit !== record.resolvedCommit) throw new HubError(409, "submission_changed", "The submitted ref moved after verification; sync a new submission");
    const existingPackage = this.options.database.getPackageRow(record.manifest.id);
    if (existingPackage && existingPackage.publisherId !== record.publisherId) throw new HubError(409, "package_owned", "Package ID belongs to another publisher");
    const timestamp = now();
    const release: ReleaseRecord = {
      releaseId: id("rel"),
      packageId: record.manifest.id,
      submissionId: record.submissionId,
      publisherId: record.publisherId,
      version: record.manifest.version,
      approvedCommit: record.resolvedCommit,
      submittedRef: record.requestedRef,
      repositoryUrl: record.repositoryUrl,
      mirrorUrls: record.mirrorUrls,
      manifestPath: "wuxianpi-package.json",
      manifestDigest: record.manifestDigest,
      manifest: record.manifest,
      metadata: record.metadata,
      verification: record.verification,
      status: "approved",
      publishedAt: timestamp,
      revocation: null,
    };
    try {
      const approved = this.options.database.approveSubmission(release, {
        revision: record.revision,
        manifestDigest: record.manifestDigest,
        metadata: record.metadata,
      });
      if (!approved) throw new HubError(409, "submission_changed", "Submission changed after review and must be verified again");
    } catch (error) {
      if (asErrorMessage(error).includes("UNIQUE")) throw new HubError(409, "release_exists", "This immutable Package commit is already published");
      throw error;
    }
    this.options.database.addAudit({
      id: id("audit"), actor, action: "approve", targetType: "submission", targetId: submissionId,
      detail: { notes, releaseId: release.releaseId, approvedCommit: release.approvedCommit }, createdAt: timestamp,
    });
    return { releaseId: release.releaseId, packageId: release.packageId, approvedCommit: release.approvedCommit };
  }

  rejectSubmission(submissionId: string, reason: string, actor: string): void {
    const record = this.requireSubmission(submissionId);
    if (record.status === "approved") throw new HubError(409, "immutable_submission", "An approved submission is immutable");
    const timestamp = now();
    const rejected = this.options.database.updateSubmissionIf(submissionId, record.revision, record.status, {
      status: "rejected",
      diagnostics: [reason],
      updatedAt: timestamp,
    });
    if (!rejected) throw new HubError(409, "submission_changed", "Submission changed before rejection was recorded");
    this.options.database.addAudit({ id: id("audit"), actor, action: "reject", targetType: "submission", targetId: submissionId, detail: { reason }, createdAt: timestamp });
  }

  revokeRelease(releaseId: string, reason: string, actor: string): void {
    const release = this.options.database.getRelease(releaseId);
    if (!release) throw new HubError(404, "release_not_found", "The requested release does not exist");
    if (release.status === "revoked") throw new HubError(409, "release_revoked", "The release is already revoked");
    const timestamp = now();
    this.options.database.revokeRelease(releaseId, { reason, revokedAt: timestamp });
    this.options.database.addAudit({ id: id("audit"), actor, action: "revoke", targetType: "release", targetId: releaseId, detail: { reason }, createdAt: timestamp });
  }

  listPackages(query: URLSearchParams) {
    const q = query.get("q")?.trim() || null;
    const category = query.get("category");
    if (category && !PACKAGE_CATEGORIES.includes(category as never)) throw new HubError(400, "invalid_category", "Unknown Package category");
    const contributionType = query.get("contributionType");
    if (contributionType && !CONTRIBUTION_TYPES.includes(contributionType as never)) throw new HubError(400, "invalid_contribution_type", "Unknown contribution type");
    const offset = cursorOffset(query.get("cursor"));
    const limit = pageLimit(query.get("limit"));
    const filters = { q, category, contributionType };
    const count = this.options.database.countPackages(filters);
    return {
      packages: this.options.database.listPackages({ ...filters, offset, limit }),
      nextCursor: nextCursor(offset, limit, count),
    };
  }

  getPackage(packageId: string) {
    const row = this.options.database.getPackageRow(packageId);
    const latestRelease = this.options.database.getLatestRelease(packageId);
    const release = latestRelease ?? this.options.database.getNewestRelease(packageId);
    if (!row || !release) throw new HubError(404, "package_not_found", "The requested Package does not exist");
    const publisher = this.options.database.getPublisher(row.publisherId);
    if (!publisher) throw new HubError(500, "publisher_missing", "Package publisher record is missing");
    const links = [...release.metadata.links];
    const ids = new Set(links.map((item) => item.id));
    if (!ids.has("source")) links.unshift({ id: "source", kind: "source", label: "Source", url: release.repositoryUrl.replace(/\.git$/, ""), source: "manifest" });
    if (release.manifest.homepage && !ids.has("homepage")) links.push({ id: "homepage", kind: "homepage", label: "Homepage", url: release.manifest.homepage, source: "manifest" });
    return {
      package: {
        id: release.manifest.id,
        name: release.manifest.name,
        summary: release.manifest.summary,
        description: release.manifest.description ?? null,
        license: release.manifest.license ?? null,
        categories: release.manifest.categories,
        publisher: {
          id: publisher.id,
          name: publisher.name,
          profileUrl: publisher.profileUrl,
        },
        links,
        screenshots: release.metadata.screenshots.map((screenshot) => ({
          ...screenshot,
          downloadSources: [{
            kind: "mirror" as const,
            url: `${this.options.publicUrl}/api/v1/assets/${screenshot.sha256}`,
            priority: 1000,
          }],
        })),
        contributionTypes: [...new Set(release.manifest.contributions.map((item) => item.type))],
        latestRelease: latestRelease ? {
          releaseId: latestRelease.releaseId,
          version: latestRelease.version,
          approvedCommit: latestRelease.approvedCommit,
          publishedAt: latestRelease.publishedAt,
          status: latestRelease.status,
        } : null,
        review: { status: latestRelease ? "approved" : "revoked", reviewedAt: release.publishedAt },
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      },
    };
  }

  listReleases(packageId: string, query: URLSearchParams) {
    if (!this.options.database.getPackageRow(packageId)) throw new HubError(404, "package_not_found", "The requested Package does not exist");
    const offset = cursorOffset(query.get("cursor"));
    const limit = pageLimit(query.get("limit"));
    const count = this.options.database.countReleases(packageId);
    const releases = this.options.database.listReleases(packageId, offset, limit).map((release) => ({
      releaseId: release.releaseId,
      version: release.version,
      approvedCommit: release.approvedCommit,
      submittedRef: release.submittedRef,
      manifest: { path: release.manifestPath, sha256: release.manifestDigest },
      contributionTypes: [...new Set(release.manifest.contributions.map((item) => item.type))],
      verification: release.verification,
      status: release.status,
      publishedAt: release.publishedAt,
      revocation: release.revocation,
      installPlanUrl: `/api/v1/packages/${encodeURIComponent(packageId)}/install-plan?releaseId=${encodeURIComponent(release.releaseId)}`,
    }));
    return { packageId, releases, nextCursor: nextCursor(offset, limit, count) };
  }

  getInstallPlan(packageId: string, query: URLSearchParams) {
    const releaseId = query.get("releaseId");
    const advertised = query.getAll("hostCapability");
    const approved = releaseId ? [] : this.options.database.listApprovedReleases(packageId);
    const release = releaseId
      ? this.options.database.getRelease(releaseId)
      : approved.find((candidate) => this.isCompatible(candidate, advertised)) ?? null;
    if (!releaseId && !release && approved.length > 0) {
      const missing = this.missingCapabilities(approved[0]!, advertised);
      throw new HubError(409, "incompatible_host", `Host is missing capabilities: ${missing.join(", ")}`);
    }
    if (!release || release.packageId !== packageId) throw new HubError(404, "release_not_found", "The requested release does not exist");
    if (release.status === "revoked") throw new HubError(410, "release_revoked", release.revocation?.reason ?? "The requested release was revoked");
    if (!this.isCompatible(release, advertised)) {
      const missing = this.missingCapabilities(release, advertised);
      throw new HubError(409, "incompatible_host", `Host is missing capabilities: ${missing.join(", ")}`);
    }
    return {
      schemaVersion: 1,
      packageId: release.packageId,
      releaseId: release.releaseId,
      version: release.version,
      approvedCommit: release.approvedCommit,
      manifestPath: release.manifestPath,
      manifestDigest: release.manifestDigest,
      gitSources: [
        { kind: "github", url: release.repositoryUrl, priority: 100 },
        ...release.mirrorUrls.map((url, index) => ({ kind: "mirror", url, priority: Math.max(0, 80 - index) })),
      ],
      artifacts: release.manifest.artifacts,
      compatibility: release.manifest.requires,
      verification: release.verification,
      revoked: false,
    };
  }

  private isCompatible(release: ReleaseRecord, advertised: string[]): boolean {
    return advertised.length === 0 || this.missingCapabilities(release, advertised).length === 0;
  }

  private missingCapabilities(release: ReleaseRecord, advertised: string[]): string[] {
    const capabilities = new Set(advertised);
    return release.manifest.requires.hostCapabilities
      .map((item) => `${item.id}@${item.contractVersion}`)
      .filter((capability) => !capabilities.has(capability));
  }

  private requireSubmission(id: string): SubmissionRecord {
    const record = this.options.database.getSubmission(id);
    if (!record) throw new HubError(404, "submission_not_found", "The requested submission does not exist");
    return record;
  }
}
