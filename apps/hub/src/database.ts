import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  ContributionProposal,
  GlobalRole,
  HubSession,
  HubUser,
  PackageMember,
  PackageManifest,
  PackagePresentationMetadata,
  PackageRole,
  ProposalStatus,
  PublisherIdentity,
  ReleaseRecord,
  SubmissionReview,
  SupportIssueComment,
  SupportIssueRecord,
  SourceHealth,
  SubmissionRecord,
  SubmissionStatus,
  VerificationResult,
} from "./types.js";

type SqlValue = string | number | bigint | null | Uint8Array;

interface SubmissionRow {
  submission_id: string;
  publisher_id: string;
  repository_url: string;
  requested_ref: string;
  resolved_commit: string | null;
  mirror_urls: string;
  metadata: string;
  status: string;
  diagnostics: string;
  verification: string | null;
  manifest: string | null;
  manifest_digest: string | null;
  source_health: string;
  revision: number;
  verified_revision: number | null;
  created_at: string;
  updated_at: string;
}

interface ReleaseRow {
  release_id: string;
  package_id: string;
  submission_id: string;
  publisher_id: string;
  version: string;
  approved_commit: string;
  submitted_ref: string;
  repository_url: string;
  mirror_urls: string;
  manifest_path: string;
  manifest_digest: string;
  manifest: string;
  metadata: string;
  verification: string;
  status: string;
  published_at: string;
  revocation: string | null;
  attribution: string | null;
}

interface UserRow {
  user_id: string;
  github_id: string;
  login: string;
  name: string;
  avatar_url: string | null;
  profile_url: string;
  role: string;
  created_at: string;
  updated_at: string;
}

interface SessionRow {
  session_id: string;
  user_id: string;
  kind: string;
  label: string;
  created_at: string;
  last_used_at: string;
  expires_at: string;
  revoked_at: string | null;
}

interface PackageMemberRow extends UserRow {
  package_id: string;
  member_user_id: string;
  package_role: string;
  member_created_at: string;
  member_updated_at: string;
}

interface SubmissionReviewRow {
  review_id: string;
  submission_id: string;
  revision: number;
  reviewer_id: string;
  reviewer_name: string;
  decision: string;
  reason_codes: string;
  message: string;
  proposed_patch: string | null;
  created_at: string;
}

interface ContributionProposalRow {
  proposal_id: string;
  package_id: string;
  submission_id: string;
  contributor_id: string;
  contributor_name: string;
  status: string;
  title: string;
  summary: string;
  accepted_by: string | null;
  accepted_at: string | null;
  accepted_revision: number | null;
  accepted_commit: string | null;
  rejection_reason: string | null;
  created_at: string;
  updated_at: string;
}

interface IssueRow {
  issue_id: string;
  issue_number: number;
  package_id: string | null;
  component: string | null;
  target_repository: string | null;
  reporter_token_hash: string;
  reporter_name: string;
  source: string;
  confirmation: string;
  title: string;
  body: string;
  labels: string;
  environment: string;
  visibility: string;
  status: string;
  fix_release_id: string | null;
  github_url: string | null;
  created_at: string;
  updated_at: string;
}

interface IssueCommentRow {
  comment_id: string;
  issue_id: string;
  actor_type: string;
  actor_id: string;
  actor_name: string;
  body: string;
  created_at: string;
}

const json = (value: unknown) => JSON.stringify(value);
const parse = <T>(value: string): T => JSON.parse(value) as T;

type SubmissionChanges = Partial<{
  requestedRef: string;
  resolvedCommit: string | null;
  mirrorUrls: string[];
  metadata: PackagePresentationMetadata;
  status: SubmissionStatus;
  diagnostics: string[];
  verification: VerificationResult | null;
  manifest: PackageManifest | null;
  manifestDigest: string | null;
  sourceHealth: SourceHealth[];
  revision: number;
  verifiedRevision: number | null;
  updatedAt: string;
}>;

type ProposalChanges = Partial<Pick<
  ContributionProposal,
  "status" | "title" | "summary" | "acceptedBy" | "acceptedAt" | "rejectionReason" | "updatedAt"
>>;

interface IssueListFilters {
  packageId: string | null;
  status: string | null;
  q: string | null;
  reporterTokenHash: string | null;
  maintainerPackageIds: string[];
  includeAll: boolean;
  offset: number;
  limit: number;
}

export class HubDatabase {
  readonly sqlite: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.sqlite = new DatabaseSync(path);
    this.sqlite.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  close(): void {
    this.sqlite.close();
  }

