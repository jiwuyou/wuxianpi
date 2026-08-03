import assert from "node:assert/strict";
import { test } from "node:test";
import { HubDatabase } from "../src/database.js";
import { HubError } from "../src/errors.js";
import type { GitGateway } from "../src/git.js";
import { HubService } from "../src/service.js";
import type { PackageValidator } from "../src/validator.js";
import type {
  ContributionProposal,
  HubUser,
  PackageManifest,
  ReleaseRecord,
  SubmissionRecord,
} from "../src/types.js";

const COMMIT_A = "1111111111111111111111111111111111111111";
const COMMIT_B = "2222222222222222222222222222222222222222";
const TIME_A = "2026-08-03T00:00:00.000Z";
const TIME_B = "2026-08-03T00:01:00.000Z";

const metadata = { links: [], screenshots: [] };

function manifest(version: string): PackageManifest {
  return {
    schemaVersion: 1,
    id: "io.wuxianpi.governance",
    name: "Governance Fixture",
    version,
    summary: "Governance fixture Package.",
    categories: ["solution"],
    requires: { hostCapabilities: [], packages: [] },
    build: { mode: "none" },
    artifacts: [],
    contributions: [],
  };
}

function submission(overrides: Partial<SubmissionRecord> = {}): SubmissionRecord {
  return {
    submissionId: "sub_fixture",
    publisherId: "pub_fixture",
    repositoryUrl: "https://github.com/example/governance.git",
    requestedRef: COMMIT_A,
    resolvedCommit: COMMIT_A,
    mirrorUrls: [],
    metadata,
    status: "awaiting_review",
    diagnostics: [],
    verification: { status: "passed", verifiedAt: TIME_A, checks: ["fixture"] },
    manifest: manifest("1.0.0"),
    manifestDigest: "a".repeat(64),
    sourceHealth: [],
    revision: 1,
    verifiedRevision: 1,
    createdAt: TIME_A,
    updatedAt: TIME_A,
    ...overrides,
  };
}

function release(record: SubmissionRecord, publisherId = record.publisherId): ReleaseRecord {
  return {
    releaseId: `rel_${record.revision}_${record.resolvedCommit}`,
    packageId: record.manifest!.id,
    submissionId: record.submissionId,
    publisherId,
    version: record.manifest!.version,
    approvedCommit: record.resolvedCommit!,
    submittedRef: record.requestedRef,
    repositoryUrl: record.repositoryUrl,
    mirrorUrls: record.mirrorUrls,
    manifestPath: "wuxianpi-package.json",
    manifestDigest: record.manifestDigest!,
    manifest: record.manifest!,
    metadata: record.metadata,
    verification: record.verification!,
    status: "approved",
    publishedAt: TIME_B,
    revocation: null,
    attribution: null,
  };
}

function user(db: HubDatabase, githubId: string, login: string): HubUser {
  return db.upsertUser({
    githubId,
    login,
    name: login,
    avatarUrl: null,
    profileUrl: `https://github.com/${login}`,
  }, TIME_A);
}

function service(db: HubDatabase): HubService {
  const git = {
    async resolveRef(_repositoryUrl: string, ref: string) { return ref; },
  } as GitGateway;
  return new HubService({
    database: db,
    git,
    validator: {} as PackageValidator,
    publicUrl: "https://hub.test",
  });
}

function publishInitialPackage(db: HubDatabase, owner: HubUser): void {
  const record = submission({ submissionId: "sub_initial", publisherId: owner.userId });
  db.insertSubmission(record);
  assert.equal(db.approveSubmission(release(record), {
    revision: record.revision,
    manifestDigest: record.manifestDigest!,
    metadata: record.metadata,
  }), true);
}

