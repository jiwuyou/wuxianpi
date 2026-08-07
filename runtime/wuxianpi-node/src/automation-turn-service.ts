import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { RequestError } from "./protocol.js";
import { AutomationTurnStore } from "./automation-turn-store.js";
import type {
  AutomationBinding,
  AutomationBindingRecord,
  AutomationIdempotentMessageContext,
  AutomationMessage,
  AutomationMessageContext,
  AutomationSessionRegistry,
  AutomationTurn,
  AutomationTurnContext,
} from "./automation-turn-types.js";
import { publicBinding } from "./automation-turn-types.js";

const SAFE_TASK_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const MAX_CONTEXT_ID_LENGTH = 512;
const MAX_MESSAGE_LENGTH = 1_000_000;
const MAX_ARTIFACT_REFS = 256;
const SHUTDOWN_TIMEOUT_MS = 5_000;
const TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled", "interrupted"]);

interface ActiveExecution {
  controller: AbortController;
  promise: Promise<void>;
}

export class AutomationTurnService {
  readonly interruptedAtStartup: number;
  private readonly active = new Map<string, ActiveExecution>();
  private readonly activeMessages = new Map<string, Promise<AutomationMessage>>();
  private readonly releaseOwnership: (() => void) | undefined;
  private closing = false;
  private storeClosed = false;
  private closePromise: Promise<void> | undefined;

  constructor(
    private readonly store: AutomationTurnStore,
    private readonly registry: AutomationSessionRegistry,
  ) {
    if (store.path !== ":memory:") {
      try {
        this.releaseOwnership = lockfile.lockSync(store.path, {
          lockfilePath: `${store.path}.runtime.lock`,
          realpath: false,
          stale: 300_000,
          update: 30_000,
          retries: 0,
        });
      } catch {
        store.close();
        throw new RequestError("automation_runtime_owned", "Another WuxianPi Runtime owns the automation database", { httpStatus: 409 });
      }
    }
    try {
      this.interruptedAtStartup = this.store.interruptActiveTurns();
    } catch (error) {
      this.releaseOwnership?.();
      this.store.close();
      throw error;
    }
  }

  async createBinding(input: {
    taskId: string;
    conversationId: string;
    taskRoot: string;
  }): Promise<{ binding: AutomationBinding; taskToken: string }> {
    this.assertAvailable();
    const taskId = validateTaskId(input.taskId);
    const conversationId = validateContextId(input.conversationId, "conversationId");
    const taskRoot = await canonicalDirectory(input.taskRoot, "taskRoot");
    await this.registry.assertAutomationConversation(conversationId);
    this.assertAvailable();
    const taskToken = randomBytes(32).toString("base64url");
    const binding = this.store.createBinding({
      taskId,
      conversationId,
      taskRoot,
      tokenHash: hashToken(taskToken),
    });
    return { binding: publicBinding(binding), taskToken };
  }

  revokeBinding(taskId: string): AutomationBinding {
    this.assertAvailable();
    const binding = this.store.revokeBinding(validateTaskId(taskId));
    for (const [turnId, execution] of this.active) {
      const turn = this.store.getTurn(turnId);
      if (turn?.taskId === taskId) execution.controller.abort();
    }
    return publicBinding(binding);
  }

  async appendMessage(input: {
    taskToken: string;
    taskId: string;
    runId: string;
    conversationId?: string;
    message: string;
    artifactRefs?: unknown;
    idempotencyKey: string;
  }): Promise<{ message: AutomationMessage; artifactRefs: string[]; created: boolean }> {
    this.assertAvailable();
    const binding = this.authorizeTask(input.taskId, input.taskToken, input.conversationId);
    const context: AutomationIdempotentMessageContext = {
      ...(await this.messageContext(binding, input)),
      idempotencyKey: validateContextId(input.idempotencyKey, "idempotencyKey"),
    };
    this.assertAvailable();
    const result = this.store.createOrGetMessage({
      messageId: randomUUID(),
      taskId: context.taskId,
      runId: context.runId,
      conversationId: context.conversationId,
      idempotencyKey: context.idempotencyKey,
    });
    if (!result.created) {
      const active = this.activeMessages.get(result.message.messageId);
      if (active) return { message: await active, artifactRefs: context.artifactRefs, created: false };
      if (result.message.status === "failed") throw failedMessageRetry(result.message);
      if (result.message.status === "pending") throw pendingMessageRetry(result.message);
      return { message: result.message, artifactRefs: context.artifactRefs, created: false };
    }
    const operation = this.appendMessageOnce(result.message.messageId, context);
    this.activeMessages.set(result.message.messageId, operation);
    try {
      return {
        message: await operation,
        artifactRefs: context.artifactRefs,
        created: true,
      };
    } finally {
      if (this.activeMessages.get(result.message.messageId) === operation) {
        this.activeMessages.delete(result.message.messageId);
      }
    }
  }

