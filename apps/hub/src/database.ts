import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  PackageManifest,
  PackagePresentationMetadata,
  PublisherIdentity,
  ReleaseRecord,
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

      CREATE INDEX IF NOT EXISTS idx_packages_updated ON packages(updated_at DESC, package_id);
      CREATE INDEX IF NOT EXISTS idx_releases_package ON releases(package_id, published_at DESC);
      CREATE INDEX IF NOT EXISTS idx_submissions_publisher ON submissions(publisher_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_support_issues_package ON support_issues(package_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_support_issues_status ON support_issues(status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_support_issues_reporter ON support_issues(reporter_token_hash, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_support_issue_comments_issue ON support_issue_comments(issue_id, created_at ASC);
    `);
    const columns = new Set((this.sqlite.prepare("PRAGMA table_info(submissions)").all() as unknown as Array<{ name: string }>).map((row) => row.name));
    if (!columns.has("revision")) this.sqlite.exec("ALTER TABLE submissions ADD COLUMN revision INTEGER NOT NULL DEFAULT 1");
    if (!columns.has("verified_revision")) this.sqlite.exec("ALTER TABLE submissions ADD COLUMN verified_revision INTEGER");
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

  insertSubmission(record: SubmissionRecord): void {
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
    values.push(id, revision, status);
    const result = this.sqlite.prepare(`
      UPDATE submissions SET ${assignments.join(", ")}
      WHERE submission_id = ? AND revision = ? AND status = ?
    `).run(...values);
    return Number(result.changes) === 1;
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

  approveSubmission(release: ReleaseRecord, expected: { revision: number; manifestDigest: string; metadata: PackagePresentationMetadata }): boolean {
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
          status, published_at, revocation
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      );
      const updated = this.sqlite.prepare(`
        UPDATE submissions SET status = 'approved', updated_at = ?
        WHERE submission_id = ? AND revision = ? AND verified_revision = ? AND status = 'awaiting_review'
      `).run(now, release.submissionId, expected.revision, expected.revision);
      if (Number(updated.changes) !== 1) throw new Error("submission_revision_changed");
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