test("submission updates preserve immutable revision snapshots", () => {
  const db = new HubDatabase(":memory:");
  db.upsertPublisher({ id: "pub_fixture", name: "Fixture", profileUrl: null }, TIME_A);
  const original = submission({ status: "changes_requested" });
  db.insertSubmission(original);

  assert.equal(db.updateSubmissionIf(original.submissionId, 1, "changes_requested", {
    requestedRef: COMMIT_B,
    resolvedCommit: COMMIT_B,
    status: "queued",
    revision: 2,
    verifiedRevision: null,
    diagnostics: [],
    verification: null,
    manifest: null,
    manifestDigest: null,
    sourceHealth: [],
    updatedAt: TIME_B,
  }), true);

  const revisions = db.listSubmissionRevisions(original.submissionId);
  assert.deepEqual(revisions.map((item) => item.revision), [2, 1]);
  assert.equal(revisions[0]!.requestedRef, COMMIT_B);
  assert.equal(revisions[1]!.requestedRef, COMMIT_A);
  assert.equal(revisions[1]!.status, "changes_requested");
  db.close();
});

test("structured change requests store proposed patches without applying them", () => {
  const db = new HubDatabase(":memory:");
  db.upsertPublisher({ id: "pub_fixture", name: "Fixture", profileUrl: null }, TIME_A);
  const record = submission();
  db.insertSubmission(record);

  service(db).requestSubmissionChanges(record.submissionId, {
    userId: "reviewer_1",
    name: "Reviewer",
  }, {
    reasonCodes: ["manifest.summary"],
    message: "请明确说明用途。",
    proposedPatch: { metadata: { links: [{ id: "docs" }] } },
  });

  const updated = db.getSubmission(record.submissionId)!;
  const reviews = db.listSubmissionReviews(record.submissionId);
  assert.equal(updated.status, "changes_requested");
  assert.deepEqual(updated.metadata, metadata);
  assert.deepEqual(reviews[0]!.reasonCodes, ["manifest.summary"]);
  assert.deepEqual(reviews[0]!.proposedPatch, { metadata: { links: [{ id: "docs" }] } });
  db.close();
});

test("reviewer approval requires the caller's expected submission revision", async () => {
  const db = new HubDatabase(":memory:");
  db.upsertPublisher({ id: "pub_fixture", name: "Fixture", profileUrl: null }, TIME_A);
  const reviewer = user(db, "3001", "reviewer");
  db.updateUserRole(reviewer.userId, "reviewer", TIME_A);
  const record = submission({ submissionId: "sub_revision_gate" });
  db.insertSubmission(record);
  const hub = service(db);

  await assert.rejects(
    hub.reviewSubmission(record.submissionId, { ...reviewer, role: "reviewer" }, {
      decision: "approved",
      message: "Approved",
    }),
    (error: unknown) => error instanceof HubError && error.code === "revision_required",
  );

  assert.equal(db.updateSubmissionIf(record.submissionId, 1, "awaiting_review", {
    revision: 2,
    verifiedRevision: 2,
    updatedAt: TIME_B,
  }), true);
  await assert.rejects(
    hub.reviewSubmission(record.submissionId, { ...reviewer, role: "reviewer" }, {
      decision: "approved",
      expectedRevision: 1,
      message: "Stale approval",
    }),
    (error: unknown) => error instanceof HubError && error.code === "submission_revision_stale",
  );
  assert.equal(db.getLatestRelease("io.wuxianpi.governance"), null);

  const approved = await hub.reviewSubmission(record.submissionId, { ...reviewer, role: "reviewer" }, {
    decision: "approved",
    expectedRevision: 2,
    message: "Approved current revision",
  });
  assert.equal(approved.decision, "approved");
  db.close();
});

test("reviewer change requests and rejections reject stale revisions", async () => {
  const db = new HubDatabase(":memory:");
  db.upsertPublisher({ id: "pub_fixture", name: "Fixture", profileUrl: null }, TIME_A);
  const reviewer = user(db, "3011", "reviewer");
  db.updateUserRole(reviewer.userId, "reviewer", TIME_A);
  const record = submission({ submissionId: "sub_review_action_revision" });
  db.insertSubmission(record);
  const hub = service(db);
  assert.equal(db.updateSubmissionIf(record.submissionId, 1, "awaiting_review", {
    revision: 2,
    verifiedRevision: 2,
    updatedAt: TIME_B,
  }), true);

  for (const decision of ["changes_requested", "rejected"] as const) {
    await assert.rejects(
      hub.reviewSubmission(record.submissionId, { ...reviewer, role: "reviewer" }, {
        decision,
        expectedRevision: 1,
        message: "Stale review action",
      }),
      (error: unknown) => error instanceof HubError && error.code === "submission_revision_stale",
    );
  }
  assert.equal(db.listSubmissionReviews(record.submissionId).length, 0);
  db.close();
});

