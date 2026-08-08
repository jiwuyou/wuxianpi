import { mkdirSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RequestError } from "./protocol.js";
import type {
  AutomationConversationTarget,
  AutomationMessage,
  AutomationMessageStatus,
  AutomationRateUsage,
  AutomationRegistrationRecord,
  AutomationRegistrationStatus,
  AutomationTurn,
  AutomationTurnStatus,
} from "./automation-turn-types.js";

const SCHEMA_VERSION = 3;
const ACTIVE_TURN_STATUSES: AutomationTurnStatus[] = ["queued", "running"];

export interface AutomationTurnStoreOptions {
  path: string;
  now?: () => Date;
  busyTimeoutMs?: number;
}

export class AutomationTurnStore {
  readonly path: string;
  private readonly database: DatabaseSync;
  private readonly now: () => Date;
  private closed = false;

  constructor(options: AutomationTurnStoreOptions) {
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

  createRegistration(input: {
    id: string;
    title: string;
    applicantConversationId: string;
    target: AutomationConversationTarget;
    reason: string;
    projectRoot: string;
    maxCalls: number;
    windowSeconds: number;
    expiresAt: string;
  }): AutomationRegistrationRecord {
    this.assertOpen();
    const now = this.timestamp();
    const target = targetColumns(input.target);
    try {
      this.database.prepare(`
        INSERT INTO automation_registrations (
          id, title, status, applicant_conversation_id, target_kind, target_mode, target_conversation_id,
          target_assistant_id, target_workspace_id, target_cwd, reason, project_root,
          rate_max_calls, rate_window_seconds, expires_at, token_hash,
          created_at, approved_at, last_triggered_at, paused_at, revoked_at, updated_at
        ) VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL, NULL, NULL, ?)
      `).run(
        input.id, input.title, input.applicantConversationId, target.kind, target.mode, target.conversationId,
        target.assistantId, target.workspaceId, target.cwd, input.reason, input.projectRoot,
        input.maxCalls, input.windowSeconds, input.expiresAt, now, now,
      );
    } catch (error) {
      if (isUniqueConstraint(error)) {
        throw new RequestError("automation_registration_conflict", `Automation already exists: ${input.id}`, { httpStatus: 409 });
      }
      throw error;
    }
    return this.requireRegistration(input.id);
  }

  listRegistrations(): AutomationRegistrationRecord[] {
    this.assertOpen();
    this.expireRegistrations();
    return this.database.prepare(`${REGISTRATION_SELECT} ORDER BY created_at DESC`).all().map(registrationFromRow);
  }

  getRegistration(id: string): AutomationRegistrationRecord | undefined {
    this.assertOpen();
    this.expireRegistration(id);
    const row = this.database.prepare(`${REGISTRATION_SELECT} WHERE id = ?`).get(id);
    return row ? registrationFromRow(row) : undefined;
  }

  saveRegistration(registration: AutomationRegistrationRecord): AutomationRegistrationRecord {
    this.assertOpen();
    const target = targetColumns(registration.target);
    const now = this.timestamp();
    const result = this.database.prepare(`
      UPDATE automation_registrations SET
        title = ?, status = ?, applicant_conversation_id = ?, target_kind = ?, target_mode = ?,
        target_conversation_id = ?, target_assistant_id = ?, target_workspace_id = ?, target_cwd = ?,
        reason = ?, project_root = ?, rate_max_calls = ?, rate_window_seconds = ?, expires_at = ?,
        token_hash = ?, approved_at = ?, last_triggered_at = ?, paused_at = ?, revoked_at = ?, updated_at = ?
      WHERE id = ?
    `).run(
      registration.title, registration.status, registration.applicantConversationId, target.kind, target.mode,
      registration.targetConversationId, target.assistantId, target.workspaceId, target.cwd,
      registration.reason, registration.projectRoot, registration.rateLimit.maxCalls,
      registration.rateLimit.windowSeconds, registration.expiresAt, registration.tokenHash,
      registration.approvedAt, registration.lastTriggeredAt, registration.pausedAt,
      registration.revokedAt, now, registration.id,
    );
    if (result.changes === 0) throw registrationNotFound(registration.id);
    return this.requireRegistration(registration.id);
  }

  rateUsage(registration: AutomationRegistrationRecord): AutomationRateUsage {
    this.assertOpen();
    const now = this.now();
    const cutoff = new Date(now.getTime() - registration.rateLimit.windowSeconds * 1000).toISOString();
    const rows = this.database.prepare(`
      SELECT created_at FROM automation_turns
      WHERE registration_id = ? AND created_at > ?
      ORDER BY created_at ASC
    `).all(registration.id, cutoff) as Array<Record<string, unknown>>;
    const nextAllowedAt = rows.length >= registration.rateLimit.maxCalls
      ? new Date(Date.parse(String(rows[0]!.created_at)) + registration.rateLimit.windowSeconds * 1000).toISOString()
      : null;
    return {
      used: rows.length,
      limit: registration.rateLimit.maxCalls,
      windowSeconds: registration.rateLimit.windowSeconds,
      nextAllowedAt,
    };
  }

  createOrGetMessage(input: {
    messageId: string;
    registrationId: string;
    runId: string;
    conversationId: string;
    idempotencyKey: string;
  }): { message: AutomationMessage; created: boolean } {
    this.assertOpen();
    const existing = this.getMessageByIdempotencyKey(input.registrationId, input.runId, input.idempotencyKey);
    if (existing) return { message: existing, created: false };
    const now = this.timestamp();
    try {
      this.database.prepare(`
        INSERT INTO automation_messages (
          message_id, registration_id, run_id, conversation_id, idempotency_key, status,
          entry_id, error_code, error_message, created_at, completed_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, ?, NULL, ?)
      `).run(input.messageId, input.registrationId, input.runId, input.conversationId, input.idempotencyKey, now, now);
      return { message: this.requireMessage(input.messageId), created: true };
    } catch (error) {
      if (!isUniqueConstraint(error)) throw error;
      const concurrent = this.getMessageByIdempotencyKey(input.registrationId, input.runId, input.idempotencyKey);
      if (!concurrent) throw error;
      return { message: concurrent, created: false };
    }
  }

  getMessage(messageId: string): AutomationMessage | undefined {
    this.assertOpen();
    const row = this.database.prepare(`${MESSAGE_SELECT} WHERE message_id = ?`).get(messageId);
    return row ? messageFromRow(row) : undefined;
  }

  getMessageByIdempotencyKey(registrationId: string, runId: string, idempotencyKey: string): AutomationMessage | undefined {
    this.assertOpen();
    const row = this.database.prepare(`
      ${MESSAGE_SELECT} WHERE registration_id = ? AND run_id = ? AND idempotency_key = ?
    `).get(registrationId, runId, idempotencyKey);
    return row ? messageFromRow(row) : undefined;
  }

  markMessageSucceeded(messageId: string, entryId: string): AutomationMessage {
    return this.transitionMessage(messageId, "succeeded", { entryId });
  }

  markMessageFailed(messageId: string, error: { code: string; message: string }): AutomationMessage {
    return this.transitionMessage(messageId, "failed", { errorCode: error.code, errorMessage: error.message });
  }

  acceptTurn(input: {
    turnId: string;
    registrationId: string;
    runId: string;
    conversationId: string;
    idempotencyKey: string;
    expectedTokenHash: string;
  }): { turn: AutomationTurn; created: boolean } {
    this.assertOpen();
    this.expireRegistration(input.registrationId);
    let finished = false;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const registrationRow = this.database.prepare(`${REGISTRATION_SELECT} WHERE id = ?`).get(input.registrationId);
      if (!registrationRow) throw new RequestError("automation_unauthorized", "Invalid automation credential", { httpStatus: 401 });
      const registration = registrationFromRow(registrationRow);
      if (registration.tokenHash !== input.expectedTokenHash) {
        throw new RequestError("automation_unauthorized", "Invalid automation credential", { httpStatus: 401 });
      }
      this.assertRegistrationUsable(registration);

      const existingRow = this.database.prepare(`${TURN_SELECT} WHERE registration_id = ? AND idempotency_key = ?`)
        .get(input.registrationId, input.idempotencyKey);
      if (existingRow) {
        this.database.exec("COMMIT");
        finished = true;
        return { turn: turnFromRow(existingRow), created: false };
      }
      if (registration.target.kind !== "new" || registration.target.mode !== "per-run") {
        if (registration.targetConversationId !== input.conversationId) {
          throw new RequestError("automation_scope_mismatch", "Automation cannot use a different conversation", { httpStatus: 403 });
        }
      } else if (input.conversationId !== "") {
        throw new RequestError("automation_scope_mismatch", "Automation cannot use a different conversation", { httpStatus: 403 });
      }

      const now = this.timestamp();
      const cutoff = new Date(this.now().getTime() - registration.rateLimit.windowSeconds * 1000).toISOString();
      const accepted = this.database.prepare(`
        SELECT created_at FROM automation_turns
        WHERE registration_id = ? AND created_at > ?
        ORDER BY created_at ASC
      `).all(input.registrationId, cutoff) as Array<Record<string, unknown>>;
      if (accepted.length >= registration.rateLimit.maxCalls) {
        const nextAllowedAt = new Date(
          Date.parse(String(accepted[0]!.created_at)) + registration.rateLimit.windowSeconds * 1000,
        ).toISOString();
        throw new RequestError("automation_rate_limited", "Automation has reached its AI usage limit", {
          httpStatus: 429,
          limit: registration.rateLimit.maxCalls,
          used: accepted.length,
          nextAllowedAt,
        });
      }

      this.database.prepare(`
        INSERT INTO automation_turns (
          turn_id, registration_id, run_id, conversation_id, idempotency_key, status,
          final_leaf_id, assistant_text, error_code, error_message,
          created_at, started_at, completed_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'queued', NULL, NULL, NULL, NULL, ?, NULL, NULL, ?)
      `).run(input.turnId, input.registrationId, input.runId, input.conversationId, input.idempotencyKey, now, now);
      this.database.prepare(`
        UPDATE automation_registrations SET last_triggered_at = ?, updated_at = ? WHERE id = ?
      `).run(now, now, input.registrationId);
      const turn = this.requireTurn(input.turnId);
      this.database.exec("COMMIT");
      finished = true;
      return { turn, created: true };
    } finally {
      if (!finished) this.database.exec("ROLLBACK");
    }
  }

