import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, normalize, relative, sep } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { RequestError } from "./protocol.js";
import type {
  BindingReconciliationResult,
  CreateSessionBindingInput,
  CreateWorkspaceInput,
  InheritSessionBindingInput,
  RebindSessionInput,
  SessionBindingListFilter,
  SessionProfileBinding,
  UpdateWorkspaceInput,
  WorkspaceListFilter,
  WorkspaceRecord,
} from "./profile-types.js";

const SAFE_ENTITY_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_SESSION_ID_LENGTH = 512;
const MAX_WORKSPACE_NAME_LENGTH = 160;
const SCHEMA_VERSION = 2;

export interface ProfileStateStoreOptions {
  path: string;
  busyTimeoutMs?: number;
  now?: () => Date;
}

export class ProfileStateStore {
  readonly path: string;
  private readonly database: DatabaseSync;
  private readonly now: () => Date;
  private closed = false;

  constructor(options: ProfileStateStoreOptions) {
    this.path = validateDatabasePath(options.path);
    this.now = options.now ?? (() => new Date());
    if (this.path !== ":memory:") mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(this.path);
    const busyTimeoutMs = boundedInteger(options.busyTimeoutMs ?? 5_000, "busyTimeoutMs", 0, 60_000);
    this.database.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
    this.database.exec("PRAGMA foreign_keys = ON");
    if (this.path !== ":memory:") {
      this.database.exec("PRAGMA journal_mode = WAL");
      this.database.exec("PRAGMA synchronous = NORMAL");
    }
    this.initializeSchema();
  }

  close(): void {
    if (this.closed) return;
    this.database.close();
    this.closed = true;
  }