test("proposal publication requires owner acceptance and preserves contributor attribution", async () => {
  const db = new HubDatabase(":memory:");
  const owner = user(db, "1001", "owner");
  const contributor = user(db, "1002", "contributor");
  publishInitialPackage(db, owner);
  assert.equal(db.getPackageRole("io.wuxianpi.governance", owner.userId), "owner");

  const contribution = submission({
    submissionId: "sub_contribution",
    publisherId: contributor.userId,
    requestedRef: COMMIT_B,
    resolvedCommit: COMMIT_B,
    manifest: manifest("2.0.0"),
    manifestDigest: "b".repeat(64),
  });
  db.insertSubmission(contribution);
  const proposal: ContributionProposal = {
    proposalId: "proposal_fixture",
    packageId: "io.wuxianpi.governance",
    submissionId: contribution.submissionId,
    contributorId: contributor.userId,
    contributorName: contributor.name,
    status: "awaiting_owner",
    title: "Update fixture",
    summary: "Contributed update.",
    acceptedBy: null,
    acceptedAt: null,
    rejectionReason: null,
    createdAt: TIME_A,
    updatedAt: TIME_A,
  };
  db.insertContributionProposal(proposal);
  const hub = service(db);

  const beforeInvalidUpdate = db.getSubmission(contribution.submissionId)!;
  await assert.rejects(
    hub.updateContributionProposal(contributor.userId, proposal.proposalId, { title: "" }),
    (error: unknown) => error instanceof HubError && error.code === "invalid_request",
  );
  await assert.rejects(
    hub.updateContributionProposal(contributor.userId, proposal.proposalId, { summary: "" }),
    (error: unknown) => error instanceof HubError && error.code === "invalid_request",
  );
  assert.equal(db.getSubmission(contribution.submissionId)!.revision, beforeInvalidUpdate.revision);
  assert.equal(db.getContributionProposal(proposal.proposalId)!.title, proposal.title);

  await assert.rejects(
    hub.approveSubmission(contribution.submissionId, "Looks good", "reviewer_1"),
    (error: unknown) => error instanceof HubError && error.code === "proposal_owner_acceptance_required",
  );

  const accepted = hub.acceptContributionProposal(owner, proposal.proposalId, contribution.revision);
  assert.equal(accepted.status, "accepted");
  assert.deepEqual(db.getContributionProposalAcceptance(proposal.proposalId), {
    revision: contribution.revision,
    commit: COMMIT_B,
  });
  assert.equal(db.updateSubmissionIf(contribution.submissionId, 1, "awaiting_review", {
    revision: 2,
    verifiedRevision: 2,
    updatedAt: TIME_B,
  }), true);
  assert.equal(db.getContributionProposal(proposal.proposalId)!.status, "queued");
  assert.equal(db.getContributionProposalAcceptance(proposal.proposalId), null);
  assert.throws(
    () => hub.acceptContributionProposal(owner, proposal.proposalId, 1),
    (error: unknown) => error instanceof HubError && error.code === "submission_revision_stale",
  );
  assert.throws(
    () => hub.requestContributionProposalChanges(owner, proposal.proposalId, {
      expectedRevision: 1,
      message: "Stale owner request",
    }),
    (error: unknown) => error instanceof HubError && error.code === "submission_revision_stale",
  );
  assert.throws(
    () => hub.rejectContributionProposal(owner, proposal.proposalId, {
      expectedRevision: 1,
      message: "Stale owner rejection",
    }),
    (error: unknown) => error instanceof HubError && error.code === "submission_revision_stale",
  );
  await assert.rejects(
    hub.approveSubmission(contribution.submissionId, "Stale acceptance", "reviewer_1"),
    (error: unknown) => error instanceof HubError && error.code === "proposal_owner_acceptance_required",
  );
  assert.equal(db.updateContributionProposalBySubmission(
    contribution.submissionId, ["queued"], { status: "awaiting_owner", updatedAt: TIME_B },
  ), true);
  const reaccepted = hub.acceptContributionProposal(owner, proposal.proposalId, 2);
  assert.equal(reaccepted.status, "accepted");
  const published = await hub.approveSubmission(contribution.submissionId, "Looks good", "reviewer_1");
  const approvedRelease = db.getRelease(published.releaseId)!;
  assert.equal(approvedRelease.publisherId, owner.userId);
  assert.deepEqual(approvedRelease.attribution, {
    proposalId: proposal.proposalId,
    contributorId: contributor.userId,
    contributorName: contributor.name,
    repositoryUrl: contribution.repositoryUrl,
    approvedCommit: COMMIT_B,
  });
  assert.equal(db.getContributionProposal(proposal.proposalId)!.status, "released");
  assert.deepEqual(
    db.listSubmissionReviews(contribution.submissionId).map((review) => review.decision),
    ["approved", "accepted", "accepted"],
  );
  db.close();
});

