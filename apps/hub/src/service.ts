import { randomUUID } from "node:crypto";
import type { HubDatabase } from "./database.js";
import { asErrorMessage, HubError } from "./errors.js";
import type { GitGateway } from "./git.js";
import type { PackageValidator } from "./validator.js";
import type {
  ContributionProposal,
  GitSource,
  HubUser,
  IssueActor,
  IssueStatus,
  PackageMember,
  PackagePresentationMetadata,
  PackageRole,
  ProposalStatus,
  PublisherIdentity,
  ReleaseRecord,
  ReviewDecision,
  SourceHealth,
  SubmissionReview,
  SupportIssueRecord,
  SubmissionRecord,
  SubmissionStatus,
} from "./types.js";
import { CONTRIBUTION_TYPES, PACKAGE_CATEGORIES } from "./types.js";
import { validatePublisherMetadata } from "./metadata.js";
import type { HubMirrorClient } from "./mirror-client.js";

const FULL_COMMIT = /^[a-f0-9]{40}$/;
const HTTPS_URL = /^https:\/\/[^\s]+$/;
const GITHUB_REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ISSUE_STATUSES = new Set<IssueStatus>([
  "pending", "confirmed", "in_progress", "awaiting_verification", "resolved",
  "cannot_reproduce", "declined", "migrated",
]);
const PACKAGE_ROLES = new Set<PackageRole>(["owner", "maintainer", "contributor"]);
const PROPOSAL_MUTABLE_STATUSES = new Set<ProposalStatus>([
  "queued", "verifying", "awaiting_owner", "changes_requested", "failed",
]);
const REVIEWABLE_SUBMISSION_STATUSES = new Set<SubmissionStatus>(["awaiting_review"]);

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

function optionalText(value: unknown, field: string, maxLength: number): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new HubError(400, "invalid_request", `${field} must be a non-empty string up to ${maxLength} characters`);
  }
  return value.trim();
}

function requiredIssueText(value: unknown, field: string, maxLength: number): string {
  const parsed = optionalText(value, field, maxLength);
  if (!parsed) throw new HubError(400, "invalid_request", `${field} is required`);
  return parsed;
}

function requiredText(value: unknown, field: string, maxLength: number): string {
  const parsed = optionalText(value, field, maxLength);
  if (!parsed) throw new HubError(400, "invalid_request", `${field} is required`);
  return parsed;
}

function parseReasonCodes(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20) {
    throw new HubError(400, "invalid_reason_codes", "reasonCodes must contain at most 20 values");
  }
  return [...new Set(value.map((item) => requiredText(item, "reasonCode", 80)))];
}

function parseProposedPatch(value: unknown): Record<string, unknown> | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new HubError(400, "invalid_proposed_patch", "proposedPatch must be an object");
  }
  if (JSON.stringify(value).length > 64_000) {
    throw new HubError(400, "invalid_proposed_patch", "proposedPatch exceeds 64 KiB");
  }
  return value as Record<string, unknown>;
}

function parseExpectedRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new HubError(400, "invalid_revision", "expectedRevision must be a positive integer");
  }
  return value;
}

function parseRepository(value: unknown): string | null {
  const raw = optionalText(value, "targetRepository", 240);
  if (!raw) return null;
  const repository = raw.replace(/^https:\/\/github\.com\//i, "").replace(/\.git$/i, "").replace(/^\/+|\/+$/g, "");
  if (!GITHUB_REPOSITORY.test(repository)) throw new HubError(400, "invalid_repository", "targetRepository must be owner/name or a github.com repository URL");
  return repository;
}

function parseIssueLabels(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20) throw new HubError(400, "invalid_request", "labels must be an array with at most 20 items");
  return [...new Set(value.map((item) => requiredIssueText(item, "label", 100)))];
}