  async triggerTurn(input: {
    taskToken: string;
    taskId: string;
    runId: string;
    conversationId?: string;
    message: string;
    artifactRefs?: unknown;
    idempotencyKey: string;
  }): Promise<AutomationTurn> {
    this.assertAvailable();
    const binding = this.authorizeTask(input.taskId, input.taskToken, input.conversationId);
    const context: AutomationTurnContext = {
      ...(await this.messageContext(binding, input)),
      idempotencyKey: validateContextId(input.idempotencyKey, "idempotencyKey"),
    };
    this.assertAvailable();
    const result = this.store.createOrGetTurn({
      turnId: randomUUID(),
      taskId: context.taskId,
      runId: context.runId,
      conversationId: context.conversationId,
      idempotencyKey: context.idempotencyKey,
    });
    if (result.created) this.startExecution(result.turn.turnId, context);
    return result.turn;
  }

  async getTurn(turnId: string, taskToken: string, waitMs = 0): Promise<AutomationTurn> {
    this.assertAvailable();
    const initial = this.authorizedTurn(turnId, taskToken);
    const boundedWaitMs = boundedInteger(waitMs, "waitMs", 0, 30_000);
    if (boundedWaitMs === 0 || TERMINAL_STATUSES.has(initial.status)) return initial;
    const deadline = Date.now() + boundedWaitMs;
    let current = initial;
    while (Date.now() < deadline && !TERMINAL_STATUSES.has(current.status)) {
      await delay(Math.min(50, Math.max(1, deadline - Date.now())));
      this.assertAvailable();
      current = this.authorizedTurn(turnId, taskToken);
    }
    return current;
  }

  cancelTurn(turnId: string, taskToken: string): AutomationTurn {
    this.assertAvailable();
    const turn = this.authorizedTurn(turnId, taskToken);
    if (TERMINAL_STATUSES.has(turn.status)) {
      throw new RequestError("automation_turn_not_active", `Automation turn is already ${turn.status}`);
    }
    const cancelled = this.store.markCancelled(turnId);
    this.active.get(turnId)?.controller.abort();
    return cancelled;
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = this.closeInternal();
    return this.closePromise;
  }

  private async closeInternal(): Promise<void> {
    this.closing = true;
    for (const execution of this.active.values()) execution.controller.abort();
    const executions = Promise.allSettled([
      ...[...this.active.values()].map((execution) => execution.promise),
      ...this.activeMessages.values(),
    ]);
    await Promise.race([executions, delay(SHUTDOWN_TIMEOUT_MS)]);
    try {
      this.store.interruptActiveTurns();
    } finally {
      this.storeClosed = true;
      try { this.store.close(); } finally { this.releaseOwnership?.(); }
    }
  }

  private startExecution(turnId: string, context: AutomationTurnContext): void {
    const controller = new AbortController();
    const promise = this.execute(turnId, context, controller)
      .finally(() => this.active.delete(turnId));
    this.active.set(turnId, { controller, promise });
  }

  private async execute(turnId: string, context: AutomationTurnContext, controller: AbortController): Promise<void> {
    try {
      const result = await this.registry.runAutomationTurn({
        ...context,
        signal: controller.signal,
        onStarted: () => {
          if (this.closing || this.storeClosed || controller.signal.aborted) throw automationCancelled();
          this.store.markRunning(turnId);
        },
      });
      if (this.storeClosed) return;
      if (this.closing) this.tryMarkInterrupted(turnId);
      else if (controller.signal.aborted) this.tryMarkCancelled(turnId);
      else this.store.markSucceeded(turnId, result);
    } catch (error) {
      if (this.storeClosed) return;
      const current = this.store.getTurn(turnId);
      if (!current || TERMINAL_STATUSES.has(current.status)) return;
      if (this.closing) this.tryMarkInterrupted(turnId);
      else if (controller.signal.aborted) this.tryMarkCancelled(turnId);
      else this.store.markFailed(turnId, errorView(error));
    }
  }

  private async appendMessageOnce(
    messageId: string,
    context: AutomationIdempotentMessageContext,
  ): Promise<AutomationMessage> {
    try {
      const appended = await this.registry.appendAutomationMessage(context);
      this.assertAvailable();
      return this.store.markMessageSucceeded(messageId, appended.entryId);
    } catch (error) {
      if (!this.storeClosed) {
        try { this.store.markMessageFailed(messageId, errorView(error)); } catch (transitionError) {
          if (!isMessageStateConflict(transitionError)) throw transitionError;
        }
      }
      throw error;
    }
  }

  private tryMarkCancelled(turnId: string): void {
    try { this.store.markCancelled(turnId); } catch (error) {
      if (!isStateConflict(error)) throw error;
    }
  }

  private tryMarkInterrupted(turnId: string): void {
    try { this.store.markInterrupted(turnId); } catch (error) {
      if (!isStateConflict(error)) throw error;
    }
  }

  private authorizeTask(taskIdValue: string, taskToken: string, conversationId?: string): AutomationBindingRecord {
    const taskId = validateTaskId(taskIdValue);
    const binding = this.store.getBinding(taskId);
    if (!binding || binding.revokedAt || !tokenMatches(taskToken, binding.tokenHash)) {
      throw new RequestError("automation_unauthorized", "Invalid or revoked automation task token", { httpStatus: 401 });
    }
    if (conversationId !== undefined && conversationId !== binding.conversationId) {
      throw new RequestError("automation_scope_mismatch", "Task token is not valid for this conversation", { httpStatus: 403 });
    }
    return binding;
  }