test("Package membership enforces owner and maintainer boundaries", () => {
  const db = new HubDatabase(":memory:");
  const owner = user(db, "2001", "owner-two");
  const maintainer = user(db, "2002", "maintainer");
  const contributor = user(db, "2003", "contributor-two");
  publishInitialPackage(db, owner);
  const hub = service(db);

  assert.equal(hub.upsertPackageMember(
    owner, "io.wuxianpi.governance", maintainer.userId, "maintainer",
  ).role, "maintainer");
  assert.equal(hub.upsertPackageMember(
    maintainer, "io.wuxianpi.governance", contributor.userId, "contributor",
  ).role, "contributor");
  assert.deepEqual(db.listPackageIdsByMember(maintainer.userId, ["maintainer"]), ["io.wuxianpi.governance"]);
  assert.throws(
    () => hub.upsertPackageMember(
      maintainer, "io.wuxianpi.governance", contributor.userId, "owner",
    ),
    (error: unknown) => error instanceof HubError && error.code === "package_owner_required",
  );
  assert.throws(
    () => hub.removePackageMember(owner, "io.wuxianpi.governance", owner.userId),
    (error: unknown) => error instanceof HubError && error.code === "last_owner",
  );
  db.close();
});

test("invalid contribution proposal fields do not create submissions or enqueue work", async () => {
  const db = new HubDatabase(":memory:");
  const owner = user(db, "4001", "owner-four");
  const contributor = user(db, "4002", "contributor-four");
  publishInitialPackage(db, owner);
  const hub = service(db);
  const beforeSubmissions = Number((db.sqlite.prepare("SELECT COUNT(*) AS count FROM submissions").get() as { count: number }).count);
  const beforeProposals = Number((db.sqlite.prepare("SELECT COUNT(*) AS count FROM contribution_proposals").get() as { count: number }).count);

  await assert.rejects(
    hub.createContributionProposal(contributor, "io.wuxianpi.governance", {
      repositoryUrl: "https://github.com/example/governance.git",
      ref: COMMIT_A,
      mirrorUrls: [],
      metadata,
      title: "",
      summary: "Valid summary",
    }),
    (error: unknown) => error instanceof HubError && error.code === "invalid_request",
  );
  assert.equal(Number((db.sqlite.prepare("SELECT COUNT(*) AS count FROM submissions").get() as { count: number }).count), beforeSubmissions);
  assert.equal(Number((db.sqlite.prepare("SELECT COUNT(*) AS count FROM contribution_proposals").get() as { count: number }).count), beforeProposals);
  db.close();
});