  getTurn(turnId: string): AutomationTurn | undefined {
    this.assertOpen();
    const row = this.database.prepare(`${TURN_SELECT} WHERE turn_id = ?`).get(turnId);
    return row ? turnFromRow(row) : undefined;
  }

  assignTurnConversation(turnId: string, conversationId: string): AutomationTurn {
    this.assertOpen();
    const now = this.timestamp();
    const result = this.database.prepare(`
      UPDATE automation_turns SET conversation_id = ?, updated_at = ?
      WHERE turn_id = ? AND status = 'queued' AND conversation_id = ''
    `).run(conversationId, now, turnId);
    if (result.changes === 0) {
      const current = this.getTurn(turnId);
      if (!current) throw new RequestError("automation_turn_not_found", `Automation turn not found: ${turnId}`);
      throw new RequestError("automation_turn_state_conflict", "Automation turn already has a conversation");
    }
    return this.requireTurn(turnId);
  }

  getTurnByIdempotencyKey(registrationId: string, idempotencyKey: string): AutomationTurn | undefined {
    this.assertOpen();
    const row = this.database.prepare(`${TURN_SELECT} WHERE registration_id = ? AND idempotency_key = ?`)
      .get(registrationId, idempotencyKey);
    return row ? turnFromRow(row) : undefined;
  }