function parseEnvironment(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HubError(400, "invalid_request", "environment must be an object");
  if (JSON.stringify(value).length > 32_000) throw new HubError(400, "invalid_request", "environment exceeds 32 KiB");
  return value as Record<string, unknown>;
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
  mirror?: HubMirrorClient;
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
    const proposal = this.options.database.getContributionProposalBySubmission(submissionId);
    if (proposal && ["released", "withdrawn", "rejected"].includes(proposal.status)) {
      throw new HubError(409, "proposal_immutable", "This contribution proposal can no longer be changed");
    }
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

  listPublisherSubmissions(publisherId: string) {
    return {
      submissions: this.options.database.listSubmissionsByPublisher(publisherId)
        .map((record) => this.submissionGovernanceView(record)),
    };
  }

  listReviewerSubmissions(statuses: SubmissionStatus[] = ["awaiting_review", "changes_requested"]) {
    return {
      submissions: this.options.database.listSubmissionsForReview(statuses)
        .map((record) => this.submissionGovernanceView(record)),
    };
  }

  getSubmissionGovernance(submissionId: string) {
    return this.submissionGovernanceView(this.requireSubmission(submissionId));
  }

  async reviewSubmission(
    submissionId: string,
    reviewer: Pick<HubUser, "userId" | "name" | "role">,
    body: unknown,
  ) {
    if (reviewer.role !== "reviewer" && reviewer.role !== "admin") {
      throw new HubError(403, "reviewer_required", "Reviewer or administrator access is required");
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new HubError(400, "invalid_request", "A JSON object is required");
    }
    const input = body as Record<string, unknown>;
    const decision = requiredText(input.decision, "decision", 40) as ReviewDecision;
    if (!["changes_requested", "approved", "rejected"].includes(decision)) {
      throw new HubError(400, "invalid_review_decision", "Reviewer decision must request changes, approve, or reject");
    }
    const message = requiredText(input.message, "message", 12_000);
    const expectedRevision = input.expectedRevision === undefined
      ? undefined
      : parseExpectedRevision(input.expectedRevision);
    if (decision === "approved" && expectedRevision === undefined) {
      throw new HubError(400, "revision_required", "expectedRevision is required for reviewer approval");
    }
    const detail = {
      reasonCodes: parseReasonCodes(input.reasonCodes),
      message,
      proposedPatch: parseProposedPatch(input.proposedPatch),
    };
    if (decision === "approved") {
      return {
        decision,
        release: await this.approveSubmission(submissionId, message, reviewer.userId, expectedRevision, {
          reviewerName: reviewer.name,
          ...detail,
        }),
      };
    }
    if (decision === "changes_requested") {
      this.requestSubmissionChanges(submissionId, reviewer, detail, expectedRevision);
      return { decision, submission: this.getSubmissionGovernance(submissionId) };
    }
    this.rejectSubmission(submissionId, message, reviewer.userId, expectedRevision, {
      reviewerName: reviewer.name,
      ...detail,
    });
    return { decision, submission: this.getSubmissionGovernance(submissionId) };
  }

  requestSubmissionChanges(
    submissionId: string,
    reviewer: Pick<HubUser, "userId" | "name">,
    detail: { reasonCodes: string[]; message: string; proposedPatch: Record<string, unknown> | null },
    expectedRevision?: number,
  ): void {
    const record = this.requireSubmission(submissionId);
    if (expectedRevision !== undefined && record.revision !== expectedRevision) {
      throw new HubError(409, "submission_revision_stale", "The submission changed after the reviewer loaded it");
    }
    if (!REVIEWABLE_SUBMISSION_STATUSES.has(record.status)) {
      throw new HubError(409, "submission_not_reviewable", "Submission is not awaiting review");
    }
    const timestamp = now();
    const review = this.createReview(record, reviewer.userId, reviewer.name, "changes_requested", detail, timestamp);
    if (!this.options.database.recordSubmissionReview(
      review, record.status, "changes_requested", [detail.message], timestamp,
    )) {
      throw new HubError(409, "submission_changed", "Submission changed before the review was recorded");
    }
    this.options.database.addAudit({
      id: id("audit"), actor: reviewer.userId, action: "request_changes",
      targetType: "submission", targetId: submissionId,
      detail: { revision: record.revision, reasonCodes: detail.reasonCodes }, createdAt: timestamp,
    });
  }

  async withdrawSubmission(publisherId: string, submissionId: string): Promise<void> {
    await this.pending.get(submissionId);
    const record = this.requireSubmission(submissionId);
    if (record.publisherId !== publisherId) {
      throw new HubError(404, "submission_not_found", "The requested submission does not exist");
    }
    if (record.status === "approved") throw new HubError(409, "immutable_submission", "An approved submission is immutable");
    if (record.status === "withdrawn") return;
    const timestamp = now();
    if (!this.options.database.updateSubmissionIf(submissionId, record.revision, record.status, {
      status: "withdrawn", updatedAt: timestamp,
    })) {
      throw new HubError(409, "submission_changed", "Submission changed before withdrawal was recorded");
    }
    const proposal = this.options.database.getContributionProposalBySubmission(submissionId);
    if (proposal && proposal.status !== "released") {
      this.options.database.updateContributionProposal(proposal.proposalId, proposal.status, {
        status: "withdrawn", updatedAt: timestamp,
      });
    }
    this.options.database.addAudit({
      id: id("audit"), actor: publisherId, action: "withdraw", targetType: "submission",
      targetId: submissionId, detail: { revision: record.revision }, createdAt: timestamp,
    });
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
    this.options.database.updateContributionProposalBySubmission(
      submissionId, ["queued", "changes_requested", "failed"], { status: "verifying", updatedAt: now() },
    );
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
        const verified = this.options.database.updateSubmissionIf(submissionId, record.revision, "verifying", {
          status: "awaiting_review",
          diagnostics: output.diagnostics,
          verification: output.verification,
          manifest: output.manifest,
          manifestDigest: output.manifestDigest,
          sourceHealth,
          verifiedRevision: record.revision,
          updatedAt: now(),
        });
        if (verified) {
          this.options.database.updateContributionProposalBySubmission(
            submissionId, ["verifying", "queued"], { status: "awaiting_owner", updatedAt: now() },
          );
        }
      } finally {
        await checkout.cleanup();
      }
    } catch (error) {
      const attached = (error as { sourceHealth?: SourceHealth[] }).sourceHealth;
      if (attached) sourceHealth = attached;
      for (const health of sourceHealth) this.options.database.recordSourceHealth(health);
      const failed = this.options.database.updateSubmissionIf(submissionId, record.revision, "verifying", {
        status: "failed",
        diagnostics: [asErrorMessage(error)],
        verification: { status: "failed", verifiedAt: now(), checks: [] },
        sourceHealth,
        updatedAt: now(),
      });
      if (failed) {
        this.options.database.updateContributionProposalBySubmission(
          submissionId, ["verifying", "queued"], {
            status: "failed", rejectionReason: asErrorMessage(error), updatedAt: now(),
          },
        );
      }
    }
  }

  async approveSubmission(
    submissionId: string,
    notes: string | null,
    actor: string,
    expectedRevision?: number,
    reviewDetail?: {
      reviewerName: string;
      reasonCodes: string[];
      message: string;
      proposedPatch: Record<string, unknown> | null;
    },
  ): Promise<{ releaseId: string; packageId: string; approvedCommit: string }> {
    const record = this.requireSubmission(submissionId);
    if (expectedRevision !== undefined) {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
        throw new HubError(400, "invalid_revision", "expectedRevision must be a positive integer");
      }
      if (record.revision !== expectedRevision) {
        throw new HubError(409, "submission_revision_stale", "The submission changed after the reviewer loaded it");
      }
    }
    if (
      record.status !== "awaiting_review" || record.verification?.status !== "passed" ||
      record.verifiedRevision !== record.revision || !record.manifest || !record.manifestDigest || !record.resolvedCommit
    ) {
      throw new HubError(409, "submission_not_ready", "Submission verification is not passing and unchanged");
    }
    const currentCommit = await this.resolveCommit(record.repositoryUrl, record.requestedRef);
    if (currentCommit !== record.resolvedCommit) throw new HubError(409, "submission_changed", "The submitted ref moved after verification; sync a new submission");
    const existingPackage = this.options.database.getPackageRow(record.manifest.id);
    const proposal = this.options.database.getContributionProposalBySubmission(submissionId);
    if (proposal) {
      if (proposal.packageId !== record.manifest.id) {
        throw new HubError(409, "proposal_package_mismatch", "Contribution manifest does not target the proposal Package");
      }
      const acceptance = this.options.database.getContributionProposalAcceptance(proposal.proposalId);
      const approvalRevision = expectedRevision ?? record.revision;
      if (
        proposal.status !== "accepted" || !proposal.acceptedBy || !proposal.acceptedAt ||
        !acceptance || acceptance.revision !== approvalRevision || acceptance.commit !== record.resolvedCommit
      ) {
        throw new HubError(409, "proposal_owner_acceptance_required", "A Package owner or maintainer must accept the proposal before review approval");
      }
    } else if (existingPackage && existingPackage.publisherId !== record.publisherId) {
      throw new HubError(409, "package_owned", "Package ID belongs to another publisher");
    }
    const timestamp = now();
    const releasePublisherId = existingPackage?.publisherId ?? record.publisherId;
    const release: ReleaseRecord = {
      releaseId: id("rel"),
      packageId: record.manifest.id,
      submissionId: record.submissionId,
      publisherId: releasePublisherId,
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
      attribution: proposal ? {
        proposalId: proposal.proposalId,
        contributorId: proposal.contributorId,
        contributorName: proposal.contributorName,
        repositoryUrl: record.repositoryUrl,
        approvedCommit: record.resolvedCommit,
      } : null,
    };
    const review = this.createReview(
      record,
      actor,
      reviewDetail?.reviewerName ?? actor,
      "approved",
      reviewDetail ?? {
        reasonCodes: [],
        message: notes ?? "Approved",
        proposedPatch: null,
      },
      timestamp,
    );
    try {
      const approved = this.options.database.approveSubmission(release, {
        revision: expectedRevision ?? record.revision,
        manifestDigest: record.manifestDigest,
        metadata: record.metadata,
      }, review);
      if (!approved) throw new HubError(409, "submission_changed", "Submission changed after review and must be verified again");
    } catch (error) {
      if (asErrorMessage(error).includes("UNIQUE")) throw new HubError(409, "release_exists", "This immutable Package commit is already published");
      throw error;
    }
    this.options.database.addAudit({
      id: id("audit"), actor, action: "approve", targetType: "submission", targetId: submissionId,
      detail: { notes, releaseId: release.releaseId, approvedCommit: release.approvedCommit }, createdAt: timestamp,
    });
    if (this.options.mirror) {
      try {
        await this.options.mirror.registerRelease(release);
      } catch (error) {
        this.options.database.addAudit({
          id: id("audit"), actor: "mirror-adapter", action: "enqueue_failed", targetType: "release", targetId: release.releaseId,
          detail: { error: asErrorMessage(error) }, createdAt: now(),
        });
      }
    }
    return { releaseId: release.releaseId, packageId: release.packageId, approvedCommit: release.approvedCommit };
  }

  rejectSubmission(
    submissionId: string,
    reason: string,
    actor: string,
    expectedRevision?: number,
    reviewDetail?: {
      reviewerName: string;
      reasonCodes: string[];
      message: string;
      proposedPatch: Record<string, unknown> | null;
    },
  ): void {
    const record = this.requireSubmission(submissionId);
    if (expectedRevision !== undefined && record.revision !== expectedRevision) {
      throw new HubError(409, "submission_revision_stale", "The submission changed after the reviewer loaded it");
    }
    if (record.status === "approved") throw new HubError(409, "immutable_submission", "An approved submission is immutable");
    const timestamp = now();
    const detail = reviewDetail ?? {
      reviewerName: actor,
      reasonCodes: [],
      message: reason,
      proposedPatch: null,
    };
    const review = this.createReview(record, actor, detail.reviewerName, "rejected", detail, timestamp);
    const rejected = this.options.database.recordSubmissionReview(
      review, record.status, "rejected", [reason], timestamp,
    );
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

  listPackageMembers(packageId: string): { members: PackageMember[] } {
    this.requirePackage(packageId);
    return { members: this.options.database.listPackageMembers(packageId) };
  }

  upsertPackageMember(
    actor: HubUser,
    packageId: string,
    userId: string,
    role: PackageRole,
  ): PackageMember {
    this.requirePackage(packageId);
    if (!PACKAGE_ROLES.has(role)) throw new HubError(400, "invalid_package_role", "Unknown Package role");
    const actorRole = this.requirePackageManager(actor, packageId);
    if ((role === "owner" || role === "maintainer") && actor.role !== "admin" && actorRole !== "owner") {
      throw new HubError(403, "package_owner_required", "Only a Package owner can assign owners or maintainers");
    }
    if (!this.options.database.getUser(userId)) throw new HubError(404, "user_not_found", "The requested user does not exist");
    const current = this.options.database.getPackageMember(packageId, userId);
    if (current?.role === "owner" && role !== "owner" && this.ownerCount(packageId) <= 1) {
      throw new HubError(409, "last_owner", "A Package must retain at least one owner");
    }
    const timestamp = now();
    const member = this.options.database.upsertPackageMember(packageId, userId, role, timestamp);
    this.options.database.addAudit({
      id: id("audit"), actor: actor.userId, action: current ? "update_member" : "add_member",
      targetType: "package", targetId: packageId, detail: { userId, role }, createdAt: timestamp,
    });
    return member;
  }

  removePackageMember(actor: HubUser, packageId: string, userId: string): void {
    this.requirePackage(packageId);
    const actorRole = this.requirePackageManager(actor, packageId);
    const target = this.options.database.getPackageMember(packageId, userId);
    if (!target) throw new HubError(404, "package_member_not_found", "The requested Package member does not exist");
    if ((target.role === "owner" || target.role === "maintainer") && actor.role !== "admin" && actorRole !== "owner") {
      throw new HubError(403, "package_owner_required", "Only a Package owner can remove owners or maintainers");
    }
    if (target.role === "owner" && this.ownerCount(packageId) <= 1) {
      throw new HubError(409, "last_owner", "A Package must retain at least one owner");
    }
    if (!this.options.database.removePackageMember(packageId, userId)) {
      throw new HubError(409, "package_member_changed", "Package membership changed before removal");
    }
    const timestamp = now();
    this.options.database.addAudit({
      id: id("audit"), actor: actor.userId, action: "remove_member", targetType: "package",
      targetId: packageId, detail: { userId, role: target.role }, createdAt: timestamp,
    });
  }

  listContributionProposals(packageId: string) {
    this.requirePackage(packageId);
    return {
      proposals: this.options.database.listContributionProposals(packageId)
        .map((proposal) => this.proposalView(proposal)),
    };
  }

  listContributorProposals(contributorId: string) {
    return {
      proposals: this.options.database.listContributionProposalsByContributor(contributorId)
        .map((proposal) => this.proposalView(proposal)),
    };
  }

  async createContributionProposal(contributor: HubUser, packageId: string, body: unknown) {
    this.requirePackage(packageId);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new HubError(400, "invalid_request", "A JSON object is required");
    }
    const input = body as Record<string, unknown>;
    const title = requiredText(input.title, "title", 240);
    const summary = requiredText(input.summary, "summary", 4_000);
    const repositoryUrl = parseRepositoryUrl(input.repositoryUrl);
    const requestedRef = parseRef(input.ref);
    const mirrorUrls = parseMirrorUrls(input.mirrorUrls ?? []);
    const metadata = validatePublisherMetadata(input.metadata ?? { links: [], screenshots: [] });
    const resolvedCommit = await this.resolveCommit(repositoryUrl, requestedRef);
    const timestamp = now();
    const publisher = { id: contributor.userId, name: contributor.name, profileUrl: contributor.profileUrl };
    this.options.database.upsertPublisher(publisher, timestamp);
    const submission: SubmissionRecord = {
      submissionId: id("sub"), publisherId: contributor.userId, repositoryUrl, requestedRef,
      resolvedCommit, mirrorUrls, metadata, status: "queued", diagnostics: [], verification: null,
      manifest: null, manifestDigest: null, sourceHealth: [], revision: 1, verifiedRevision: null,
      createdAt: timestamp, updatedAt: timestamp,
    };
    const proposal: ContributionProposal = {
      proposalId: id("proposal"), packageId, submissionId: submission.submissionId,
      contributorId: contributor.userId, contributorName: contributor.name, status: "queued",
      title,
      summary,
      acceptedBy: null, acceptedAt: null, rejectionReason: null,
      createdAt: timestamp, updatedAt: timestamp,
    };
    this.options.database.insertSubmission(submission);
    this.options.database.insertContributionProposal(proposal);
    this.enqueueVerification(submission.submissionId);
    this.options.database.addAudit({
      id: id("audit"), actor: contributor.userId, action: "create", targetType: "contribution_proposal",
      targetId: proposal.proposalId, detail: { packageId, submissionId: submission.submissionId }, createdAt: timestamp,
    });
    return this.proposalView(this.requireProposal(proposal.proposalId));
  }

  async updateContributionProposal(contributorId: string, proposalId: string, body: unknown) {
    const proposal = this.requireProposal(proposalId);
    if (proposal.contributorId !== contributorId) throw new HubError(404, "proposal_not_found", "The requested proposal does not exist");
    if (!PROPOSAL_MUTABLE_STATUSES.has(proposal.status)) {
      throw new HubError(409, "proposal_immutable", "This contribution proposal can no longer be changed");
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new HubError(400, "invalid_request", "A JSON object is required");
    }
    const input = body as Record<string, unknown>;
    const title = Object.hasOwn(input, "title") ? requiredText(input.title, "title", 240) : proposal.title;
    const summary = Object.hasOwn(input, "summary") ? requiredText(input.summary, "summary", 4_000) : proposal.summary;
    const submissionPatch: Record<string, unknown> = {};
    if (Object.hasOwn(input, "ref")) submissionPatch.ref = input.ref;
    if (Object.hasOwn(input, "mirrorUrls")) submissionPatch.mirrorUrls = input.mirrorUrls;
    if (Object.hasOwn(input, "metadata")) submissionPatch.metadata = input.metadata;
    await this.updateSubmission(contributorId, proposal.submissionId, submissionPatch);
    const current = this.requireProposal(proposalId);
    const timestamp = now();
    const changed = this.options.database.updateContributionProposal(proposalId, current.status, {
      title,
      summary,
      updatedAt: timestamp,
    });
    if (!changed) throw new HubError(409, "proposal_changed", "Proposal changed while the update was being recorded");
    return this.proposalView(this.requireProposal(proposalId));
  }

  acceptContributionProposal(actor: HubUser, proposalId: string, expectedRevision: number) {
    const proposal = this.requireProposal(proposalId);
    this.requirePackageManager(actor, proposal.packageId);
    const revision = parseExpectedRevision(expectedRevision);
    const submission = this.requireSubmissionAtRevision(proposal.submissionId, revision);
    if (proposal.status !== "awaiting_owner") {
      throw new HubError(409, "proposal_not_ready", "Proposal verification must pass before owner acceptance");
    }
    if (
      submission.status !== "awaiting_review" || submission.verification?.status !== "passed" ||
      submission.verifiedRevision !== submission.revision || !submission.resolvedCommit || !submission.manifest
    ) {
      throw new HubError(409, "proposal_not_ready", "Proposal verification is not passing and unchanged");
    }
    if (submission.manifest.id !== proposal.packageId) {
      throw new HubError(409, "proposal_package_mismatch", "Contribution manifest does not target the proposal Package");
    }
    const timestamp = now();
    if (!this.options.database.acceptContributionProposal(
      proposalId,
      proposal.status,
      actor.userId,
      timestamp,
      submission.revision,
      submission.resolvedCommit,
    )) {
      throw new HubError(409, "proposal_changed", "Proposal changed before acceptance was recorded");
    }
    this.options.database.insertSubmissionReview(this.createReview(
      submission,
      actor.userId,
      actor.name,
      "accepted",
      { reasonCodes: [], message: "Package owner accepted this contribution proposal.", proposedPatch: null },
      timestamp,
    ));
    this.options.database.addAudit({
      id: id("audit"), actor: actor.userId, action: "accept", targetType: "contribution_proposal",
      targetId: proposalId, detail: { revision: submission.revision, commit: submission.resolvedCommit }, createdAt: timestamp,
    });
    return this.proposalView(this.requireProposal(proposalId));
  }

  requestContributionProposalChanges(actor: HubUser, proposalId: string, body: unknown) {
    const proposal = this.requireProposal(proposalId);
    this.requirePackageManager(actor, proposal.packageId);
    const detail = this.parseReviewDetail(body);
    this.requireSubmissionAtRevision(proposal.submissionId, detail.expectedRevision);
    if (proposal.status !== "awaiting_owner" && proposal.status !== "accepted") {
      throw new HubError(409, "proposal_not_reviewable", "Proposal is not awaiting owner review");
    }
    this.requestSubmissionChanges(proposal.submissionId, actor, detail, detail.expectedRevision);
    return this.proposalView(this.requireProposal(proposalId));
  }

  rejectContributionProposal(actor: HubUser, proposalId: string, body: unknown) {
    const proposal = this.requireProposal(proposalId);
    this.requirePackageManager(actor, proposal.packageId);
    const detail = this.parseReviewDetail(body);
    this.requireSubmissionAtRevision(proposal.submissionId, detail.expectedRevision);
    if (["released", "withdrawn", "rejected"].includes(proposal.status)) {
      throw new HubError(409, "proposal_immutable", "This contribution proposal can no longer be changed");
    }
    this.rejectSubmission(proposal.submissionId, detail.message, actor.userId, detail.expectedRevision, {
      reviewerName: actor.name, ...detail,
    });
    return this.proposalView(this.requireProposal(proposalId));
  }

  async withdrawContributionProposal(contributorId: string, proposalId: string): Promise<void> {
    const proposal = this.requireProposal(proposalId);
    if (proposal.contributorId !== contributorId) throw new HubError(404, "proposal_not_found", "The requested proposal does not exist");
    if (proposal.status === "released") throw new HubError(409, "proposal_immutable", "A released proposal is immutable");
    await this.withdrawSubmission(contributorId, proposal.submissionId);
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

  async getInstallPlan(packageId: string, query: URLSearchParams) {
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
    let officialMirror: GitSource | null = null;
    if (this.options.mirror) {
      try { officialMirror = await this.options.mirror.findSource(release.repositoryUrl, release.approvedCommit); }
      catch { officialMirror = null; }
    }
    const declaredMirrors = release.mirrorUrls
      .filter((url) => url !== officialMirror?.url)
      .map((url, index) => ({ kind: "mirror" as const, url, priority: Math.max(0, 80 - index) }));
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
        ...(officialMirror ? [officialMirror] : []),
        ...declaredMirrors,
      ],
      artifacts: release.manifest.artifacts,
      compatibility: release.manifest.requires,
      verification: release.verification,
      revoked: false,
    };
  }

  createIssue(actor: IssueActor, body: unknown) {
    if (actor.kind !== "reporter") throw new HubError(401, "reporter_auth_required", "A reporter token is required");
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new HubError(400, "invalid_request", "A JSON object is required");
    const input = body as Record<string, unknown>;
    if (input.userConfirmed !== true) throw new HubError(400, "user_confirmation_required", "userConfirmed must be true");
    const packageId = optionalText(input.packageId, "packageId", 160);
    const release = packageId ? this.options.database.getLatestRelease(packageId) ?? this.options.database.getNewestRelease(packageId) : null;
    const targetRepository = parseRepository(input.targetRepository) ?? (release ? parseRepository(release.repositoryUrl) : null);
    const timestamp = now();
    const issue = this.options.database.insertIssue({
      issueId: id("issue"),
      packageId,
      component: optionalText(input.component, "component", 160),
      targetRepository,
      reporterTokenHash: actor.tokenHash,
      reporterName: requiredIssueText(input.reporterName ?? "WuxianPi 用户", "reporterName", 120),
      source: input.source === "market" ? "market" : "assistant",
      confirmation: "assistant_asserted",
      title: requiredIssueText(input.title, "title", 256),
      body: requiredIssueText(input.body, "body", 24_000),
      labels: parseIssueLabels(input.labels),
      environment: parseEnvironment(input.environment),
      visibility: input.visibility === "maintainers" ? "maintainers" : "public",
      status: "pending",
      fixReleaseId: null,
      githubUrl: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    this.options.database.addAudit({
      id: id("audit"), actor: `reporter:${actor.tokenHash.slice(0, 12)}`, action: "create",
      targetType: "support_issue", targetId: issue.issueId,
      detail: { channel: "wuxianpi_hub", confirmation: "assistant_asserted", packageId, targetRepository }, createdAt: timestamp,
    });
    return { issue: this.publicIssue(issue), comments: [] };
  }

  listIssues(actor: IssueActor, query: URLSearchParams) {
    const packageId = query.get("packageId")?.trim() || null;
    const status = query.get("status")?.trim() || null;
    if (status && !ISSUE_STATUSES.has(status as IssueStatus)) throw new HubError(400, "invalid_issue_status", "Unknown Issue status");
    const q = query.get("q")?.trim() || null;
    const offset = cursorOffset(query.get("cursor"));
    const limit = pageLimit(query.get("limit"));
    const access = this.issueAccess(actor);
    const filters = { packageId, status, q, ...access };
    const count = this.options.database.countIssues(filters);
    return {
      issues: this.options.database.listIssues({ ...filters, offset, limit }).map((issue) => this.publicIssue(issue)),
      nextCursor: nextCursor(offset, limit, count),
    };
  }

  getIssue(actor: IssueActor, idOrNumber: string) {
    const issue = this.requireIssue(idOrNumber);
    this.requireIssueAccess(actor, issue);
    return { issue: this.publicIssue(issue), comments: this.options.database.listIssueComments(issue.issueId) };
  }

  commentIssue(actor: IssueActor, idOrNumber: string, body: unknown) {
    if (actor.kind === "anonymous") throw new HubError(401, "issue_auth_required", "A reporter, publisher, or administrator token is required");
    const issue = this.requireIssue(idOrNumber);
    this.requireIssueAccess(actor, issue);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new HubError(400, "invalid_request", "A JSON object is required");
    const input = body as Record<string, unknown>;
    const timestamp = now();
    const identity = this.issueActorIdentity(actor, issue, input.actorName);
    const comment = {
      commentId: id("comment"), issueId: issue.issueId, ...identity,
      body: requiredIssueText(input.body, "body", 12_000), createdAt: timestamp,
    };
    this.options.database.insertIssueComment(comment);
    this.options.database.updateIssue(issue.issueId, { updatedAt: timestamp });
    return { comment };
  }

  updateIssueStatus(actor: IssueActor, idOrNumber: string, body: unknown) {
    const issue = this.requireIssue(idOrNumber);
    this.requireMaintainer(actor, issue);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new HubError(400, "invalid_request", "A JSON object is required");
    const input = body as Record<string, unknown>;
    const status = requiredIssueText(input.status, "status", 64) as IssueStatus;
    if (!ISSUE_STATUSES.has(status)) throw new HubError(400, "invalid_issue_status", "Unknown Issue status");
    if (status === "migrated" && !issue.githubUrl && !input.githubUrl) throw new HubError(400, "github_url_required", "A GitHub Issue URL is required before migration");
    const fixReleaseId = Object.hasOwn(input, "fixReleaseId")
      ? optionalText(input.fixReleaseId, "fixReleaseId", 160)
      : issue.fixReleaseId;
    if (fixReleaseId) {
      const release = this.options.database.getRelease(fixReleaseId);
      if (!release || release.packageId !== issue.packageId) throw new HubError(400, "invalid_fix_release", "fixReleaseId must belong to the Issue Package");
    }
    const githubUrl = this.parseGithubIssueUrl(input.githubUrl) ?? issue.githubUrl;
    const timestamp = now();
    this.options.database.updateIssue(issue.issueId, { status, fixReleaseId, githubUrl, updatedAt: timestamp });
    this.recordIssueAction(actor, "status", issue.issueId, { status, fixReleaseId, githubUrl }, timestamp);
    return this.getIssue(actor, issue.issueId);
  }

  linkIssueToGithub(actor: IssueActor, idOrNumber: string, body: unknown) {
    const issue = this.requireIssue(idOrNumber);
    this.requireMaintainer(actor, issue);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new HubError(400, "invalid_request", "A JSON object is required");
    const githubUrl = this.parseGithubIssueUrl((body as Record<string, unknown>).url);
    if (!githubUrl) throw new HubError(400, "github_url_required", "url must be a GitHub Issue URL");
    const timestamp = now();
    this.options.database.updateIssue(issue.issueId, { githubUrl, status: "migrated", updatedAt: timestamp });
    this.recordIssueAction(actor, "migrate", issue.issueId, { githubUrl }, timestamp);
    return this.getIssue(actor, issue.issueId);
  }

  verifyIssue(actor: IssueActor, idOrNumber: string, body: unknown) {
    const issue = this.requireIssue(idOrNumber);
    if (actor.kind !== "reporter" || actor.tokenHash !== issue.reporterTokenHash) {
      throw new HubError(403, "reporter_access_required", "Only the original reporter can verify this Issue");
    }
    if (!body || typeof body !== "object" || Array.isArray(body) || typeof (body as Record<string, unknown>).accepted !== "boolean") {
      throw new HubError(400, "invalid_request", "accepted must be a boolean");
    }
    const accepted = (body as Record<string, boolean>).accepted;
    const status: IssueStatus = accepted ? "resolved" : "in_progress";
    const timestamp = now();
    this.options.database.updateIssue(issue.issueId, { status, updatedAt: timestamp });
    this.recordIssueAction(actor, "verify", issue.issueId, { accepted }, timestamp);
    return this.getIssue(actor, issue.issueId);
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

  private issueAccess(actor: IssueActor) {
    if (actor.kind === "admin") return { reporterTokenHash: null, maintainerPackageIds: [], includeAll: true };
    if (actor.kind === "publisher") return {
      reporterTokenHash: null,
      maintainerPackageIds: this.options.database.listPackageIdsByPublisher(actor.id),
      includeAll: false,
    };
    return {
      reporterTokenHash: actor.kind === "reporter" ? actor.tokenHash : null,
      maintainerPackageIds: [],
      includeAll: false,
    };
  }

  private publicIssue(issue: SupportIssueRecord) {
    const { reporterTokenHash: _reporterTokenHash, ...record } = issue;
    return { ...record, url: `${this.options.publicUrl}/issues/${issue.issueNumber}` };
  }

  private requireIssue(idOrNumber: string) {
    const issue = this.options.database.getIssue(idOrNumber);
    if (!issue) throw new HubError(404, "issue_not_found", "The requested Issue does not exist");
    return issue;
  }

  private requireIssueAccess(actor: IssueActor, issue: SupportIssueRecord): void {
    if (issue.visibility === "public" || actor.kind === "admin") return;
    if (actor.kind === "reporter" && actor.tokenHash === issue.reporterTokenHash) return;
    if (actor.kind === "publisher" && issue.packageId && this.options.database.getPackageRow(issue.packageId)?.publisherId === actor.id) return;
    throw new HubError(404, "issue_not_found", "The requested Issue does not exist");
  }

  private requireMaintainer(actor: IssueActor, issue: SupportIssueRecord): void {
    if (actor.kind === "admin") return;
    if (actor.kind === "publisher" && issue.packageId && this.options.database.getPackageRow(issue.packageId)?.publisherId === actor.id) return;
    throw new HubError(403, "issue_maintainer_required", "Package maintainer access is required");
  }

  private issueActorIdentity(actor: Exclude<IssueActor, { kind: "anonymous" }>, issue: SupportIssueRecord, requestedName: unknown) {
    if (actor.kind === "publisher") return { actorType: "publisher" as const, actorId: actor.id, actorName: actor.name };
    if (actor.kind === "admin") return { actorType: "admin" as const, actorId: actor.id, actorName: actor.name };
    return {
      actorType: "reporter" as const,
      actorId: actor.tokenHash,
      actorName: actor.tokenHash === issue.reporterTokenHash
        ? issue.reporterName
        : optionalText(requestedName, "actorName", 120) ?? "WuxianPi 用户",
    };
  }

  private parseGithubIssueUrl(value: unknown): string | null {
    const raw = optionalText(value, "githubUrl", 500);
    if (!raw) return null;
    let url: URL;
    try { url = new URL(raw); }
    catch { throw new HubError(400, "invalid_github_url", "githubUrl must point to a GitHub Issue"); }
    if (url.protocol !== "https:" || url.hostname !== "github.com" || !/^\/[^/]+\/[^/]+\/issues\/\d+$/.test(url.pathname)) {
      throw new HubError(400, "invalid_github_url", "githubUrl must point to a GitHub Issue");
    }
    url.search = "";
    url.hash = "";
    return url.toString();
  }

  private recordIssueAction(actor: IssueActor, action: string, issueId: string, detail: unknown, createdAt: string): void {
    const actorId = actor.kind === "reporter" ? `reporter:${actor.tokenHash.slice(0, 12)}`
      : actor.kind === "anonymous" ? "anonymous" : `${actor.kind}:${actor.id}`;
    this.options.database.addAudit({ id: id("audit"), actor: actorId, action, targetType: "support_issue", targetId: issueId, detail, createdAt });
  }

  private submissionGovernanceView(record: SubmissionRecord) {
    return {
      ...publicSubmission(record),
      reviews: this.options.database.listSubmissionReviews(record.submissionId),
      revisions: this.options.database.listSubmissionRevisions(record.submissionId)
        .map((revision) => publicSubmission(revision)),
      proposal: this.options.database.getContributionProposalBySubmission(record.submissionId),
    };
  }

  private proposalView(proposal: ContributionProposal) {
    const submission = this.requireSubmission(proposal.submissionId);
    return {
      ...proposal,
      submission: publicSubmission(submission),
      reviews: this.options.database.listSubmissionReviews(proposal.submissionId),
    };
  }

  private parseReviewDetail(body: unknown): {
    expectedRevision: number;
    reasonCodes: string[];
    message: string;
    proposedPatch: Record<string, unknown> | null;
  } {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new HubError(400, "invalid_request", "A JSON object is required");
    }
    const input = body as Record<string, unknown>;
    return {
      expectedRevision: parseExpectedRevision(input.expectedRevision),
      reasonCodes: parseReasonCodes(input.reasonCodes),
      message: requiredText(input.message, "message", 12_000),
      proposedPatch: parseProposedPatch(input.proposedPatch),
    };
  }

  private createReview(
    submission: SubmissionRecord,
    reviewerId: string,
    reviewerName: string,
    decision: SubmissionReview["decision"],
    detail: { reasonCodes: string[]; message: string; proposedPatch: Record<string, unknown> | null },
    createdAt: string,
  ): SubmissionReview {
    return {
      reviewId: id("review"),
      submissionId: submission.submissionId,
      revision: submission.revision,
      reviewerId,
      reviewerName,
      decision,
      reasonCodes: detail.reasonCodes,
      message: detail.message,
      proposedPatch: detail.proposedPatch,
      createdAt,
    };
  }

  private requirePackage(packageId: string) {
    const record = this.options.database.getPackageRow(packageId);
    if (!record) throw new HubError(404, "package_not_found", "The requested Package does not exist");
    return record;
  }

  private requirePackageManager(actor: HubUser, packageId: string): PackageRole {
    if (actor.role === "admin") return "owner";
    const role = this.options.database.getPackageRole(packageId, actor.userId);
    if (role !== "owner" && role !== "maintainer") {
      throw new HubError(403, "package_maintainer_required", "Package owner or maintainer access is required");
    }
    return role;
  }

  private ownerCount(packageId: string): number {
    return this.options.database.listPackageMembers(packageId)
      .filter((member) => member.role === "owner").length;
  }

  private requireProposal(proposalId: string): ContributionProposal {
    const proposal = this.options.database.getContributionProposal(proposalId);
    if (!proposal) throw new HubError(404, "proposal_not_found", "The requested proposal does not exist");
    return proposal;
  }

  private requireSubmission(id: string): SubmissionRecord {
    const record = this.options.database.getSubmission(id);
    if (!record) throw new HubError(404, "submission_not_found", "The requested submission does not exist");
    return record;
  }

  private requireSubmissionAtRevision(submissionId: string, expectedRevision: number): SubmissionRecord {
    const record = this.requireSubmission(submissionId);
    if (record.revision !== expectedRevision) {
      throw new HubError(409, "submission_revision_stale", "The submission changed after the owner loaded it");
    }
    return record;
  }
}
