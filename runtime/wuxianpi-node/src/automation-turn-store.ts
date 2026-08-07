import { mkdirSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RequestError } from "./protocol.js";
import type {
  AutomationBindingRecord,
  AutomationMessage,
  AutomationMessageStatus,
  AutomationTurn,
  AutomationTurnStatus,
} from "./automation-turn-types.js";

const SCHEMA_VERSION = 2;
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

  createBinding(input: {
    taskId: string;
    conversationId: string;
    taskRoot: string;
    tokenHash: string;
  }): AutomationBindingRecord {
    this.assertOpen();
    const now = this.timestamp();
    try {
      this.database.prepare(`
        INSERT INTO automation_bindings (
          task_id, conversation_id, task_root, token_hash, revoked_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, NULL, ?, ?)
      `).run(input.taskId, input.conversationId, input.taskRoot, input.tokenHash, now, now);
    } catch (error) {
      if (isUniqueConstraint(error)) {
        throw new RequestError("automation_binding_conflict", `Automation binding already exists: ${input.taskId}`);
      }
      throw error;
    }
    return this.requireBinding(input.taskId);
  }

  getBinding(taskId: string): AutomationBindingRecord | undefined {
    this.assertOpen();
    const row = this.database.prepare(`
      SELECT task_id, conversation_id, task_root, token_hash, revoked_at, created_at, updated_at
      FROM automation_bindings WHERE task_id = ?
    `).get(taskId);
    return row ? bindingFromRow(row) : undefined;
  }

  revokeBinding(taskId: string): AutomationBindingRecord {
    this.assertOpen();
    const binding = this.requireBinding(taskId);
    if (binding.revokedAt) return binding;
    const now = this.timestamp();
    this.database.prepare(`
      UPDATE automation_bindings SET revoked_at = ?, updated_at = ? WHERE task_id = ?
    `).run(now, now, taskId);
    return this.requireBinding(taskId);
  }

  createOrGetMessage(input: {
    messageId: string;
    taskId: string;
    runId: string;
    conversationId: string;
    idempotencyKey: string;
  }): { message: AutomationMessage; created: boolean } {
    this.assertOpen();
    const existing = this.getMessageByIdempotencyKey(input.taskId, input.runId, input.idempotencyKey);
    if (existing) return { message: existing, created: false };
    const now = this.timestamp();
    try {
      this.database.prepare(`
        INSERT INTO automation_messages (
          message_id, task_id, run_id, conversation_id, idempotency_key, status,
          entry_id, error_code, error_message, created_at, completed_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, ?, NULL, ?)
      `).run(input.messageId, input.taskId, input.runId, input.conversationId, input.idempotencyKey, now, now);
      return { message: this.requireMessage(input.messageId), created: true };
    } catch (error) {
      if (!isUniqueConstraint(error)) throw error;
      const concurrent = this.getMessageByIdempotencyKey(input.taskId, input.runId, input.idempotencyKey);
      if (!concurrent) throw error;
      return { message: concurrent, created: false };
    }
  }

  getMessage(messageId: string): AutomationMessage | undefined {
    this.assertOpen();
    const row = this.database.prepare(`${MESSAGE_SELECT} WHERE message_id = ?`).get(messageId);
    return row ? messageFromRow(row) : undefined;
  }

  getMessageByIdempotencyKey(taskId: string, runId: string, idempotencyKey: string): AutomationMessage | undefined {
    this.assertOpen();
    const row = this.database.prepare(`
      ${MESSAGE_SELECT} WHERE task_id = ? AND run_id = ? AND idempotency_key = ?
    `).get(taskId, runId, idempotencyKey);
    return row ? messageFromRow(row) : undefined;
  }

  markMessageSucceeded(messageId: string, entryId: string): AutomationMessage {
    return this.transitionMessage(messageId, "succeeded", { entryId });
  }

  markMessageFailed(messageId: string, error: { code: string; message: string }): AutomationMessage {
    return this.transitionMessage(messageId, "failed", {
      errorCode: error.code,
      errorMessage: error.message,
    });
  }

  createOrGetTurn(input: {
    turnId: string;
    taskId: string;
    runId: string;
    conversationId: string;
    idempotencyKey: string;
  }): { turn: AutomationTurn; created: boolean } {
    this.assertOpen();
    const existing = this.getTurnByIdempotencyKey(input.taskId, input.idempotencyKey);
    if (existing) return { turn: existing, created: false };
    const now = this.timestamp();
    try {
      this.database.prepare(`
        INSERT INTO automation_turns (
          turn_id, task_id, run_id, conversation_id, idempotency_key, status,
          final_leaf_id, assistant_text, error_code, error_message,
          created_at, started_at, completed_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'queued', NULL, NULL, NULL, NULL, ?, NULL, NULL, ?)
      `).run(input.turnId, input.taskId, input.runId, input.conversationId, input.idempotencyKey, now, now);
      return { turn: this.requireTurn(input.turnId), created: true };
    } catch (error) {
      if (!isUniqueConstraint(error)) throw error;
      const concurrent = this.getTurnByIdempotencyKey(input.taskId, input.idempotencyKey);
      if (!concurrent) throw error;
      return { turn: concurrent, created: false };
    }
  }

  getTurn(turnId: string): AutomationTurn | undefined {
    this.assertOpen();
    const row = this.database.prepare(`${TURN_SELECT} WHERE turn_id = ?`).get(turnId);
    return row ? turnFromRow(row) : undefined;
  }

  getTurnByIdempotencyKey(taskId: string, idempotencyKey: string): AutomationTurn | undefined {
    this.assertOpen();
    const row = this.database.prepare(`${TURN_SELECT} WHERE task_id = ? AND idempotency_key = ?`)
      .get(taskId, idempotencyKey);
    return row ? turnFromRow(row) : undefined;
  }

  markRunning(turnId: string): AutomationTurn {
    return this.transition(turnId, ["queued"], "running", {
      startedAt: this.timestamp(),
    });
  }

  markSucceeded(turnId: string, result: { finalLeafId: string; assistantText: string }): AutomationTurn {
    return this.transition(turnId, ["running"], "succeeded", {
      finalLeafId: result.finalLeafId,
      assistantText: result.assistantText,
      completedAt: this.timestamp(),
    });
  }

  markFailed(turnId: string, error: { code: string; message: string }): AutomationTurn {
    return this.transition(turnId, ACTIVE_TURN_STATUSES, "failed", {
      errorCode: error.code,
      errorMessage: error.message,
      completedAt: this.timestamp(),
    });
  }

  markCancelled(turnId: string): AutomationTurn {
    return this.transition(turnId, ACTIVE_TURN_STATUSES, "cancelled", {
      completedAt: this.timestamp(),
    });
  }

  markInterrupted(turnId: string): AutomationTurn {
    return this.transition(turnId, ACTIVE_TURN_STATUSES, "interrupted", {
      errorCode: "runtime_interrupted",
      errorMessage: "Runtime stopped before the automation turn completed",
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

  private transition(
    turnId: string,
    from: AutomationTurnStatus[],
    status: AutomationTurnStatus,
    values: {
      finalLeafId?: string;
      assistantText?: string;
      errorCode?: string;
      errorMessage?: string;
      startedAt?: string;
      completedAt?: string;
    },
  ): AutomationTurn {
    this.assertOpen();
    const now = this.timestamp();
    const placeholders = from.map(() => "?").join(", ");
    const result = this.database.prepare(`
      UPDATE automation_turns SET
        status = ?, final_leaf_id = COALESCE(?, final_leaf_id),
        assistant_text = COALESCE(?, assistant_text),
        error_code = COALESCE(?, error_code), error_message = COALESCE(?, error_message),
        started_at = COALESCE(?, started_at), completed_at = COALESCE(?, completed_at), updated_at = ?
      WHERE turn_id = ? AND status IN (${placeholders})
    `).run(
      status,
      values.finalLeafId ?? null,
      values.assistantText ?? null,
      values.errorCode ?? null,
      values.errorMessage ?? null,
      values.startedAt ?? null,
      values.completedAt ?? null,
      now,
      turnId,
      ...from,
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
    `).run(
      status,
      values.entryId ?? null,
      values.errorCode ?? null,
      values.errorMessage ?? null,
      now,
      now,
      messageId,
    );
    if (result.changes === 0) {
      const current = this.getMessage(messageId);
      if (!current) throw new RequestError("automation_message_not_found", `Automation message not found: ${messageId}`);
      throw new RequestError("automation_message_state_conflict", `Automation message is already ${current.status}`);
    }
    return this.requireMessage(messageId);
  }

  private requireBinding(taskId: string): AutomationBindingRecord {
    const binding = this.getBinding(taskId);
    if (!binding) throw new RequestError("automation_binding_not_found", `Automation binding not found: ${taskId}`);
    return binding;
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
      this.database.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE automation_bindings (
        task_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        task_root TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        revoked_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE automation_turns (
        turn_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES automation_bindings(task_id),
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
        UNIQUE (task_id, idempotency_key)
      );
        CREATE INDEX automation_turns_task_created ON automation_turns(task_id, created_at DESC);
        ${CREATE_MESSAGES_SQL}
        PRAGMA user_version = 2;
        COMMIT;
      `);
      return;
    }
    if (version === 1) {
      this.database.exec(`
        BEGIN IMMEDIATE;
        ${CREATE_MESSAGES_SQL}
        PRAGMA user_version = 2;
        COMMIT;
      `);
    }
  }

  private timestamp(): string { return this.now().toISOString(); }
  private assertOpen(): void {
    if (this.closed) throw new RequestError("automation_store_closed", "Automation turn store is closed");
  }
}

const TURN_SELECT = `
  SELECT turn_id, task_id, run_id, conversation_id, idempotency_key, status,
         final_leaf_id, assistant_text, error_code, error_message,
         created_at, started_at, completed_at, updated_at
  FROM automation_turns
`;

const MESSAGE_SELECT = `
  SELECT message_id, task_id, run_id, conversation_id, idempotency_key, status,
         entry_id, error_code, error_message, created_at, completed_at, updated_at
  FROM automation_messages
`;

const CREATE_MESSAGES_SQL = `
  CREATE TABLE automation_messages (
    message_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES automation_bindings(task_id),
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
    UNIQUE (task_id, run_id, idempotency_key)
  );
  CREATE INDEX automation_messages_task_created ON automation_messages(task_id, created_at DESC);
`;

function bindingFromRow(row: Record<string, unknown>): AutomationBindingRecord {
  return {
    taskId: String(row.task_id),
    conversationId: String(row.conversation_id),
    taskRoot: String(row.task_root),
    tokenHash: String(row.token_hash),
    revokedAt: nullableString(row.revoked_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function turnFromRow(row: Record<string, unknown>): AutomationTurn {
  return {
    turnId: String(row.turn_id),
    taskId: String(row.task_id),
    runId: String(row.run_id),
    conversationId: String(row.conversation_id),
    idempotencyKey: String(row.idempotency_key),
    status: String(row.status) as AutomationTurnStatus,
    finalLeafId: nullableString(row.final_leaf_id),
    assistantText: nullableString(row.assistant_text),
    errorCode: nullableString(row.error_code),
    errorMessage: nullableString(row.error_message),
    createdAt: String(row.created_at),
    startedAt: nullableString(row.started_at),
    completedAt: nullableString(row.completed_at),
    updatedAt: String(row.updated_at),
  };
}

function messageFromRow(row: Record<string, unknown>): AutomationMessage {
  return {
    messageId: String(row.message_id),
    taskId: String(row.task_id),
    runId: String(row.run_id),
    conversationId: String(row.conversation_id),
    idempotencyKey: String(row.idempotency_key),
    status: String(row.status) as AutomationMessageStatus,
    entryId: nullableString(row.entry_id),
    errorCode: nullableString(row.error_code),
    errorMessage: nullableString(row.error_message),
    createdAt: String(row.created_at),
    completedAt: nullableString(row.completed_at),
    updatedAt: String(row.updated_at),
  };
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function validateDatabasePath(path: string): string {
  if (path === ":memory:") return path;
  if (!isAbsolute(path)) throw new RequestError("invalid_automation_database_path", "Automation database path must be absolute");
  return path;
}

function boundedInteger(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RequestError("invalid_automation_store_option", `${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function isUniqueConstraint(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message);
}