  markRunning(turnId: string): AutomationTurn {
    return this.transition(turnId, ["queued"], "running", { startedAt: this.timestamp() });
  }

  markSucceeded(turnId: string, result: { finalLeafId: string; assistantText: string }): AutomationTurn {
    return this.transition(turnId, ["running"], "succeeded", {
      finalLeafId: result.finalLeafId, assistantText: result.assistantText, completedAt: this.timestamp(),
    });
  }

  markFailed(turnId: string, error: { code: string; message: string }): AutomationTurn {
    return this.transition(turnId, ACTIVE_TURN_STATUSES, "failed", {
      errorCode: error.code, errorMessage: error.message, completedAt: this.timestamp(),
    });
  }

  markCancelled(turnId: string): AutomationTurn {
    return this.transition(turnId, ACTIVE_TURN_STATUSES, "cancelled", { completedAt: this.timestamp() });
  }

  markInterrupted(turnId: string): AutomationTurn {
    return this.transition(turnId, ACTIVE_TURN_STATUSES, "interrupted", {
      errorCode: "runtime_interrupted", errorMessage: "Runtime stopped before the automation turn completed",
      completedAt: this.timestamp(),
    });
  }

  interruptActiveTurns(): number {
    this.assertOpen();
    const now = this.timestamp();
    return Number(this.database.prepare(`
      UPDATE automation_turns
      SET status = 'interrupted', error_code = 'runtime_interrupted',
          error_message = 'Runtime stopped before the automation turn completed',
          completed_at = ?, updated_at = ?
      WHERE status IN ('queued', 'running')
    `).run(now, now).changes);
  }