  private authorizedTurn(turnIdValue: string, taskToken: string): AutomationTurn {
    const turnId = validateContextId(turnIdValue, "turnId");
    const turn = this.store.getTurn(turnId);
    if (!turn) throw new RequestError("automation_turn_not_found", `Automation turn not found: ${turnId}`);
    this.authorizeTask(turn.taskId, taskToken, turn.conversationId);
    return turn;
  }

  private async messageContext(
    binding: AutomationBindingRecord,
    input: { runId: string; message: string; artifactRefs?: unknown },
  ): Promise<AutomationMessageContext> {
    const message = validateMessage(input.message);
    const artifactRefs = await canonicalArtifactRefs(binding.taskRoot, input.artifactRefs);
    return {
      taskId: binding.taskId,
      runId: validateContextId(input.runId, "runId"),
      conversationId: binding.conversationId,
      message,
      artifactRefs,
    };
  }

  private assertAvailable(): void {
    if (this.closing || this.storeClosed) throw new RequestError("automation_service_stopping", "Automation Turn Bridge is stopping", { httpStatus: 503 });
  }
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function tokenMatches(token: string, expectedHash: string): boolean {
  if (typeof token !== "string" || token.length === 0) return false;
  const actual = Buffer.from(hashToken(token), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function canonicalArtifactRefs(taskRoot: string, value: unknown): Promise<string[]> {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_ARTIFACT_REFS || value.some((item) => typeof item !== "string" || !item)) {
    throw new RequestError("invalid_artifact_refs", `artifactRefs must contain at most ${MAX_ARTIFACT_REFS} non-empty paths`);
  }
  const result: string[] = [];
  for (const reference of value as string[]) {
    const candidate = isAbsolute(reference) ? reference : resolve(taskRoot, reference);
    let canonical: string;
    try { canonical = await realpath(candidate); }
    catch { throw new RequestError("artifact_not_found", `Artifact does not exist: ${reference}`); }
    if (!insideOrEqual(taskRoot, canonical)) {
      throw new RequestError("artifact_outside_task_root", `Artifact escapes the bound task root: ${reference}`, { httpStatus: 403 });
    }
    const metadata = await stat(canonical);
    if (!metadata.isFile()) throw new RequestError("invalid_artifact", `Artifact must be a file: ${reference}`);
    result.push(canonical);
  }
  return result;
}

async function canonicalDirectory(value: string, name: string): Promise<string> {
  if (typeof value !== "string" || value.trim() === "") throw new RequestError("invalid_payload", `${name} must be a non-empty path`);
  let canonical: string;
  try { canonical = await realpath(resolve(value)); }
  catch { throw new RequestError("automation_task_root_not_found", `${name} does not exist`); }
  if (!(await stat(canonical)).isDirectory()) throw new RequestError("invalid_automation_task_root", `${name} must be a directory`);
  return canonical;
}

function insideOrEqual(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function validateTaskId(value: string): string {
  if (typeof value !== "string" || !SAFE_TASK_ID.test(value)) {
    throw new RequestError("invalid_task_id", "taskId must use 1-128 letters, numbers, dots, underscores, or hyphens");
  }
  return value;
}

function validateContextId(value: string, name: string): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > MAX_CONTEXT_ID_LENGTH) {
    throw new RequestError("invalid_payload", `${name} must be a non-empty string no longer than ${MAX_CONTEXT_ID_LENGTH} characters`);
  }
  return value;
}

function validateMessage(value: string): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > MAX_MESSAGE_LENGTH) {
    throw new RequestError("invalid_payload", `message must be a non-empty string no longer than ${MAX_MESSAGE_LENGTH} characters`);
  }
  return value;
}

function boundedInteger(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RequestError("invalid_payload", `${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function errorView(error: unknown): { code: string; message: string } {
  return {
    code: error instanceof RequestError ? error.code : "automation_turn_failed",
    message: error instanceof Error ? error.message : String(error),
  };
}

function automationCancelled(): RequestError {
  return new RequestError("automation_turn_cancelled", "Automation turn was cancelled");
}

function isStateConflict(error: unknown): boolean {
  return error instanceof RequestError && error.code === "automation_turn_state_conflict";
}

function isMessageStateConflict(error: unknown): boolean {
  return error instanceof RequestError && error.code === "automation_message_state_conflict";
}

function failedMessageRetry(message: AutomationMessage): RequestError {
  return new RequestError(
    "automation_message_failed",
    `Automation message ${message.messageId} already failed and will not be appended again`,
    {
      httpStatus: 409,
      messageId: message.messageId,
      originalError: {
        code: message.errorCode,
        message: message.errorMessage,
      },
    },
  );
}

function pendingMessageRetry(message: AutomationMessage): RequestError {
  return new RequestError(
    "automation_message_outcome_unknown",
    `Automation message ${message.messageId} has an unknown outcome and will not be appended again`,
    { httpStatus: 409, messageId: message.messageId },
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