  createWorkspace(input: CreateWorkspaceInput): WorkspaceRecord {
    this.assertOpen();
    const normalized = normalizeWorkspaceInput(input);
    return this.transaction(() => {
      const existing = this.getWorkspace(normalized.id);
      if (existing) {
        if (workspaceIdentityMatches(existing, normalized)) return existing;
        throw new RequestError("workspace_conflict", `Workspace already exists with different data: ${normalized.id}`);
      }
      const now = this.timestamp();
      this.database.prepare(`
        INSERT INTO workspaces (id, name, root_cwd, archived, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(normalized.id, normalized.name, normalized.rootCwd, normalized.archived ? 1 : 0, now, now);
      return this.requireWorkspace(normalized.id);
    });
  }

  getWorkspace(id: string): WorkspaceRecord | undefined {
    this.assertOpen();
    assertEntityId(id, "workspace id");
    const row = this.database.prepare(`
      SELECT id, name, root_cwd, archived, created_at, updated_at
      FROM workspaces WHERE id = ?
    `).get(id);
    return row ? workspaceFromRow(row) : undefined;
  }

  listWorkspaces(filter: WorkspaceListFilter = {}): WorkspaceRecord[] {
    this.assertOpen();
    const rows = filter.includeArchived
      ? this.database.prepare(`
          SELECT id, name, root_cwd, archived, created_at, updated_at
          FROM workspaces ORDER BY name COLLATE NOCASE, id
        `).all()
      : this.database.prepare(`
          SELECT id, name, root_cwd, archived, created_at, updated_at
          FROM workspaces WHERE archived = 0 ORDER BY name COLLATE NOCASE, id
        `).all();
    return rows.map(workspaceFromRow);
  }

  updateWorkspace(id: string, input: UpdateWorkspaceInput): WorkspaceRecord {
    this.assertOpen();
    assertEntityId(id, "workspace id");
    const current = this.requireWorkspace(id);
    const next = normalizeWorkspaceInput({
      id,
      name: input.name ?? current.name,
      rootCwd: input.rootCwd ?? current.rootCwd,
      archived: input.archived ?? current.archived,
    });
    if (workspaceIdentityMatches(current, next)) return current;
    this.database.prepare(`
      UPDATE workspaces SET name = ?, root_cwd = ?, archived = ?, updated_at = ? WHERE id = ?
    `).run(next.name, next.rootCwd, next.archived ? 1 : 0, this.timestamp(), id);
    return this.requireWorkspace(id);
  }

  touchWorkspace(id: string): WorkspaceRecord {
    this.assertOpen();
    assertEntityId(id, "workspace id");
    if (!this.getWorkspace(id)) throw new RequestError("workspace_not_found", `Workspace not found: ${id}`);
    this.database.prepare("UPDATE workspaces SET updated_at = ? WHERE id = ?").run(this.timestamp(), id);
    return this.requireWorkspace(id);
  }

  removeWorkspace(id: string): boolean {
    this.assertOpen();
    assertEntityId(id, "workspace id");
    return this.database.prepare("DELETE FROM workspaces WHERE id = ?").run(id).changes > 0;
  }

  createBinding(input: CreateSessionBindingInput): SessionProfileBinding {
    this.assertOpen();
    const normalized = this.normalizeBindingInput(input);
    return this.transaction(() => this.createBindingInTransaction(normalized));
  }

  rebind(input: RebindSessionInput): SessionProfileBinding {
    this.assertOpen();
    const normalized = this.normalizeBindingInput(input);
    return this.transaction(() => {
      const current = this.getBinding(normalized.sessionId);
      if (!current) {
        if (input.expectedRevision !== undefined && input.expectedRevision !== 0) {
          throw new RequestError("session_binding_revision_conflict", "Unbound session revision must be 0");
        }
        return this.createBindingInTransaction(normalized);
      }
      if (input.expectedRevision !== undefined && input.expectedRevision !== current.bindingRevision) {
        throw new RequestError("session_binding_revision_conflict", "Session binding changed before this operation", {
          expectedRevision: input.expectedRevision,
          currentRevision: current.bindingRevision,
        });
      }
      if (bindingScopeMatches(current, normalized)) return current;
      this.database.prepare(`
        UPDATE session_bindings
        SET assistant_id = ?, workspace_id = ?, cwd = ?, binding_revision = ?, updated_at = ?
        WHERE session_id = ?
      `).run(normalized.assistantId, normalized.workspaceId, normalized.cwd,
        current.bindingRevision + 1, this.timestamp(), normalized.sessionId);
      return this.requireBinding(normalized.sessionId);
    });
  }

  restoreBinding(sessionId: string, binding: SessionProfileBinding | undefined): void {
    this.assertOpen();
    assertSessionId(sessionId, "session id");
    this.transaction(() => {
      this.database.prepare("DELETE FROM session_bindings WHERE session_id = ?").run(sessionId);
      if (!binding) return;
      this.database.prepare(`
        INSERT INTO session_bindings
          (session_id, assistant_id, workspace_id, cwd, binding_revision, inherited_from_session_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(binding.sessionId, binding.assistantId, binding.workspaceId, binding.cwd, binding.bindingRevision,
        binding.inheritedFromSessionId, binding.createdAt, binding.updatedAt);
    });
  }

  inheritBinding(input: InheritSessionBindingInput): SessionProfileBinding {
    this.assertOpen();
    assertSessionId(input.sourceSessionId, "source session id");
    assertSessionId(input.targetSessionId, "target session id");
    return this.transaction(() => {
      const source = this.getBinding(input.sourceSessionId);
      if (!source) throw new RequestError("session_binding_not_found", `Session binding not found: ${input.sourceSessionId}`);
      return this.createBindingInTransaction(this.normalizeBindingInput({
        sessionId: input.targetSessionId,
        assistantId: source.assistantId,
        workspaceId: input.workspaceId === undefined ? source.workspaceId : input.workspaceId,
        cwd: input.cwd ?? source.cwd,
        inheritedFromSessionId: source.sessionId,
      }));
    });
  }

  reconcileBinding(input: CreateSessionBindingInput): BindingReconciliationResult {
    this.assertOpen();
    const normalized = this.normalizeBindingInput(input);
    return this.transaction(() => {
      const existing = this.getBinding(normalized.sessionId);
      if (!existing) return { status: "created", binding: this.createBindingInTransaction(normalized) };
      if (bindingIdentityMatches(existing, normalized)) return { status: "unchanged", binding: existing };
      throw new RequestError(
        "session_binding_conflict",
        `Session already belongs to another Profile or Workspace: ${normalized.sessionId}`,
      );
    });
  }

  getBinding(sessionId: string): SessionProfileBinding | undefined {
    this.assertOpen();
    assertSessionId(sessionId, "session id");
    const row = this.database.prepare(`
      SELECT session_id, assistant_id, workspace_id, cwd, binding_revision, inherited_from_session_id, created_at, updated_at
      FROM session_bindings WHERE session_id = ?
    `).get(sessionId);
    return row ? bindingFromRow(row) : undefined;
  }

  listBindings(filter: SessionBindingListFilter = {}): SessionProfileBinding[] {
    this.assertOpen();
    const clauses: string[] = [];
    const parameters: SQLInputValue[] = [];
    if (filter.assistantId !== undefined) {
      assertEntityId(filter.assistantId, "assistant id");
      clauses.push("assistant_id = ?");
      parameters.push(filter.assistantId);
    }
    if (filter.workspaceId !== undefined) {
      if (filter.workspaceId === null) clauses.push("workspace_id IS NULL");
      else {
        assertEntityId(filter.workspaceId, "workspace id");
        clauses.push("workspace_id = ?");
        parameters.push(filter.workspaceId);
      }
    }
    if (filter.cwd !== undefined) {
      clauses.push("cwd = ?");
      parameters.push(normalizeAbsolutePath(filter.cwd, "cwd"));
    }
    const limit = boundedInteger(filter.limit ?? 1_000, "limit", 1, 10_000);
    const offset = boundedInteger(filter.offset ?? 0, "offset", 0, Number.MAX_SAFE_INTEGER);
    parameters.push(limit, offset);
    const rows = this.database.prepare(`
      SELECT session_id, assistant_id, workspace_id, cwd, binding_revision, inherited_from_session_id, created_at, updated_at
      FROM session_bindings
      ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY created_at, session_id
      LIMIT ? OFFSET ?
    `).all(...parameters);
    return rows.map(bindingFromRow);
  }

  removeBinding(sessionId: string): boolean {
    this.assertOpen();
    assertSessionId(sessionId, "session id");
    return this.database.prepare("DELETE FROM session_bindings WHERE session_id = ?").run(sessionId).changes > 0;
  }

  private initializeSchema(): void {
    const versionRow = this.database.prepare("PRAGMA user_version").get();
    const version = Number(versionRow?.user_version ?? 0);
    if (version > SCHEMA_VERSION) {
      this.database.close();
      this.closed = true;
      throw new RequestError("profile_state_schema_too_new", `Unsupported Profile state schema: ${version}`);
    }
    if (version === 0) {
      this.database.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS workspaces (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          root_cwd TEXT NOT NULL,
          archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS session_bindings (
          session_id TEXT PRIMARY KEY,
          assistant_id TEXT NOT NULL,
          workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
          cwd TEXT NOT NULL,
          binding_revision INTEGER NOT NULL DEFAULT 1 CHECK (binding_revision >= 1),
          inherited_from_session_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS session_bindings_assistant_idx
          ON session_bindings (assistant_id, created_at, session_id);
        CREATE INDEX IF NOT EXISTS session_bindings_workspace_idx
          ON session_bindings (workspace_id, created_at, session_id);
        CREATE INDEX IF NOT EXISTS session_bindings_cwd_idx
          ON session_bindings (cwd, created_at, session_id);
        PRAGMA user_version = 2;
        COMMIT;
      `);
    } else if (version === 1) {
      this.database.exec(`
        BEGIN IMMEDIATE;
        ALTER TABLE session_bindings ADD COLUMN binding_revision INTEGER NOT NULL DEFAULT 1;
        PRAGMA user_version = 2;
        COMMIT;
      `);
    }
  }

  private createBindingInTransaction(input: Required<CreateSessionBindingInput>): SessionProfileBinding {
    const existing = this.getBinding(input.sessionId);
    if (existing) {
      if (bindingIdentityMatches(existing, input)) return existing;
      throw new RequestError("session_binding_conflict", `Session already belongs to another Profile or Workspace: ${input.sessionId}`);
    }
    const now = this.timestamp();
    this.database.prepare(`
      INSERT INTO session_bindings
        (session_id, assistant_id, workspace_id, cwd, binding_revision, inherited_from_session_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, ?, ?, ?)
    `).run(input.sessionId, input.assistantId, input.workspaceId, input.cwd, input.inheritedFromSessionId, now, now);
    return this.requireBinding(input.sessionId);
  }

  private normalizeBindingInput(input: CreateSessionBindingInput): Required<CreateSessionBindingInput> {
    assertSessionId(input.sessionId, "session id");
    assertEntityId(input.assistantId, "assistant id");
    const workspaceId = input.workspaceId ?? null;
    const cwd = normalizeAbsolutePath(input.cwd, "cwd");
    if (workspaceId !== null) {
      assertEntityId(workspaceId, "workspace id");
      const workspace = this.getWorkspace(workspaceId);
      if (!workspace) throw new RequestError("workspace_not_found", `Workspace not found: ${workspaceId}`);
      if (!isPathInsideOrEqual(workspace.rootCwd, cwd)) {
        throw new RequestError("session_workspace_cwd_mismatch", `Session cwd is outside Workspace ${workspaceId}`);
      }
    }
    const inheritedFromSessionId = input.inheritedFromSessionId ?? null;
    if (inheritedFromSessionId !== null) assertSessionId(inheritedFromSessionId, "inherited session id");
    return {
      sessionId: input.sessionId,
      assistantId: input.assistantId,
      workspaceId,
      cwd,
      inheritedFromSessionId,
    };
  }

  private requireWorkspace(id: string): WorkspaceRecord {
    const workspace = this.getWorkspace(id);
    if (!workspace) throw new RequestError("workspace_not_found", `Workspace not found: ${id}`);
    return workspace;
  }

  private requireBinding(sessionId: string): SessionProfileBinding {
    const binding = this.getBinding(sessionId);
    if (!binding) throw new RequestError("session_binding_not_found", `Session binding not found: ${sessionId}`);
    return binding;
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.database.exec("ROLLBACK"); } catch { /* Preserve the original error. */ }
      throw error;
    }
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  private assertOpen(): void {
    if (this.closed) throw new RequestError("profile_state_closed", "Profile state store is closed");
  }
}

export function assertEntityId(value: string, label: string): void {
  if (!SAFE_ENTITY_ID.test(value)) throw new RequestError("invalid_profile_id", `${label} must match ${SAFE_ENTITY_ID}`);
}

export function normalizeAbsolutePath(value: string, label: string): string {
  if (typeof value !== "string" || value.includes("\0") || !isAbsolute(value)) {
    throw new RequestError("invalid_profile_path", `${label} must be an absolute path`);
  }
  return normalize(value);
}

export function normalizeWorkspaceName(value: string): string {
  if (typeof value !== "string") {
    throw new RequestError("invalid_workspace_name", "Workspace name must be text");
  }
  const name = value.trim();
  if (!name || name.length > MAX_WORKSPACE_NAME_LENGTH || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new RequestError("invalid_workspace_name", `Workspace name must be 1-${MAX_WORKSPACE_NAME_LENGTH} visible characters`);
  }
  return name;
}

export function normalizeArchivedFlag(value: boolean | undefined): boolean | undefined {
  if (value !== undefined && typeof value !== "boolean") {
    throw new RequestError("invalid_workspace_archived", "Workspace archived flag must be boolean");
  }
  return value;
}

function validateDatabasePath(value: string): string {
  if (value === ":memory:") return value;
  return normalizeAbsolutePath(value, "Profile state database path");
}

function normalizeWorkspaceInput(input: CreateWorkspaceInput): Required<CreateWorkspaceInput> {
  assertEntityId(input.id, "workspace id");
  const name = normalizeWorkspaceName(input.name);
  return {
    id: input.id,
    name,
    rootCwd: normalizeAbsolutePath(input.rootCwd, "workspace root cwd"),
    archived: normalizeArchivedFlag(input.archived) ?? false,
  };
}

function assertSessionId(value: string, label: string): void {
  if (typeof value !== "string" || !value || value.length > MAX_SESSION_ID_LENGTH || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new RequestError("invalid_session_id", `${label} must be a non-empty printable string`);
  }
}

function boundedInteger(value: number, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RequestError("invalid_profile_limit", `${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function workspaceIdentityMatches(
  existing: WorkspaceRecord,
  input: Pick<WorkspaceRecord, "name" | "rootCwd" | "archived">,
): boolean {
  return existing.name === input.name && existing.rootCwd === input.rootCwd && existing.archived === input.archived;
}

function bindingIdentityMatches(
  existing: SessionProfileBinding,
  input: Pick<SessionProfileBinding, "assistantId" | "workspaceId" | "cwd" | "inheritedFromSessionId">,
): boolean {
  return existing.assistantId === input.assistantId && existing.workspaceId === input.workspaceId &&
    existing.cwd === input.cwd && existing.inheritedFromSessionId === input.inheritedFromSessionId;
}

function bindingScopeMatches(
  existing: SessionProfileBinding,
  input: Pick<SessionProfileBinding, "assistantId" | "workspaceId" | "cwd">,
): boolean {
  return existing.assistantId === input.assistantId && existing.workspaceId === input.workspaceId && existing.cwd === input.cwd;
}

function isPathInsideOrEqual(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" || (pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot));
}

function workspaceFromRow(row: Record<string, unknown>): WorkspaceRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    rootCwd: String(row.root_cwd),
    archived: Number(row.archived) === 1,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function bindingFromRow(row: Record<string, unknown>): SessionProfileBinding {
  return {
    sessionId: String(row.session_id),
    assistantId: String(row.assistant_id),
    workspaceId: row.workspace_id === null ? null : String(row.workspace_id),
    cwd: String(row.cwd),
    bindingRevision: Number(row.binding_revision ?? 1),
    inheritedFromSessionId: row.inherited_from_session_id === null ? null : String(row.inherited_from_session_id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