  private assertRegistrationUsable(registration: AutomationRegistrationRecord): void {
    const now = this.timestamp();
    if (registration.status === "revoked") {
      throw new RequestError("automation_revoked", "This automation has been stopped", { httpStatus: 403 });
    }
    if (registration.status === "paused") {
      throw new RequestError("automation_paused", "This automation is paused", { httpStatus: 403 });
    }
    if (registration.status === "pending") {
      throw new RequestError("automation_not_approved", "This automation has not been enabled", { httpStatus: 403 });
    }
    if (registration.status === "expired" || registration.expiresAt <= now) {
      throw new RequestError("automation_registration_expired", "This automation has expired", { httpStatus: 403 });
    }
    if (registration.status !== "active" || (registration.target.kind !== "new" || registration.target.mode !== "per-run") && !registration.targetConversationId) {
      throw new RequestError("automation_not_approved", "This automation is not active", { httpStatus: 403 });
    }
  }

  private transition(
    turnId: string,
    from: AutomationTurnStatus[],
    status: AutomationTurnStatus,
    values: {
      finalLeafId?: string; assistantText?: string; errorCode?: string; errorMessage?: string;
      startedAt?: string; completedAt?: string;
    },
  ): AutomationTurn {
    this.assertOpen();
    const now = this.timestamp();
    const placeholders = from.map(() => "?").join(", ");
    const result = this.database.prepare(`
      UPDATE automation_turns SET
        status = ?, final_leaf_id = COALESCE(?, final_leaf_id), assistant_text = COALESCE(?, assistant_text),
        error_code = COALESCE(?, error_code), error_message = COALESCE(?, error_message),
        started_at = COALESCE(?, started_at), completed_at = COALESCE(?, completed_at), updated_at = ?
      WHERE turn_id = ? AND status IN (${placeholders})
    `).run(
      status, values.finalLeafId ?? null, values.assistantText ?? null, values.errorCode ?? null,
      values.errorMessage ?? null, values.startedAt ?? null, values.completedAt ?? null,
      now, turnId, ...from,
    );
    if (result.changes === 0) {
      const current = this.getTurn(turnId);
      if (!current) throw new RequestError("automation_turn_not_found", `Automation turn not found: ${turnId}`);
      throw new RequestError("automation_turn_state_conflict", `Automation turn is already ${current.status}`);
    }
    return this.requireTurn(turnId);
  }

  private transitionMessage(
    messageId: string,
    status: Exclude<AutomationMessageStatus, "pending">,
    values: { entryId?: string; errorCode?: string; errorMessage?: string },
  ): AutomationMessage {
    this.assertOpen();
    const now = this.timestamp();
    const result = this.database.prepare(`
      UPDATE automation_messages SET status = ?, entry_id = COALESCE(?, entry_id),
        error_code = COALESCE(?, error_code), error_message = COALESCE(?, error_message),
        completed_at = ?, updated_at = ?
      WHERE message_id = ? AND status = 'pending'
    `).run(status, values.entryId ?? null, values.errorCode ?? null, values.errorMessage ?? null, now, now, messageId);
    if (result.changes === 0) {
      const current = this.getMessage(messageId);
      if (!current) throw new RequestError("automation_message_not_found", `Automation message not found: ${messageId}`);
      throw new RequestError("automation_message_state_conflict", `Automation message is already ${current.status}`);
    }
    return this.requireMessage(messageId);
  }

  private expireRegistrations(): void {
    const now = this.timestamp();
    this.database.prepare(`
      UPDATE automation_registrations SET status = 'expired', updated_at = ?
      WHERE status IN ('active', 'paused') AND expires_at <= ?
    `).run(now, now);
  }

  private expireRegistration(id: string): void {
    const now = this.timestamp();
    this.database.prepare(`
      UPDATE automation_registrations SET status = 'expired', token_hash = NULL, updated_at = ?
      WHERE id = ? AND status IN ('active', 'paused') AND expires_at <= ?
    `).run(now, id, now);
  }