  private migrate(): void {
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS publishers (
        publisher_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        profile_url TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS submissions (
        submission_id TEXT PRIMARY KEY,
        publisher_id TEXT NOT NULL REFERENCES publishers(publisher_id),
        repository_url TEXT NOT NULL,
        requested_ref TEXT NOT NULL,
        resolved_commit TEXT,
        mirror_urls TEXT NOT NULL,
        metadata TEXT NOT NULL,
        status TEXT NOT NULL,
        diagnostics TEXT NOT NULL,
        verification TEXT,
        manifest TEXT,
        manifest_digest TEXT,
        source_health TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        verified_revision INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS packages (
        package_id TEXT PRIMARY KEY,
        publisher_id TEXT NOT NULL REFERENCES publishers(publisher_id),
        name TEXT NOT NULL,
        summary TEXT NOT NULL,
        description TEXT,
        license TEXT,
        categories TEXT NOT NULL,
        contribution_types TEXT NOT NULL,
        latest_release_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS releases (
        release_id TEXT PRIMARY KEY,
        package_id TEXT NOT NULL REFERENCES packages(package_id),
        submission_id TEXT NOT NULL UNIQUE REFERENCES submissions(submission_id),
        publisher_id TEXT NOT NULL REFERENCES publishers(publisher_id),
        version TEXT NOT NULL,
        approved_commit TEXT NOT NULL,
        submitted_ref TEXT NOT NULL,
        repository_url TEXT NOT NULL,
        mirror_urls TEXT NOT NULL,
        manifest_path TEXT NOT NULL,
        manifest_digest TEXT NOT NULL,
        manifest TEXT NOT NULL,
        metadata TEXT NOT NULL,
        verification TEXT NOT NULL,
        status TEXT NOT NULL,
        published_at TEXT NOT NULL,
        revocation TEXT,
        attribution TEXT,
        UNIQUE(package_id, approved_commit)
      );

      CREATE TABLE IF NOT EXISTS source_health (
        url TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        checked_at TEXT NOT NULL,
        commit_hash TEXT,
        error TEXT
      );

      CREATE TABLE IF NOT EXISTS audit_events (
        event_id TEXT PRIMARY KEY,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        detail TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS support_issues (
        issue_number INTEGER PRIMARY KEY AUTOINCREMENT,
        issue_id TEXT NOT NULL UNIQUE,
        package_id TEXT,
        component TEXT,
        target_repository TEXT,
        reporter_token_hash TEXT NOT NULL,
        reporter_name TEXT NOT NULL,
        source TEXT NOT NULL,
        confirmation TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        labels TEXT NOT NULL,
        environment TEXT NOT NULL,
        visibility TEXT NOT NULL,
        status TEXT NOT NULL,
        fix_release_id TEXT,
        github_url TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS support_issue_comments (
        comment_id TEXT PRIMARY KEY,
        issue_id TEXT NOT NULL REFERENCES support_issues(issue_id) ON DELETE CASCADE,
        actor_type TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        actor_name TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS users (
        user_id TEXT PRIMARY KEY,
        github_id TEXT NOT NULL UNIQUE,
        login TEXT NOT NULL,
        name TEXT NOT NULL,
        avatar_url TEXT,
        profile_url TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        label TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        last_used_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT
      );

      CREATE TABLE IF NOT EXISTS package_members (
        package_id TEXT NOT NULL REFERENCES packages(package_id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(package_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS submission_revisions (
        submission_id TEXT NOT NULL REFERENCES submissions(submission_id) ON DELETE CASCADE,
        revision INTEGER NOT NULL,
        snapshot TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(submission_id, revision)
      );

      CREATE TABLE IF NOT EXISTS submission_reviews (
        review_id TEXT PRIMARY KEY,
        submission_id TEXT NOT NULL REFERENCES submissions(submission_id) ON DELETE CASCADE,
        revision INTEGER NOT NULL,
        reviewer_id TEXT NOT NULL,
        reviewer_name TEXT NOT NULL,
        decision TEXT NOT NULL,
        reason_codes TEXT NOT NULL,
        message TEXT NOT NULL,
        proposed_patch TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS contribution_proposals (
        proposal_id TEXT PRIMARY KEY,
        package_id TEXT NOT NULL REFERENCES packages(package_id) ON DELETE CASCADE,
        submission_id TEXT NOT NULL UNIQUE REFERENCES submissions(submission_id) ON DELETE CASCADE,
        contributor_id TEXT NOT NULL REFERENCES users(user_id),
        contributor_name TEXT NOT NULL,
        status TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        accepted_by TEXT REFERENCES users(user_id),
        accepted_at TEXT,
        accepted_revision INTEGER,
        accepted_commit TEXT,
        rejection_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_packages_updated ON packages(updated_at DESC, package_id);
      CREATE INDEX IF NOT EXISTS idx_releases_package ON releases(package_id, published_at DESC);
      CREATE INDEX IF NOT EXISTS idx_submissions_publisher ON submissions(publisher_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_support_issues_package ON support_issues(package_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_support_issues_status ON support_issues(status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_support_issues_reporter ON support_issues(reporter_token_hash, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_support_issue_comments_issue ON support_issue_comments(issue_id, created_at ASC);
      CREATE INDEX IF NOT EXISTS idx_users_login ON users(login COLLATE NOCASE);
      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token_hash);
      CREATE INDEX IF NOT EXISTS idx_package_members_user ON package_members(user_id, package_id);
      CREATE INDEX IF NOT EXISTS idx_submission_reviews_submission ON submission_reviews(submission_id, revision DESC, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_contribution_proposals_package ON contribution_proposals(package_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_contribution_proposals_contributor ON contribution_proposals(contributor_id, updated_at DESC);
    `);
    const columns = new Set((this.sqlite.prepare("PRAGMA table_info(submissions)").all() as unknown as Array<{ name: string }>).map((row) => row.name));
    if (!columns.has("revision")) this.sqlite.exec("ALTER TABLE submissions ADD COLUMN revision INTEGER NOT NULL DEFAULT 1");
    if (!columns.has("verified_revision")) this.sqlite.exec("ALTER TABLE submissions ADD COLUMN verified_revision INTEGER");
    const releaseColumns = new Set((this.sqlite.prepare("PRAGMA table_info(releases)").all() as unknown as Array<{ name: string }>).map((row) => row.name));
    if (!releaseColumns.has("attribution")) this.sqlite.exec("ALTER TABLE releases ADD COLUMN attribution TEXT");
    const proposalColumns = new Set((this.sqlite.prepare("PRAGMA table_info(contribution_proposals)").all() as unknown as Array<{ name: string }>).map((row) => row.name));
    if (!proposalColumns.has("accepted_revision")) this.sqlite.exec("ALTER TABLE contribution_proposals ADD COLUMN accepted_revision INTEGER");
    if (!proposalColumns.has("accepted_commit")) this.sqlite.exec("ALTER TABLE contribution_proposals ADD COLUMN accepted_commit TEXT");
    this.sqlite.exec(`
      INSERT OR IGNORE INTO submission_revisions(submission_id, revision, snapshot, created_at)
      SELECT submission_id, revision, json_object(
        'submissionId', submission_id,
        'publisherId', publisher_id,
        'repositoryUrl', repository_url,
        'requestedRef', requested_ref,
        'resolvedCommit', resolved_commit,
        'mirrorUrls', json(mirror_urls),
        'metadata', json(metadata),
        'status', status,
        'diagnostics', json(diagnostics),
        'verification', CASE WHEN verification IS NULL THEN NULL ELSE json(verification) END,
        'manifest', CASE WHEN manifest IS NULL THEN NULL ELSE json(manifest) END,
        'manifestDigest', manifest_digest,
        'sourceHealth', json(source_health),
        'revision', revision,
        'verifiedRevision', verified_revision,
        'createdAt', created_at,
        'updatedAt', updated_at
      ), created_at FROM submissions;
    `);
  }

  upsertPublisher(publisher: PublisherIdentity, now: string): void {
    this.sqlite.prepare(`
      INSERT INTO publishers(publisher_id, name, profile_url, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(publisher_id) DO UPDATE SET
        name = excluded.name,
        profile_url = excluded.profile_url,
        updated_at = excluded.updated_at
    `).run(publisher.id, publisher.name, publisher.profileUrl, now, now);
  }

  getPublisher(id: string): PublisherIdentity | null {
    const row = this.sqlite.prepare("SELECT publisher_id, name, profile_url FROM publishers WHERE publisher_id = ?")
      .get(id) as { publisher_id: string; name: string; profile_url: string | null } | undefined;
    return row ? { id: row.publisher_id, name: row.name, profileUrl: row.profile_url } : null;
  }

  upsertUser(
    identity: Pick<HubUser, "githubId" | "login" | "name" | "avatarUrl" | "profileUrl">,
    timestamp: string,
  ): HubUser {
    const existing = this.sqlite.prepare("SELECT user_id FROM users WHERE github_id = ?")
      .get(identity.githubId) as { user_id: string } | undefined;
    const userId = existing?.user_id ?? `github:${identity.githubId}`;
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      this.sqlite.prepare(`
        INSERT INTO users(user_id, github_id, login, name, avatar_url, profile_url, role, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'user', ?, ?)
        ON CONFLICT(github_id) DO UPDATE SET
          login = excluded.login,
          name = excluded.name,
          avatar_url = excluded.avatar_url,
          profile_url = excluded.profile_url,
          updated_at = excluded.updated_at
      `).run(
        userId, identity.githubId, identity.login, identity.name, identity.avatarUrl,
        identity.profileUrl, timestamp, timestamp,
      );
      this.sqlite.prepare(`
        INSERT INTO publishers(publisher_id, name, profile_url, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(publisher_id) DO UPDATE SET
          name = excluded.name,
          profile_url = excluded.profile_url,
          updated_at = excluded.updated_at
      `).run(userId, identity.name, identity.profileUrl, timestamp, timestamp);
      this.sqlite.exec("COMMIT");
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
    return this.getUser(userId)!;
  }

  getUser(userId: string): HubUser | null {
    const row = this.sqlite.prepare("SELECT * FROM users WHERE user_id = ?").get(userId) as UserRow | undefined;
    return row ? this.mapUser(row) : null;
  }

  getUserByGithubId(githubId: string): HubUser | null {
    const row = this.sqlite.prepare("SELECT * FROM users WHERE github_id = ?").get(githubId) as UserRow | undefined;
    return row ? this.mapUser(row) : null;
  }

  updateUserRole(userId: string, role: GlobalRole, timestamp: string): boolean {
    const result = this.sqlite.prepare("UPDATE users SET role = ?, updated_at = ? WHERE user_id = ?")
      .run(role, timestamp, userId);
    return Number(result.changes) === 1;
  }

  insertSession(record: HubSession & { tokenHash: string }): void;
  insertSession(record: HubSession, tokenHash: string): void;
  insertSession(record: HubSession | (HubSession & { tokenHash: string }), tokenHash?: string): void {
    const digest = tokenHash ?? (record as HubSession & { tokenHash?: string }).tokenHash;
    if (!digest) throw new Error("session_token_hash_required");
    this.sqlite.prepare(`
      INSERT INTO sessions(
        session_id, user_id, kind, label, token_hash, created_at,
        last_used_at, expires_at, revoked_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.sessionId, record.userId, record.kind, record.label, digest,
      record.createdAt, record.lastUsedAt, record.expiresAt, record.revokedAt,
    );
  }

  getSessionByTokenHash(tokenHash: string): HubSession | null {
    const row = this.sqlite.prepare("SELECT * FROM sessions WHERE token_hash = ?").get(tokenHash) as SessionRow | undefined;
    return row ? this.mapSession(row) : null;
  }

  touchSession(sessionId: string, lastUsedAt: string): boolean {
    const result = this.sqlite.prepare(`
      UPDATE sessions SET last_used_at = ? WHERE session_id = ? AND revoked_at IS NULL
    `).run(lastUsedAt, sessionId);
    return Number(result.changes) === 1;
  }

  listSessions(userId: string): HubSession[] {
    return (this.sqlite.prepare(`
      SELECT * FROM sessions WHERE user_id = ? ORDER BY created_at DESC, session_id DESC
    `).all(userId) as unknown as SessionRow[]).map((row) => this.mapSession(row));
  }

  revokeSession(sessionId: string, revokedAt: string, userId?: string): boolean {
    const result = userId
      ? this.sqlite.prepare(`
          UPDATE sessions SET revoked_at = ?
          WHERE session_id = ? AND user_id = ? AND revoked_at IS NULL
        `).run(revokedAt, sessionId, userId)
      : this.sqlite.prepare(`
          UPDATE sessions SET revoked_at = ? WHERE session_id = ? AND revoked_at IS NULL
        `).run(revokedAt, sessionId);
    return Number(result.changes) === 1;
  }

  private mapUser(row: UserRow): HubUser {
    return {
      userId: row.user_id,
      githubId: row.github_id,
      login: row.login,
      name: row.name,
      avatarUrl: row.avatar_url,
      profileUrl: row.profile_url,
      role: row.role as GlobalRole,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapSession(row: SessionRow): HubSession {
    return {
      sessionId: row.session_id,
      userId: row.user_id,
      kind: row.kind as HubSession["kind"],
      label: row.label,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
    };
  }

  insertSubmission(record: SubmissionRecord): void {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      this.sqlite.prepare(`
        INSERT INTO submissions(
          submission_id, publisher_id, repository_url, requested_ref, resolved_commit,
          mirror_urls, metadata, status, diagnostics, verification, manifest,
          manifest_digest, source_health, revision, verified_revision, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        record.submissionId,
        record.publisherId,
        record.repositoryUrl,
        record.requestedRef,
        record.resolvedCommit,
        json(record.mirrorUrls),
        json(record.metadata),
        record.status,
        json(record.diagnostics),
        record.verification ? json(record.verification) : null,
        record.manifest ? json(record.manifest) : null,
        record.manifestDigest,
        json(record.sourceHealth),
        record.revision,
        record.verifiedRevision,
        record.createdAt,
        record.updatedAt,
      );
      this.insertSubmissionRevision(record);
      this.sqlite.exec("COMMIT");
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  updateSubmission(id: string, changes: SubmissionChanges): void {
    const { assignments, values } = this.serializeSubmissionChanges(changes);
    if (assignments.length === 0) return;
    values.push(id);
    this.sqlite.prepare(`UPDATE submissions SET ${assignments.join(", ")} WHERE submission_id = ?`).run(...values);
  }

  updateSubmissionIf(id: string, revision: number, status: SubmissionStatus, changes: SubmissionChanges): boolean {
    const { assignments, values } = this.serializeSubmissionChanges(changes);
    if (assignments.length === 0) return false;
    const revisionChanged = changes.revision !== undefined && changes.revision !== revision;
    if (!revisionChanged) {
      values.push(id, revision, status);
      const result = this.sqlite.prepare(`
        UPDATE submissions SET ${assignments.join(", ")}
        WHERE submission_id = ? AND revision = ? AND status = ?
      `).run(...values);
      return Number(result.changes) === 1;
    }
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      values.push(id, revision, status);
      const result = this.sqlite.prepare(`
        UPDATE submissions SET ${assignments.join(", ")}
        WHERE submission_id = ? AND revision = ? AND status = ?
      `).run(...values);
      if (Number(result.changes) !== 1) {
        this.sqlite.exec("ROLLBACK");
        return false;
      }
      const updated = this.getSubmission(id);
      if (!updated) throw new Error("submission_missing_after_update");
      this.insertSubmissionRevision(updated);
      const proposal = this.sqlite.prepare(`
        SELECT status FROM contribution_proposals WHERE submission_id = ?
      `).get(id) as { status: ProposalStatus } | undefined;
      if (proposal && !["released", "withdrawn", "rejected"].includes(proposal.status)) {
        const reset = this.sqlite.prepare(`
          UPDATE contribution_proposals SET
            status = 'queued', accepted_by = NULL, accepted_at = NULL,
            accepted_revision = NULL, accepted_commit = NULL,
            rejection_reason = NULL, updated_at = ?
          WHERE submission_id = ? AND status = ?
        `).run(updated.updatedAt, id, proposal.status);
        if (Number(reset.changes) !== 1) throw new Error("proposal_acceptance_reset_failed");
      }
      this.sqlite.exec("COMMIT");
      return true;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  private serializeSubmissionChanges(changes: SubmissionChanges): { assignments: string[]; values: SqlValue[] } {
    const mapping: Record<string, string> = {
      requestedRef: "requested_ref",
      resolvedCommit: "resolved_commit",
      mirrorUrls: "mirror_urls",
      metadata: "metadata",
      status: "status",
      diagnostics: "diagnostics",
      verification: "verification",
      manifest: "manifest",
      manifestDigest: "manifest_digest",
      sourceHealth: "source_health",
      revision: "revision",
      verifiedRevision: "verified_revision",
      updatedAt: "updated_at",
    };
    const jsonFields = new Set(["mirrorUrls", "metadata", "diagnostics", "verification", "manifest", "sourceHealth"]);
    const entries = Object.entries(changes);
    const values: SqlValue[] = [];
    const assignments = entries.map(([key, value]) => {
      const column = mapping[key];
      if (!column) throw new Error(`Unsupported submission field ${key}`);
      values.push(jsonFields.has(key) && value !== null ? json(value) : value as SqlValue);
      return `${column} = ?`;
    });
    return { assignments, values };
  }

  getSubmission(id: string): SubmissionRecord | null {
    const row = this.sqlite.prepare("SELECT * FROM submissions WHERE submission_id = ?").get(id) as SubmissionRow | undefined;
    return row ? this.mapSubmission(row) : null;
  }

  listSubmissionRevisions(submissionId: string): SubmissionRecord[] {
    return (this.sqlite.prepare(`
      SELECT snapshot FROM submission_revisions
      WHERE submission_id = ? ORDER BY revision DESC
    `).all(submissionId) as unknown as Array<{ snapshot: string }>).map((row) => parse<SubmissionRecord>(row.snapshot));
  }

  listSubmissionsByPublisher(publisherId: string): SubmissionRecord[] {
    return (this.sqlite.prepare(`
      SELECT * FROM submissions WHERE publisher_id = ?
      ORDER BY updated_at DESC, submission_id DESC
    `).all(publisherId) as unknown as SubmissionRow[]).map((row) => this.mapSubmission(row));
  }

  listSubmissionsForReview(statuses: SubmissionStatus[] = ["awaiting_review"]): SubmissionRecord[] {
    if (statuses.length === 0) return [];
    return (this.sqlite.prepare(`
      SELECT * FROM submissions WHERE status IN (${statuses.map(() => "?").join(", ")})
      ORDER BY updated_at ASC, submission_id ASC
    `).all(...statuses) as unknown as SubmissionRow[]).map((row) => this.mapSubmission(row));
  }

  private insertSubmissionRevision(record: SubmissionRecord): void {
    this.sqlite.prepare(`
      INSERT INTO submission_revisions(submission_id, revision, snapshot, created_at)
      VALUES (?, ?, ?, ?)
    `).run(record.submissionId, record.revision, json(record), record.updatedAt);
  }

  listPendingSubmissionIds(): string[] {
    return (this.sqlite.prepare(`
      SELECT submission_id FROM submissions
      WHERE status IN ('queued', 'verifying')
      ORDER BY created_at ASC
    `).all() as unknown as Array<{ submission_id: string }>).map((row) => row.submission_id);
  }

  private mapSubmission(row: SubmissionRow): SubmissionRecord {
    return {
      submissionId: row.submission_id,
      publisherId: row.publisher_id,
      repositoryUrl: row.repository_url,
      requestedRef: row.requested_ref,
      resolvedCommit: row.resolved_commit,
      mirrorUrls: parse<string[]>(row.mirror_urls),
      metadata: parse<PackagePresentationMetadata>(row.metadata),
      status: row.status as SubmissionStatus,
      diagnostics: parse<string[]>(row.diagnostics),
      verification: row.verification ? parse<VerificationResult>(row.verification) : null,
      manifest: row.manifest ? parse<PackageManifest>(row.manifest) : null,
      manifestDigest: row.manifest_digest,
      sourceHealth: parse<SourceHealth[]>(row.source_health),
      revision: row.revision,
      verifiedRevision: row.verified_revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  insertSubmissionReview(review: SubmissionReview): void {
    this.sqlite.prepare(`
      INSERT INTO submission_reviews(
        review_id, submission_id, revision, reviewer_id, reviewer_name,
        decision, reason_codes, message, proposed_patch, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      review.reviewId, review.submissionId, review.revision, review.reviewerId,
      review.reviewerName, review.decision, json(review.reasonCodes), review.message,
      review.proposedPatch ? json(review.proposedPatch) : null, review.createdAt,
    );
  }

  recordSubmissionReview(
    review: SubmissionReview,
    expectedStatus: SubmissionStatus,
    nextStatus: SubmissionStatus,
    diagnostics: string[],
    updatedAt: string,
  ): boolean {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const updated = this.sqlite.prepare(`
        UPDATE submissions SET status = ?, diagnostics = ?, updated_at = ?
        WHERE submission_id = ? AND revision = ? AND status = ?
      `).run(nextStatus, json(diagnostics), updatedAt, review.submissionId, review.revision, expectedStatus);
      if (Number(updated.changes) !== 1) {
        this.sqlite.exec("ROLLBACK");
        return false;
      }
      this.insertSubmissionReview(review);
      if (nextStatus === "changes_requested") {
        this.sqlite.prepare(`
          UPDATE contribution_proposals SET
            status = 'changes_requested', accepted_by = NULL, accepted_at = NULL,
            accepted_revision = NULL, accepted_commit = NULL,
            rejection_reason = NULL, updated_at = ?
          WHERE submission_id = ? AND status IN ('accepted', 'awaiting_owner')
        `).run(updatedAt, review.submissionId);
      } else if (nextStatus === "rejected") {
        this.sqlite.prepare(`
          UPDATE contribution_proposals SET
            status = 'rejected', accepted_by = NULL, accepted_at = NULL,
            accepted_revision = NULL, accepted_commit = NULL,
            rejection_reason = ?, updated_at = ?
          WHERE submission_id = ? AND status <> 'released'
        `).run(review.message, updatedAt, review.submissionId);
      }
      this.sqlite.exec("COMMIT");
      return true;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  listSubmissionReviews(submissionId: string): SubmissionReview[] {
    return (this.sqlite.prepare(`
      SELECT * FROM submission_reviews WHERE submission_id = ?
      ORDER BY revision DESC, created_at DESC, review_id DESC
    `).all(submissionId) as unknown as SubmissionReviewRow[]).map((row) => ({
      reviewId: row.review_id,
      submissionId: row.submission_id,
      revision: row.revision,
      reviewerId: row.reviewer_id,
      reviewerName: row.reviewer_name,
      decision: row.decision as SubmissionReview["decision"],
      reasonCodes: parse<string[]>(row.reason_codes),
      message: row.message,
      proposedPatch: row.proposed_patch ? parse<Record<string, unknown>>(row.proposed_patch) : null,
      createdAt: row.created_at,
    }));
  }

  insertContributionProposal(proposal: ContributionProposal): void {
    this.sqlite.prepare(`
      INSERT INTO contribution_proposals(
        proposal_id, package_id, submission_id, contributor_id, contributor_name,
        status, title, summary, accepted_by, accepted_at, accepted_revision,
        accepted_commit, rejection_reason, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      proposal.proposalId, proposal.packageId, proposal.submissionId, proposal.contributorId,
      proposal.contributorName, proposal.status, proposal.title, proposal.summary,
      proposal.acceptedBy, proposal.acceptedAt, null, null, proposal.rejectionReason,
      proposal.createdAt, proposal.updatedAt,
    );
  }

  getContributionProposal(proposalId: string): ContributionProposal | null {
    const row = this.sqlite.prepare("SELECT * FROM contribution_proposals WHERE proposal_id = ?")
      .get(proposalId) as ContributionProposalRow | undefined;
    return row ? this.mapContributionProposal(row) : null;
  }

  getContributionProposalBySubmission(submissionId: string): ContributionProposal | null {
    const row = this.sqlite.prepare("SELECT * FROM contribution_proposals WHERE submission_id = ?")
      .get(submissionId) as ContributionProposalRow | undefined;
    return row ? this.mapContributionProposal(row) : null;
  }

  listContributionProposals(packageId: string): ContributionProposal[] {
    return (this.sqlite.prepare(`
      SELECT * FROM contribution_proposals WHERE package_id = ?
      ORDER BY updated_at DESC, proposal_id DESC
    `).all(packageId) as unknown as ContributionProposalRow[]).map((row) => this.mapContributionProposal(row));
  }

  listContributionProposalsByContributor(contributorId: string): ContributionProposal[] {
    return (this.sqlite.prepare(`
      SELECT * FROM contribution_proposals WHERE contributor_id = ?
      ORDER BY updated_at DESC, proposal_id DESC
    `).all(contributorId) as unknown as ContributionProposalRow[]).map((row) => this.mapContributionProposal(row));
  }

  acceptContributionProposal(
    proposalId: string,
    expectedStatus: ProposalStatus,
    acceptedBy: string,
    acceptedAt: string,
    acceptedRevision: number,
    acceptedCommit: string,
  ): boolean {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const current = this.sqlite.prepare(`
        SELECT cp.submission_id, cp.status, s.revision, s.resolved_commit,
          s.status AS submission_status, s.verified_revision
        FROM contribution_proposals cp
        JOIN submissions s ON s.submission_id = cp.submission_id
        WHERE cp.proposal_id = ?
      `).get(proposalId) as {
        submission_id: string;
        status: ProposalStatus;
        revision: number;
        resolved_commit: string | null;
        submission_status: SubmissionStatus;
        verified_revision: number | null;
      } | undefined;
      if (
        !current || current.status !== expectedStatus || current.revision !== acceptedRevision ||
        current.resolved_commit !== acceptedCommit || current.submission_status !== "awaiting_review" ||
        current.verified_revision !== acceptedRevision
      ) {
        this.sqlite.exec("ROLLBACK");
        return false;
      }
      const result = this.sqlite.prepare(`
        UPDATE contribution_proposals SET
          status = 'accepted', accepted_by = ?, accepted_at = ?,
          accepted_revision = ?, accepted_commit = ?, rejection_reason = NULL,
          updated_at = ?
        WHERE proposal_id = ? AND status = ? AND submission_id = ?
      `).run(
        acceptedBy, acceptedAt, acceptedRevision, acceptedCommit, acceptedAt,
        proposalId, expectedStatus, current.submission_id,
      );
      if (Number(result.changes) !== 1) {
        this.sqlite.exec("ROLLBACK");
        return false;
      }
      this.sqlite.exec("COMMIT");
      return true;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  getContributionProposalAcceptance(proposalId: string): { revision: number; commit: string } | null {
    const row = this.sqlite.prepare(`
      SELECT accepted_revision, accepted_commit
      FROM contribution_proposals WHERE proposal_id = ?
    `).get(proposalId) as { accepted_revision: number | null; accepted_commit: string | null } | undefined;
    if (!row || row.accepted_revision === null || row.accepted_commit === null) return null;
    return { revision: row.accepted_revision, commit: row.accepted_commit };
  }

  updateContributionProposal(proposalId: string, expectedStatus: ProposalStatus, changes: ProposalChanges): boolean {
    const mapping: Record<keyof ProposalChanges, string> = {
      status: "status",
      title: "title",
      summary: "summary",
      acceptedBy: "accepted_by",
      acceptedAt: "accepted_at",
      rejectionReason: "rejection_reason",
      updatedAt: "updated_at",
    };
    const values: SqlValue[] = [];
    const assignments = (Object.entries(changes) as Array<[keyof ProposalChanges, ProposalChanges[keyof ProposalChanges]]>)
      .map(([key, value]) => {
        values.push(value as SqlValue);
        return `${mapping[key]} = ?`;
      });
    if (assignments.length === 0) return false;
    if (
      changes.acceptedBy === null || changes.acceptedAt === null ||
      (changes.status !== undefined && changes.status !== "accepted" && changes.status !== "released")
    ) {
      assignments.push("accepted_revision = NULL", "accepted_commit = NULL");
    }
    values.push(proposalId, expectedStatus);
    const result = this.sqlite.prepare(`
      UPDATE contribution_proposals SET ${assignments.join(", ")}
      WHERE proposal_id = ? AND status = ?
    `).run(...values);
    return Number(result.changes) === 1;
  }

  updateContributionProposalBySubmission(
    submissionId: string,
    expectedStatuses: ProposalStatus[],
    changes: ProposalChanges,
  ): boolean {
    if (expectedStatuses.length === 0) return false;
    const mapping: Record<keyof ProposalChanges, string> = {
      status: "status",
      title: "title",
      summary: "summary",
      acceptedBy: "accepted_by",
      acceptedAt: "accepted_at",
      rejectionReason: "rejection_reason",
      updatedAt: "updated_at",
    };
    const values: SqlValue[] = [];
    const assignments = (Object.entries(changes) as Array<[keyof ProposalChanges, ProposalChanges[keyof ProposalChanges]]>)
      .map(([key, value]) => {
        values.push(value as SqlValue);
        return `${mapping[key]} = ?`;
      });
    if (assignments.length === 0) return false;
    if (
      changes.acceptedBy === null || changes.acceptedAt === null ||
      (changes.status !== undefined && changes.status !== "accepted" && changes.status !== "released")
    ) {
      assignments.push("accepted_revision = NULL", "accepted_commit = NULL");
    }
    values.push(submissionId, ...expectedStatuses);
    const result = this.sqlite.prepare(`
      UPDATE contribution_proposals SET ${assignments.join(", ")}
      WHERE submission_id = ? AND status IN (${expectedStatuses.map(() => "?").join(", ")})
    `).run(...values);
    return Number(result.changes) === 1;
  }

  private mapContributionProposal(row: ContributionProposalRow): ContributionProposal {
    return {
      proposalId: row.proposal_id,
      packageId: row.package_id,
      submissionId: row.submission_id,
      contributorId: row.contributor_id,
      contributorName: row.contributor_name,
      status: row.status as ProposalStatus,
      title: row.title,
      summary: row.summary,
      acceptedBy: row.accepted_by,
      acceptedAt: row.accepted_at,
      rejectionReason: row.rejection_reason,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  approveSubmission(
    release: ReleaseRecord,
    expected: { revision: number; manifestDigest: string; metadata: PackagePresentationMetadata },
    review?: SubmissionReview,
  ): boolean {
    const now = release.publishedAt;
    const manifest = release.manifest;
    const contributionTypes = [...new Set(manifest.contributions.map((item) => item.type))];
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const current = this.sqlite.prepare(`
        SELECT status, revision, verified_revision, resolved_commit, manifest_digest, metadata
        FROM submissions WHERE submission_id = ?
      `).get(release.submissionId) as {
        status: string;
        revision: number;
        verified_revision: number | null;
        resolved_commit: string | null;
        manifest_digest: string | null;
        metadata: string;
      } | undefined;
      if (
        !current || current.status !== "awaiting_review" || current.revision !== expected.revision ||
        current.verified_revision !== expected.revision || current.resolved_commit !== release.approvedCommit ||
        current.manifest_digest !== expected.manifestDigest || current.metadata !== json(expected.metadata)
      ) {
        this.sqlite.exec("ROLLBACK");
        return false;
      }
      const proposal = this.sqlite.prepare(`
        SELECT status, accepted_revision, accepted_commit
        FROM contribution_proposals WHERE submission_id = ?
      `).get(release.submissionId) as {
        status: string;
        accepted_revision: number | null;
        accepted_commit: string | null;
      } | undefined;
      if (
        proposal && (
          proposal.status !== "accepted" ||
          proposal.accepted_revision !== expected.revision ||
          proposal.accepted_commit !== release.approvedCommit
        )
      ) {
        this.sqlite.exec("ROLLBACK");
        return false;
      }
      const packageExisted = Boolean(this.sqlite.prepare("SELECT 1 FROM packages WHERE package_id = ?")
        .get(manifest.id));
      this.sqlite.prepare(`
        INSERT INTO packages(
          package_id, publisher_id, name, summary, description, license, categories,
          contribution_types, latest_release_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(package_id) DO UPDATE SET
          publisher_id = excluded.publisher_id,
          name = excluded.name,
          summary = excluded.summary,
          description = excluded.description,
          license = excluded.license,
          categories = excluded.categories,
          contribution_types = excluded.contribution_types,
          latest_release_id = excluded.latest_release_id,
          updated_at = excluded.updated_at
      `).run(
        manifest.id,
        release.publisherId,
        manifest.name,
        manifest.summary,
        manifest.description ?? null,
        manifest.license ?? null,
        json(manifest.categories),
        json(contributionTypes),
        release.releaseId,
        now,
        now,
      );
      this.sqlite.prepare(`
        INSERT INTO releases(
          release_id, package_id, submission_id, publisher_id, version,
          approved_commit, submitted_ref, repository_url, mirror_urls,
          manifest_path, manifest_digest, manifest, metadata, verification,
          status, published_at, revocation, attribution
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        release.releaseId,
        release.packageId,
        release.submissionId,
        release.publisherId,
        release.version,
        release.approvedCommit,
        release.submittedRef,
        release.repositoryUrl,
        json(release.mirrorUrls),
        release.manifestPath,
        release.manifestDigest,
        json(release.manifest),
        json(release.metadata),
        json(release.verification),
        release.status,
        release.publishedAt,
        null,
        release.attribution ? json(release.attribution) : null,
      );
      const updated = this.sqlite.prepare(`
        UPDATE submissions SET status = 'approved', updated_at = ?
        WHERE submission_id = ? AND revision = ? AND verified_revision = ? AND status = 'awaiting_review'
      `).run(now, release.submissionId, expected.revision, expected.revision);
      if (Number(updated.changes) !== 1) throw new Error("submission_revision_changed");
      if (!packageExisted) {
        const publisherUser = this.sqlite.prepare("SELECT 1 FROM users WHERE user_id = ?")
          .get(release.publisherId);
        if (publisherUser) {
          this.sqlite.prepare(`
            INSERT INTO package_members(package_id, user_id, role, created_at, updated_at)
            VALUES (?, ?, 'owner', ?, ?)
            ON CONFLICT(package_id, user_id) DO UPDATE SET role = 'owner', updated_at = excluded.updated_at
          `).run(release.packageId, release.publisherId, now, now);
        }
      }
      if (proposal) {
        const released = this.sqlite.prepare(`
          UPDATE contribution_proposals SET status = 'released', updated_at = ?
          WHERE submission_id = ? AND status = 'accepted'
        `).run(now, release.submissionId);
        if (Number(released.changes) !== 1) throw new Error("proposal_acceptance_changed");
      }
      if (review) this.insertSubmissionReview(review);
      this.sqlite.exec("COMMIT");
      return true;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  getRelease(id: string): ReleaseRecord | null {
    const row = this.sqlite.prepare("SELECT * FROM releases WHERE release_id = ?").get(id) as ReleaseRow | undefined;
    return row ? this.mapRelease(row) : null;
  }

  getLatestRelease(packageId: string): ReleaseRecord | null {
    const row = this.sqlite.prepare(`
      SELECT * FROM releases
      WHERE package_id = ? AND status = 'approved'
      ORDER BY published_at DESC, release_id DESC LIMIT 1
    `).get(packageId) as ReleaseRow | undefined;
    return row ? this.mapRelease(row) : null;
  }

  listApprovedReleases(packageId: string): ReleaseRecord[] {
    return (this.sqlite.prepare(`
      SELECT * FROM releases
      WHERE package_id = ? AND status = 'approved'
      ORDER BY published_at DESC, rowid DESC
    `).all(packageId) as unknown as ReleaseRow[]).map((row) => this.mapRelease(row));
  }

  getNewestRelease(packageId: string): ReleaseRecord | null {
    const row = this.sqlite.prepare(`
      SELECT * FROM releases
      WHERE package_id = ?
      ORDER BY published_at DESC, release_id DESC LIMIT 1
    `).get(packageId) as ReleaseRow | undefined;
    return row ? this.mapRelease(row) : null;
  }

  listReleases(packageId: string, offset: number, limit: number): ReleaseRecord[] {
    return (this.sqlite.prepare(`
      SELECT * FROM releases WHERE package_id = ?
      ORDER BY published_at DESC, release_id DESC LIMIT ? OFFSET ?
    `).all(packageId, limit, offset) as unknown as ReleaseRow[]).map((row) => this.mapRelease(row));
  }

  countReleases(packageId: string): number {
    const row = this.sqlite.prepare("SELECT COUNT(*) AS count FROM releases WHERE package_id = ?")
      .get(packageId) as { count: number };
    return Number(row.count);
  }

  private mapRelease(row: ReleaseRow): ReleaseRecord {
    return {
      releaseId: row.release_id,
      packageId: row.package_id,
      submissionId: row.submission_id,
      publisherId: row.publisher_id,
      version: row.version,
      approvedCommit: row.approved_commit,
      submittedRef: row.submitted_ref,
      repositoryUrl: row.repository_url,
      mirrorUrls: parse<string[]>(row.mirror_urls),
      manifestPath: row.manifest_path,
      manifestDigest: row.manifest_digest,
      manifest: parse<PackageManifest>(row.manifest),
      metadata: parse<PackagePresentationMetadata>(row.metadata),
      verification: parse<VerificationResult>(row.verification),
      status: row.status as ReleaseRecord["status"],
      publishedAt: row.published_at,
      revocation: row.revocation ? parse<ReleaseRecord["revocation"]>(row.revocation) : null,
      attribution: row.attribution ? parse<ReleaseRecord["attribution"]>(row.attribution) : null,
    };
  }

  listPackages(filters: {
    q: string | null;
    category: string | null;
    contributionType: string | null;
    offset: number;
    limit: number;
  }): Array<{
    id: string;
    name: string;
    summary: string;
    categories: string[];
    latestReleaseId: string;
    updatedAt: string;
  }> {
    const where: string[] = ["latest_release_id IS NOT NULL"];
    const values: SqlValue[] = [];
    if (filters.q) {
      where.push("(lower(name) LIKE ? OR lower(summary) LIKE ? OR lower(package_id) LIKE ?)");
      const q = `%${filters.q.toLowerCase()}%`;
      values.push(q, q, q);
    }
    if (filters.category) {
      where.push("EXISTS (SELECT 1 FROM json_each(packages.categories) WHERE value = ?)");
      values.push(filters.category);
    }
    if (filters.contributionType) {
      where.push("EXISTS (SELECT 1 FROM json_each(packages.contribution_types) WHERE value = ?)");
      values.push(filters.contributionType);
    }
    values.push(filters.limit, filters.offset);
    const rows = this.sqlite.prepare(`
      SELECT package_id, name, summary, categories, latest_release_id, updated_at
      FROM packages WHERE ${where.join(" AND ")}
      ORDER BY updated_at DESC, package_id ASC LIMIT ? OFFSET ?
    `).all(...values) as unknown as Array<{
      package_id: string;
      name: string;
      summary: string;
      categories: string;
      latest_release_id: string;
      updated_at: string;
    }>;
    return rows.map((row) => ({
      id: row.package_id,
      name: row.name,
      summary: row.summary,
      categories: parse<string[]>(row.categories),
      latestReleaseId: row.latest_release_id,
      updatedAt: row.updated_at,
    }));
  }

  countPackages(filters: { q: string | null; category: string | null; contributionType: string | null }): number {
    const where: string[] = ["latest_release_id IS NOT NULL"];
    const values: SqlValue[] = [];
    if (filters.q) {
      where.push("(lower(name) LIKE ? OR lower(summary) LIKE ? OR lower(package_id) LIKE ?)");
      const q = `%${filters.q.toLowerCase()}%`;
      values.push(q, q, q);
    }
    if (filters.category) {
      where.push("EXISTS (SELECT 1 FROM json_each(packages.categories) WHERE value = ?)");
      values.push(filters.category);
    }
    if (filters.contributionType) {
      where.push("EXISTS (SELECT 1 FROM json_each(packages.contribution_types) WHERE value = ?)");
      values.push(filters.contributionType);
    }
    const row = this.sqlite.prepare(`SELECT COUNT(*) AS count FROM packages WHERE ${where.join(" AND ")}`)
      .get(...values) as { count: number };
    return Number(row.count);
  }

  getPackageRow(id: string): {
    packageId: string;
    publisherId: string;
    createdAt: string;
    updatedAt: string;
  } | null {
    const row = this.sqlite.prepare(`
      SELECT package_id, publisher_id, created_at, updated_at FROM packages WHERE package_id = ?
    `).get(id) as { package_id: string; publisher_id: string; created_at: string; updated_at: string } | undefined;
    return row ? {
      packageId: row.package_id,
      publisherId: row.publisher_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    } : null;
  }

  getPackageMember(packageId: string, userId: string): PackageMember | null {
    const row = this.sqlite.prepare(`
      SELECT
        pm.package_id,
        pm.user_id AS member_user_id,
        pm.role AS package_role,
        pm.created_at AS member_created_at,
        pm.updated_at AS member_updated_at,
        u.*
      FROM package_members pm
      JOIN users u ON u.user_id = pm.user_id
      WHERE pm.package_id = ? AND pm.user_id = ?
    `).get(packageId, userId) as PackageMemberRow | undefined;
    return row ? this.mapPackageMember(row) : null;
  }

  listPackageMembers(packageId: string): PackageMember[] {
    return (this.sqlite.prepare(`
      SELECT
        pm.package_id,
        pm.user_id AS member_user_id,
        pm.role AS package_role,
        pm.created_at AS member_created_at,
        pm.updated_at AS member_updated_at,
        u.*
      FROM package_members pm
      JOIN users u ON u.user_id = pm.user_id
      WHERE pm.package_id = ?
      ORDER BY CASE pm.role WHEN 'owner' THEN 0 WHEN 'maintainer' THEN 1 ELSE 2 END,
        lower(u.login), u.user_id
    `).all(packageId) as unknown as PackageMemberRow[]).map((row) => this.mapPackageMember(row));
  }

  upsertPackageMember(packageId: string, userId: string, role: PackageRole, timestamp: string): PackageMember {
    this.sqlite.prepare(`
      INSERT INTO package_members(package_id, user_id, role, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(package_id, user_id) DO UPDATE SET
        role = excluded.role,
        updated_at = excluded.updated_at
    `).run(packageId, userId, role, timestamp, timestamp);
    return this.getPackageMember(packageId, userId)!;
  }

  removePackageMember(packageId: string, userId: string): boolean {
    const result = this.sqlite.prepare("DELETE FROM package_members WHERE package_id = ? AND user_id = ?")
      .run(packageId, userId);
    return Number(result.changes) === 1;
  }

  getPackageRole(packageId: string, userId: string): PackageRole | null {
    const member = this.sqlite.prepare(`
      SELECT role FROM package_members WHERE package_id = ? AND user_id = ?
    `).get(packageId, userId) as { role: string } | undefined;
    if (member) return member.role as PackageRole;
    const legacyOwner = this.sqlite.prepare(`
      SELECT 1 FROM packages WHERE package_id = ? AND publisher_id = ?
    `).get(packageId, userId);
    return legacyOwner ? "owner" : null;
  }

  listPackageIdsByMember(userId: string, roles: PackageRole[] = ["owner", "maintainer", "contributor"]): string[] {
    if (roles.length === 0) return [];
    return (this.sqlite.prepare(`
      SELECT package_id FROM package_members
      WHERE user_id = ? AND role IN (${roles.map(() => "?").join(", ")})
      UNION
      SELECT package_id FROM packages WHERE publisher_id = ?
      ORDER BY package_id
    `).all(userId, ...roles, userId) as unknown as Array<{ package_id: string }>).map((row) => row.package_id);
  }

  private mapPackageMember(row: PackageMemberRow): PackageMember {
    return {
      packageId: row.package_id,
      userId: row.member_user_id,
      role: row.package_role as PackageRole,
      user: {
        githubId: row.github_id,
        login: row.login,
        name: row.name,
        avatarUrl: row.avatar_url,
        profileUrl: row.profile_url,
      },
      createdAt: row.member_created_at,
      updatedAt: row.member_updated_at,
    };
  }

  listPackageIdsByPublisher(publisherId: string): string[] {
    return (this.sqlite.prepare("SELECT package_id FROM packages WHERE publisher_id = ? ORDER BY package_id")
      .all(publisherId) as unknown as Array<{ package_id: string }>).map((row) => row.package_id);
  }

  revokeRelease(id: string, revocation: { reason: string; revokedAt: string }): void {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const release = this.getRelease(id);
      if (!release) throw new Error("release_not_found");
      this.sqlite.prepare("UPDATE releases SET status = 'revoked', revocation = ? WHERE release_id = ?")
        .run(json(revocation), id);
      const latest = this.sqlite.prepare(`
        SELECT release_id FROM releases
        WHERE package_id = ? AND status = 'approved' AND release_id <> ?
        ORDER BY published_at DESC, release_id DESC LIMIT 1
      `).get(release.packageId, id) as { release_id: string } | undefined;
      this.sqlite.prepare("UPDATE packages SET latest_release_id = ?, updated_at = ? WHERE package_id = ?")
        .run(latest?.release_id ?? null, revocation.revokedAt, release.packageId);
      this.sqlite.exec("COMMIT");
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  recordSourceHealth(health: SourceHealth): void {
    this.sqlite.prepare(`
      INSERT INTO source_health(url, kind, status, checked_at, commit_hash, error)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(url) DO UPDATE SET
        kind = excluded.kind,
        status = excluded.status,
        checked_at = excluded.checked_at,
        commit_hash = excluded.commit_hash,
        error = excluded.error
    `).run(health.url, health.kind, health.status, health.checkedAt, health.commit, health.error);
  }

  addAudit(event: {
    id: string;
    actor: string;
    action: string;
    targetType: string;
    targetId: string;
    detail: unknown;
    createdAt: string;
  }): void {
    this.sqlite.prepare(`
      INSERT INTO audit_events(event_id, actor, action, target_type, target_id, detail, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(event.id, event.actor, event.action, event.targetType, event.targetId, json(event.detail), event.createdAt);
  }

  insertIssue(record: Omit<SupportIssueRecord, "issueNumber">): SupportIssueRecord {
    const result = this.sqlite.prepare(`
      INSERT INTO support_issues(
        issue_id, package_id, component, target_repository, reporter_token_hash,
        reporter_name, source, confirmation, title, body, labels, environment,
        visibility, status, fix_release_id, github_url, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.issueId, record.packageId, record.component, record.targetRepository,
      record.reporterTokenHash, record.reporterName, record.source, record.confirmation,
      record.title, record.body, json(record.labels), json(record.environment),
      record.visibility, record.status, record.fixReleaseId, record.githubUrl,
      record.createdAt, record.updatedAt,
    );
    return { ...record, issueNumber: Number(result.lastInsertRowid) };
  }

  getIssue(idOrNumber: string): SupportIssueRecord | null {
    const numeric = /^\d+$/.test(idOrNumber) ? Number(idOrNumber) : null;
    const row = (numeric === null
      ? this.sqlite.prepare("SELECT * FROM support_issues WHERE issue_id = ?").get(idOrNumber)
      : this.sqlite.prepare("SELECT * FROM support_issues WHERE issue_number = ?").get(numeric)) as IssueRow | undefined;
    return row ? this.mapIssue(row) : null;
  }

  listIssues(filters: IssueListFilters): SupportIssueRecord[] {
    const { where, values } = this.issueFilters(filters);
    values.push(filters.limit, filters.offset);
    return (this.sqlite.prepare(`
      SELECT * FROM support_issues WHERE ${where.join(" AND ")}
      ORDER BY updated_at DESC, issue_number DESC LIMIT ? OFFSET ?
    `).all(...values) as unknown as IssueRow[]).map((row) => this.mapIssue(row));
  }

  countIssues(filters: Omit<IssueListFilters, "offset" | "limit">): number {
    const { where, values } = this.issueFilters({ ...filters, offset: 0, limit: 1 });
    const row = this.sqlite.prepare(`SELECT COUNT(*) AS count FROM support_issues WHERE ${where.join(" AND ")}`)
      .get(...values) as { count: number };
    return Number(row.count);
  }

  updateIssue(id: string, changes: Partial<Pick<SupportIssueRecord, "status" | "fixReleaseId" | "githubUrl" | "updatedAt">>): void {
    const mapping: Record<string, string> = {
      status: "status",
      fixReleaseId: "fix_release_id",
      githubUrl: "github_url",
      updatedAt: "updated_at",
    };
    const values: SqlValue[] = [];
    const assignments = Object.entries(changes).map(([key, value]) => {
      values.push(value as SqlValue);
      return `${mapping[key]} = ?`;
    });
    if (assignments.length === 0) return;
    values.push(id);
    this.sqlite.prepare(`UPDATE support_issues SET ${assignments.join(", ")} WHERE issue_id = ?`).run(...values);
  }

  insertIssueComment(comment: SupportIssueComment): void {
    this.sqlite.prepare(`
      INSERT INTO support_issue_comments(comment_id, issue_id, actor_type, actor_id, actor_name, body, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(comment.commentId, comment.issueId, comment.actorType, comment.actorId, comment.actorName, comment.body, comment.createdAt);
  }

  listIssueComments(issueId: string): SupportIssueComment[] {
    return (this.sqlite.prepare(`
      SELECT * FROM support_issue_comments WHERE issue_id = ? ORDER BY created_at ASC, rowid ASC
    `).all(issueId) as unknown as IssueCommentRow[]).map((row) => ({
      commentId: row.comment_id,
      issueId: row.issue_id,
      actorType: row.actor_type as SupportIssueComment["actorType"],
      actorId: row.actor_id,
      actorName: row.actor_name,
      body: row.body,
      createdAt: row.created_at,
    }));
  }

  private issueFilters(filters: IssueListFilters): { where: string[]; values: SqlValue[] } {
    const where = ["1 = 1"];
    const values: SqlValue[] = [];
    if (filters.packageId) { where.push("package_id = ?"); values.push(filters.packageId); }
    if (filters.status) { where.push("status = ?"); values.push(filters.status); }
    if (filters.q) {
      const q = `%${filters.q.toLowerCase()}%`;
      where.push("(lower(title) LIKE ? OR lower(body) LIKE ? OR lower(component) LIKE ?)");
      values.push(q, q, q);
    }
    if (!filters.includeAll) {
      const access = ["visibility = 'public'"];
      if (filters.reporterTokenHash) { access.push("reporter_token_hash = ?"); values.push(filters.reporterTokenHash); }
      if (filters.maintainerPackageIds.length > 0) {
        access.push(`package_id IN (${filters.maintainerPackageIds.map(() => "?").join(", ")})`);
        values.push(...filters.maintainerPackageIds);
      }
      where.push(`(${access.join(" OR ")})`);
    }
    return { where, values };
  }

  private mapIssue(row: IssueRow): SupportIssueRecord {
    return {
      issueId: row.issue_id,
      issueNumber: row.issue_number,
      packageId: row.package_id,
      component: row.component,
      targetRepository: row.target_repository,
      reporterTokenHash: row.reporter_token_hash,
      reporterName: row.reporter_name,
      source: row.source as SupportIssueRecord["source"],
      confirmation: row.confirmation as SupportIssueRecord["confirmation"],
      title: row.title,
      body: row.body,
      labels: parse<string[]>(row.labels),
      environment: parse<Record<string, unknown>>(row.environment),
      visibility: row.visibility as SupportIssueRecord["visibility"],
      status: row.status as SupportIssueRecord["status"],
      fixReleaseId: row.fix_release_id,
      githubUrl: row.github_url,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