  private requireRegistration(id: string): AutomationRegistrationRecord {
    const registration = this.getRegistration(id);
    if (!registration) throw registrationNotFound(id);
    return registration;
  }

  private requireTurn(turnId: string): AutomationTurn {
    const turn = this.getTurn(turnId);
    if (!turn) throw new RequestError("automation_turn_not_found", `Automation turn not found: ${turnId}`);
    return turn;
  }

  private requireMessage(messageId: string): AutomationMessage {
    const message = this.getMessage(messageId);
    if (!message) throw new RequestError("automation_message_not_found", `Automation message not found: ${messageId}`);
    return message;
  }

  private initializeSchema(): void {
    const versionRow = this.database.prepare("PRAGMA user_version").get();
    const version = Number(versionRow?.user_version ?? 0);
    if (version > SCHEMA_VERSION) {
      this.close();
      throw new RequestError("automation_schema_too_new", `Unsupported automation schema: ${version}`);
    }
    if (version === 0) {
      this.database.exec(`BEGIN IMMEDIATE; ${CREATE_SCHEMA_SQL} PRAGMA user_version = 3; COMMIT;`);
      return;
    }
    if (version < 3) this.replaceDevelopmentSchema();
  }

  private replaceDevelopmentSchema(): void {
    this.database.exec("PRAGMA foreign_keys = OFF");
    try {
      this.database.exec(`
        BEGIN IMMEDIATE;
        DROP TABLE IF EXISTS automation_messages;
        DROP TABLE IF EXISTS automation_turns;
        DROP TABLE IF EXISTS automation_bindings;
        DROP TABLE IF EXISTS automation_registrations;
        ${CREATE_SCHEMA_SQL}
        PRAGMA user_version = 3;
        COMMIT;
      `);
    } finally {
      this.database.exec("PRAGMA foreign_keys = ON");
    }
  }

  private timestamp(): string { return this.now().toISOString(); }

  private assertOpen(): void {
    if (this.closed) throw new RequestError("automation_store_closed", "Automation turn store is closed");
  }
}

const CREATE_SCHEMA_SQL = `
  CREATE TABLE automation_registrations (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'paused', 'expired', 'revoked')),
    applicant_conversation_id TEXT NOT NULL,
    target_kind TEXT NOT NULL CHECK (target_kind IN ('existing', 'new')),
    target_mode TEXT CHECK (target_mode IN ('dedicated', 'per-run')),
    target_conversation_id TEXT,
    target_assistant_id TEXT,
    target_workspace_id TEXT,
    target_cwd TEXT,
    reason TEXT NOT NULL,
    project_root TEXT NOT NULL,
    rate_max_calls INTEGER NOT NULL CHECK (rate_max_calls > 0),
    rate_window_seconds INTEGER NOT NULL CHECK (rate_window_seconds > 0),
    expires_at TEXT NOT NULL,
    token_hash TEXT,
    created_at TEXT NOT NULL,
    approved_at TEXT,
    last_triggered_at TEXT,
    paused_at TEXT,
    revoked_at TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE automation_turns (
    turn_id TEXT PRIMARY KEY,
    registration_id TEXT NOT NULL REFERENCES automation_registrations(id),
    run_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted')),
    final_leaf_id TEXT,
    assistant_text TEXT,
    error_code TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    updated_at TEXT NOT NULL,
    UNIQUE (registration_id, idempotency_key)
  );
  CREATE INDEX automation_turns_registration_created ON automation_turns(registration_id, created_at DESC);
  CREATE TABLE automation_messages (
    message_id TEXT PRIMARY KEY,
    registration_id TEXT NOT NULL REFERENCES automation_registrations(id),
    run_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed')),
    entry_id TEXT,
    error_code TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL,
    completed_at TEXT,
    updated_at TEXT NOT NULL,
    UNIQUE (registration_id, run_id, idempotency_key)
  );
  CREATE INDEX automation_messages_registration_created ON automation_messages(registration_id, created_at DESC);
`;

const REGISTRATION_SELECT = `
  SELECT id, title, status, applicant_conversation_id, target_kind, target_mode, target_conversation_id,
    target_assistant_id, target_workspace_id, target_cwd, reason, project_root,
    rate_max_calls, rate_window_seconds, expires_at, token_hash,
    created_at, approved_at, last_triggered_at, paused_at, revoked_at, updated_at
  FROM automation_registrations
`;

const TURN_SELECT = `
  SELECT turn_id, registration_id, run_id, conversation_id, idempotency_key, status,
    final_leaf_id, assistant_text, error_code, error_message,
    created_at, started_at, completed_at, updated_at
  FROM automation_turns
`;

const MESSAGE_SELECT = `
  SELECT message_id, registration_id, run_id, conversation_id, idempotency_key, status,
    entry_id, error_code, error_message, created_at, completed_at, updated_at
  FROM automation_messages
`;

function registrationFromRow(row: Record<string, unknown>): AutomationRegistrationRecord {
  const target: AutomationConversationTarget = String(row.target_kind) === "new"
    ? {
        kind: "new",
        mode: String(row.target_mode) === "per-run" ? "per-run" : "dedicated",
        assistantId: String(row.target_assistant_id ?? ""),
        workspaceId: nullableString(row.target_workspace_id),
        cwd: nullableString(row.target_cwd),
      }
    : { kind: "existing", conversationId: String(row.target_conversation_id ?? "") };
  return {
    id: String(row.id),
    title: String(row.title),
    status: String(row.status) as AutomationRegistrationStatus,
    applicantConversationId: String(row.applicant_conversation_id),
    targetConversationId: nullableString(row.target_conversation_id),
    target,
    reason: String(row.reason),
    projectRoot: String(row.project_root),
    rateLimit: { maxCalls: Number(row.rate_max_calls), windowSeconds: Number(row.rate_window_seconds) },
    expiresAt: String(row.expires_at),
    tokenHash: nullableString(row.token_hash),
    createdAt: String(row.created_at),
    approvedAt: nullableString(row.approved_at),
    lastTriggeredAt: nullableString(row.last_triggered_at),
    pausedAt: nullableString(row.paused_at),
    revokedAt: nullableString(row.revoked_at),
    updatedAt: String(row.updated_at),
  };
}

function turnFromRow(row: Record<string, unknown>): AutomationTurn {
  return {
    turnId: String(row.turn_id), registrationId: String(row.registration_id), runId: String(row.run_id),
    conversationId: String(row.conversation_id), idempotencyKey: String(row.idempotency_key),
    status: String(row.status) as AutomationTurnStatus, finalLeafId: nullableString(row.final_leaf_id),
    assistantText: nullableString(row.assistant_text), errorCode: nullableString(row.error_code),
    errorMessage: nullableString(row.error_message), createdAt: String(row.created_at),
    startedAt: nullableString(row.started_at), completedAt: nullableString(row.completed_at),
    updatedAt: String(row.updated_at),
  };
}

function messageFromRow(row: Record<string, unknown>): AutomationMessage {
  return {
    messageId: String(row.message_id), registrationId: String(row.registration_id), runId: String(row.run_id),
    conversationId: String(row.conversation_id), idempotencyKey: String(row.idempotency_key),
    status: String(row.status) as AutomationMessageStatus, entryId: nullableString(row.entry_id),
    errorCode: nullableString(row.error_code), errorMessage: nullableString(row.error_message),
    createdAt: String(row.created_at), completedAt: nullableString(row.completed_at), updatedAt: String(row.updated_at),
  };
}

function targetColumns(target: AutomationConversationTarget): {
  kind: string; mode: string | null; conversationId: string | null; assistantId: string | null; workspaceId: string | null; cwd: string | null;
} {
  return target.kind === "existing"
    ? { kind: "existing", mode: null, conversationId: target.conversationId, assistantId: null, workspaceId: null, cwd: null }
    : { kind: "new", mode: target.mode, conversationId: null, assistantId: target.assistantId, workspaceId: target.workspaceId, cwd: target.cwd };
}

function registrationNotFound(id: string): RequestError {
  return new RequestError("automation_registration_not_found", `Automation not found: ${id}`, { httpStatus: 404 });
}

function validateDatabasePath(path: string): string {
  if (path === ":memory:") return path;
  if (typeof path !== "string" || path.trim() === "" || !isAbsolute(path)) {
    throw new RequestError("invalid_automation_database_path", "Automation database path must be absolute");
  }
  return path;
}

function boundedInteger(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RequestError("invalid_payload", `${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function nullableString(value: unknown): string | null { return value === null || value === undefined ? null : String(value); }
function isUniqueConstraint(error: unknown): boolean { return error instanceof Error && error.message.includes("UNIQUE constraint failed"); }
