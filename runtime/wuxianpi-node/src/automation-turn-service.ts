import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { RequestError } from "./protocol.js";
import { AutomationTurnStore } from "./automation-turn-store.js";
import type {
  AutomationConversationTarget,
  AutomationIdempotentMessageContext,
  AutomationMessage,
  AutomationMessageContext,
  AutomationRateLimit,
  AutomationRegistration,
  AutomationRegistrationRecord,
  AutomationSessionRegistry,
  AutomationTurn,
  AutomationTurnContext,
} from "./automation-turn-types.js";
import { publicRegistration } from "./automation-turn-types.js";

const SAFE_REGISTRATION_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const MAX_CONTEXT_ID_LENGTH = 512;
const MAX_TEXT_LENGTH = 1_000_000;
const MAX_ARTIFACT_REFS = 256;
const MAX_RATE_CALLS = 100_000;
const MAX_WINDOW_SECONDS = 366 * 24 * 60 * 60;
const SHUTDOWN_TIMEOUT_MS = 5_000;
const TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled", "interrupted"]);

interface ActiveExecution {
  controller: AbortController;
  promise: Promise<void>;
}

export interface AutomationTurnServiceOptions {
  credentialDirectory?: string;
}

export interface AutomationRegistrationRequest {
  id: string;
  title: string;
  applicantConversationId: string;
  target?: AutomationConversationTarget;
  reason: string;
  projectRoot: string;
  rateLimit: AutomationRateLimit;
  expiresAt: string;
  ownerPackageId?: string | null;
}

export class AutomationTurnService {
  readonly interruptedAtStartup: number;
  private readonly active = new Map<string, ActiveExecution>();
  private readonly activeMessages = new Map<string, Promise<AutomationMessage>>();
  private readonly releaseOwnership: (() => void) | undefined;
  private readonly credentialDirectory: string | undefined;
  private closing = false;
  private storeClosed = false;
  private closePromise: Promise<void> | undefined;

  constructor(
    private readonly store: AutomationTurnStore,
    private readonly registry: AutomationSessionRegistry,
    options: AutomationTurnServiceOptions = {},
  ) {
    this.credentialDirectory = options.credentialDirectory
      ? resolve(options.credentialDirectory)
      : store.path === ":memory:" ? undefined : join(dirname(store.path), "automation-credentials");
    if (store.path !== ":memory:") {
      try {
        this.releaseOwnership = lockfile.lockSync(store.path, {
          lockfilePath: `${store.path}.runtime.lock`, realpath: false, stale: 300_000, update: 30_000, retries: 0,
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

  async requestRegistration(input: AutomationRegistrationRequest): Promise<AutomationRegistration> {
    this.assertAvailable();
    const id = validateRegistrationId(input.id);
    const title = validateShortText(input.title, "title", 200);
    const applicantConversationId = validateContextId(input.applicantConversationId, "applicantConversationId");
    await this.registry.assertAutomationConversation(applicantConversationId);
    const target = validateTarget(input.target ?? { kind: "existing", conversationId: applicantConversationId });
    const reason = validateShortText(input.reason, "reason", 4_000);
    const projectRoot = validatePathText(input.projectRoot, "projectRoot");
    const rateLimit = validateRateLimit(input.rateLimit);
    const expiresAt = validateFutureTimestamp(input.expiresAt, "expiresAt");
    const ownerPackageId = input.ownerPackageId === undefined ? null : validatePackageId(input.ownerPackageId);
    const registration = this.store.createRegistration({
      id, title, applicantConversationId, ownerPackageId, target, reason, projectRoot,
      maxCalls: rateLimit.maxCalls, windowSeconds: rateLimit.windowSeconds, expiresAt,
    });
    return this.view(registration);
  }

  listRegistrations(): AutomationRegistration[] {
    this.assertAvailable();
    return this.store.listRegistrations().map((registration) => this.view(registration));
  }

  getRegistration(id: string): AutomationRegistration {
    this.assertAvailable();
    return this.view(this.requireRegistration(validateRegistrationId(id)));
  }

  async approveRegistration(idValue: string): Promise<AutomationRegistration> {
    this.assertAvailable();
    const id = validateRegistrationId(idValue);
    const current = this.requireRegistration(id);
    if (current.status !== "pending") {
      throw new RequestError("automation_state_conflict", "Only an automation waiting for confirmation can be enabled", { httpStatus: 409 });
    }
    await this.registry.assertAutomationConversation(current.applicantConversationId);
    const projectRoot = await canonicalDirectory(current.projectRoot, "projectRoot");
    let targetConversationId: string | null;
    if (current.target.kind === "existing") {
      await this.registry.assertAutomationConversation(current.target.conversationId);
      targetConversationId = current.target.conversationId;
    } else if (current.target.mode === "dedicated") {
      targetConversationId = (await this.registry.createAutomationConversation(targetCreateInput(current.target))).conversationId;
    } else {
      targetConversationId = null;
    }
    this.assertAvailable();
    const token = randomBytes(32).toString("base64url");
    const approvedAt = new Date().toISOString();
    const saved = this.store.saveRegistration({
      ...current,
      status: "active",
      projectRoot,
      targetConversationId,
      tokenHash: hashToken(token),
      approvedAt,
      pausedAt: null,
      revokedAt: null,
    });
    try {
      await this.writeCredential(id, token);
    } catch (error) {
      this.store.saveRegistration({ ...saved, status: "pending", tokenHash: null, approvedAt: null });
      throw error;
    }
    return this.view(saved);
  }

  async updateRegistration(idValue: string, input: Partial<Omit<AutomationRegistrationRequest, "id" | "applicantConversationId">>): Promise<AutomationRegistration> {
    this.assertAvailable();
    const id = validateRegistrationId(idValue);
    const current = this.requireRegistration(id);
    if (current.status === "revoked") {
      throw new RequestError("automation_revoked", "A stopped automation cannot be adjusted", { httpStatus: 409 });
    }
    const nextTitle = input.title === undefined ? current.title : validateShortText(input.title, "title", 200);
    const nextReason = input.reason === undefined ? current.reason : validateShortText(input.reason, "reason", 4_000);
    const nextProjectRoot = input.projectRoot === undefined ? current.projectRoot : validatePathText(input.projectRoot, "projectRoot");
    const nextTarget = input.target === undefined ? current.target : validateTarget(input.target);
    const nextRateLimit = input.rateLimit === undefined ? current.rateLimit : validateRateLimit(input.rateLimit);
    const nextExpiresAt = input.expiresAt === undefined ? current.expiresAt : validateFutureTimestamp(input.expiresAt, "expiresAt");
    const requiresConfirmation =
      nextProjectRoot !== current.projectRoot ||
      JSON.stringify(nextTarget) !== JSON.stringify(current.target) ||
      nextRateLimit.maxCalls > current.rateLimit.maxCalls ||
      nextRateLimit.windowSeconds < current.rateLimit.windowSeconds ||
      nextExpiresAt > current.expiresAt;
    const saved = this.store.saveRegistration({
      ...current,
      title: nextTitle,
      reason: nextReason,
      projectRoot: nextProjectRoot,
      target: nextTarget,
      targetConversationId: nextTarget.kind === "existing" ? nextTarget.conversationId : requiresConfirmation ? null : current.targetConversationId,
      rateLimit: nextRateLimit,
      expiresAt: nextExpiresAt,
      ...(requiresConfirmation ? {
        status: "pending" as const,
        tokenHash: null,
        approvedAt: null,
        pausedAt: null,
      } : {}),
    });
    if (requiresConfirmation) await this.removeCredential(id);
    return this.view(saved);
  }

  pauseRegistration(idValue: string): AutomationRegistration {
    this.assertAvailable();
    const current = this.requireRegistration(validateRegistrationId(idValue));
    if (current.status !== "active") {
      throw new RequestError("automation_state_conflict", "Only an enabled automation can be paused", { httpStatus: 409 });
    }
    return this.view(this.store.saveRegistration({ ...current, status: "paused", pausedAt: new Date().toISOString() }));
  }

  pauseRegistrationsForConversation(conversationIdValue: string): AutomationRegistration[] {
    this.assertAvailable();
    const conversationId = validateContextId(conversationIdValue, "conversationId");
    const pausedAt = new Date().toISOString();
    return this.store.listRegistrations().flatMap((registration) => {
      if (registration.status !== "active" || registration.targetConversationId !== conversationId) return [];
      return [this.view(this.store.saveRegistration({ ...registration, status: "paused", pausedAt }))];
    });
  }

  resumeRegistration(idValue: string): AutomationRegistration {
    this.assertAvailable();
    const current = this.requireRegistration(validateRegistrationId(idValue));
    if (current.status !== "paused") {
      throw new RequestError("automation_state_conflict", "Only a paused automation can be resumed", { httpStatus: 409 });
    }
    if (current.expiresAt <= new Date().toISOString()) {
      const expired = this.store.saveRegistration({ ...current, status: "expired" });
      throw new RequestError("automation_registration_expired", "This automation has expired", {
        httpStatus: 409, registration: this.view(expired),
      });
    }
    return this.view(this.store.saveRegistration({ ...current, status: "active", pausedAt: null }));
  }

  async revokeRegistration(idValue: string): Promise<AutomationRegistration> {
    this.assertAvailable();
    const id = validateRegistrationId(idValue);
    const current = this.requireRegistration(id);
    const saved = current.status === "revoked" ? current : this.store.saveRegistration({
      ...current, status: "revoked", revokedAt: new Date().toISOString(), pausedAt: null,
    });
    for (const [turnId, execution] of this.active) {
      if (this.store.getTurn(turnId)?.registrationId === id) execution.controller.abort();
    }
    await this.removeCredential(id);
    return this.view(saved);
  }

  async issuePackageGrant(input: AutomationRegistrationRequest & { ownerPackageId: string }): Promise<AutomationRegistration> {
    const ownerPackageId = validatePackageId(input.ownerPackageId);
    const existing = this.store.getRegistration(validateRegistrationId(input.id));
    if (existing) {
      if (existing.ownerPackageId !== ownerPackageId) {
        throw new RequestError("automation_grant_owner_mismatch", "Automation grant belongs to another Package", { httpStatus: 403 });
      }
      if (existing.status === "active" || existing.status === "paused") return this.view(existing);
      if (existing.status === "revoked") throw new RequestError("automation_revoked", "Stopped package grant cannot be reused", { httpStatus: 409 });
      return this.approveRegistration(existing.id);
    }
    const requested = await this.requestRegistration({ ...input, ownerPackageId });
    return this.approveRegistration(requested.id);
  }

  async triggerPackageTurn(input: {
    ownerPackageId: string;
    registrationId: string;
    runId: string;
    message: string;
    artifactRefs?: unknown;
    idempotencyKey: string;
  }): Promise<AutomationTurn> {
    const registration = this.requireRegistration(validateRegistrationId(input.registrationId));
    if (registration.ownerPackageId !== validatePackageId(input.ownerPackageId)) {
      throw new RequestError("automation_grant_owner_mismatch", "Automation grant belongs to another Package", { httpStatus: 403 });
    }
    const credentialPath = this.credentialPath(registration.id);
    if (!credentialPath) throw new RequestError("automation_credential_unavailable", "Automation credential storage is unavailable", { httpStatus: 503 });
    const registrationToken = (await readFile(credentialPath, "utf8")).trim();
    return this.triggerTurn({ registrationToken, registrationId: registration.id, runId: input.runId, message: input.message,
      artifactRefs: input.artifactRefs, idempotencyKey: input.idempotencyKey });
  }

  async getPackageTurn(input: { ownerPackageId: string; registrationId: string; turnId: string; waitMs?: number }): Promise<AutomationTurn> {
    const registration = this.requireRegistration(validateRegistrationId(input.registrationId));
    if (registration.ownerPackageId !== validatePackageId(input.ownerPackageId)) {
      throw new RequestError("automation_grant_owner_mismatch", "Automation grant belongs to another Package", { httpStatus: 403 });
    }
    const credentialPath = this.credentialPath(registration.id);
    if (!credentialPath) throw new RequestError("automation_credential_unavailable", "Automation credential storage is unavailable", { httpStatus: 503 });
    return this.getTurn(input.turnId, (await readFile(credentialPath, "utf8")).trim(), input.waitMs);
  }

  async appendMessage(input: {
    registrationToken: string;
    registrationId: string;
    runId: string;
    conversationId?: string;
    message: string;
    artifactRefs?: unknown;
    idempotencyKey: string;
  }): Promise<{ message: AutomationMessage; artifactRefs: string[]; created: boolean }> {
    this.assertAvailable();
    const registration = this.authorizeRegistration(input.registrationId, input.registrationToken, input.conversationId);
    if (registration.target.kind === "new" && registration.target.mode === "per-run") {
      throw new RequestError("automation_target_requires_turn", "This automation creates a new conversation for each AI turn", { httpStatus: 409 });
    }
    const context: AutomationIdempotentMessageContext = {
      ...(await this.messageContext(registration, input)),
      idempotencyKey: validateContextId(input.idempotencyKey, "idempotencyKey"),
    };
    this.assertAvailable();
    this.authorizeRegistration(input.registrationId, input.registrationToken, input.conversationId);
    const result = this.store.createOrGetMessage({
      messageId: randomUUID(), registrationId: context.registrationId, runId: context.runId,
      conversationId: context.conversationId, idempotencyKey: context.idempotencyKey,
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
      return { message: await operation, artifactRefs: context.artifactRefs, created: true };
    } finally {
      if (this.activeMessages.get(result.message.messageId) === operation) this.activeMessages.delete(result.message.messageId);
    }
  }

  async triggerTurn(input: {
    registrationToken: string;
    registrationId: string;
    runId: string;
    conversationId?: string;
    message: string;
    artifactRefs?: unknown;
    idempotencyKey: string;
  }): Promise<AutomationTurn> {
    this.assertAvailable();
    const registration = this.authorizeRegistration(input.registrationId, input.registrationToken, input.conversationId);
    const idempotencyKey = validateContextId(input.idempotencyKey, "idempotencyKey");
    const existing = this.store.getTurnByIdempotencyKey(registration.id, idempotencyKey);
    if (existing) return existing;
    const context = await this.messageContext(registration, input);
    this.assertAvailable();
    const perRun = registration.target.kind === "new" && registration.target.mode === "per-run";
    const result = this.store.acceptTurn({
      turnId: randomUUID(), registrationId: registration.id, runId: context.runId,
      conversationId: perRun ? "" : context.conversationId, idempotencyKey,
      expectedTokenHash: registration.tokenHash!,
    });
    if (!result.created) return result.turn;
    let turn = result.turn;
    if (perRun) {
      try {
        const created = await this.registry.createAutomationConversation(targetCreateInput(registration.target as Extract<AutomationConversationTarget, { kind: "new" }>));
        turn = this.store.assignTurnConversation(turn.turnId, created.conversationId);
        context.conversationId = created.conversationId;
      } catch (error) {
        this.store.markFailed(turn.turnId, errorView(error));
        return this.store.getTurn(turn.turnId)!;
      }
    }
    this.startExecution(turn.turnId, { ...context, idempotencyKey });
    return turn;
  }

  async getTurn(turnId: string, registrationToken: string, waitMs = 0): Promise<AutomationTurn> {
    this.assertAvailable();
    const initial = this.authorizedTurn(turnId, registrationToken);
    const boundedWaitMs = boundedInteger(waitMs, "waitMs", 0, 30_000);
    if (boundedWaitMs === 0 || TERMINAL_STATUSES.has(initial.status)) return initial;
    const deadline = Date.now() + boundedWaitMs;
    let current = initial;
    while (Date.now() < deadline && !TERMINAL_STATUSES.has(current.status)) {
      await delay(Math.min(50, Math.max(1, deadline - Date.now())));
      this.assertAvailable();
      current = this.authorizedTurn(turnId, registrationToken);
    }
    return current;
  }

  cancelTurn(turnId: string, registrationToken: string): AutomationTurn {
    this.assertAvailable();
    const turn = this.authorizedTurn(turnId, registrationToken);
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
      ...[...this.active.values()].map((execution) => execution.promise), ...this.activeMessages.values(),
    ]);
    await Promise.race([executions, delay(SHUTDOWN_TIMEOUT_MS)]);
    try { this.store.interruptActiveTurns(); }
    finally {
      this.storeClosed = true;
      try { this.store.close(); } finally { this.releaseOwnership?.(); }
    }
  }

  private startExecution(turnId: string, context: AutomationTurnContext): void {
    const controller = new AbortController();
    const promise = this.execute(turnId, context, controller).finally(() => this.active.delete(turnId));
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

  private async appendMessageOnce(messageId: string, context: AutomationIdempotentMessageContext): Promise<AutomationMessage> {
    try {
      const appended = await this.registry.appendAutomationMessage(context);
      this.assertAvailable();
      return this.store.markMessageSucceeded(messageId, appended.entryId);
    } catch (error) {
      if (!this.storeClosed) {
        try { this.store.markMessageFailed(messageId, errorView(error)); }
        catch (transitionError) { if (!isMessageStateConflict(transitionError)) throw transitionError; }
      }
      throw error;
    }
  }

  private authorizeRegistration(idValue: string, token: string, conversationId?: string): AutomationRegistrationRecord {
    const id = validateRegistrationId(idValue);
    const registration = this.store.getRegistration(id);
    if (!registration || !registration.tokenHash || !tokenMatches(token, registration.tokenHash)) {
      throw new RequestError("automation_unauthorized", "Invalid automation credential", { httpStatus: 401 });
    }
    assertStatus(registration);
    if (conversationId !== undefined) {
      if (registration.target.kind === "new" && registration.target.mode === "per-run") {
        throw new RequestError("automation_scope_mismatch", "Per-run automation chooses its conversation inside Runtime", { httpStatus: 403 });
      }
      if (conversationId !== registration.targetConversationId) {
        throw new RequestError("automation_scope_mismatch", "Automation cannot use a different conversation", { httpStatus: 403 });
      }
    }
    return registration;
  }

  private authorizedTurn(turnIdValue: string, token: string): AutomationTurn {
    const turnId = validateContextId(turnIdValue, "turnId");
    const turn = this.store.getTurn(turnId);
    if (!turn) throw new RequestError("automation_turn_not_found", `Automation turn not found: ${turnId}`);
    this.authorizeRegistration(turn.registrationId, token);
    return turn;
  }

  private async messageContext(
    registration: AutomationRegistrationRecord,
    input: { runId: string; message: string; artifactRefs?: unknown },
  ): Promise<AutomationMessageContext> {
    const artifactRefs = await canonicalArtifactRefs(registration.projectRoot, input.artifactRefs);
    return {
      registrationId: registration.id,
      registrationTitle: registration.title,
      runId: validateContextId(input.runId, "runId"),
      conversationId: registration.targetConversationId ?? "",
      message: validateMessage(input.message),
      artifactRefs,
    };
  }

  private requireRegistration(id: string): AutomationRegistrationRecord {
    const registration = this.store.getRegistration(id);
    if (!registration) throw new RequestError("automation_registration_not_found", `Automation not found: ${id}`, { httpStatus: 404 });
    return registration;
  }

  private view(registration: AutomationRegistrationRecord): AutomationRegistration {
    const credentialPath = registration.status === "active" || registration.status === "paused"
      ? this.credentialPath(registration.id) : null;
    return publicRegistration(registration, this.store.rateUsage(registration), credentialPath);
  }

  private credentialPath(id: string): string | null {
    return this.credentialDirectory ? join(this.credentialDirectory, `${id}.token`) : null;
  }

  private async writeCredential(id: string, token: string): Promise<void> {
    const path = this.credentialPath(id);
    if (!path) return;
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${token}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
    await chmod(path, 0o600);
  }

  private async removeCredential(id: string): Promise<void> {
    const path = this.credentialPath(id);
    if (!path) return;
    await unlink(path).catch((error) => { if (!isMissingFile(error)) throw error; });
  }

  private tryMarkCancelled(turnId: string): void {
    try { this.store.markCancelled(turnId); } catch (error) { if (!isStateConflict(error)) throw error; }
  }

  private tryMarkInterrupted(turnId: string): void {
    try { this.store.markInterrupted(turnId); } catch (error) { if (!isStateConflict(error)) throw error; }
  }

  private assertAvailable(): void {
    if (this.closing || this.storeClosed) {
      throw new RequestError("automation_service_stopping", "Automation Turn Bridge is stopping", { httpStatus: 503 });
    }
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

function assertStatus(registration: AutomationRegistrationRecord): void {
  if (registration.status === "paused") throw new RequestError("automation_paused", "This automation is paused", { httpStatus: 403 });
  if (registration.status === "revoked") throw new RequestError("automation_revoked", "This automation has been stopped", { httpStatus: 403 });
  if (registration.status === "expired" || registration.expiresAt <= new Date().toISOString()) {
    throw new RequestError("automation_registration_expired", "This automation has expired", { httpStatus: 403 });
  }
  if (registration.status !== "active") {
    throw new RequestError("automation_not_approved", "This automation has not been enabled", { httpStatus: 403 });
  }
}

async function canonicalArtifactRefs(projectRoot: string, value: unknown): Promise<string[]> {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_ARTIFACT_REFS || value.some((item) => typeof item !== "string" || !item)) {
    throw new RequestError("invalid_artifact_refs", `artifactRefs must contain at most ${MAX_ARTIFACT_REFS} non-empty paths`);
  }
  const result: string[] = [];
  for (const reference of value as string[]) {
    const candidate = isAbsolute(reference) ? reference : resolve(projectRoot, reference);
    let canonical: string;
    try { canonical = await realpath(candidate); }
    catch { throw new RequestError("artifact_not_found", `Artifact does not exist: ${reference}`); }
    if (!insideOrEqual(projectRoot, canonical)) {
      throw new RequestError("artifact_outside_project_root", `Artifact escapes the allowed project: ${reference}`, { httpStatus: 403 });
    }
    if (!(await stat(canonical)).isFile()) throw new RequestError("invalid_artifact", `Artifact must be a file: ${reference}`);
    result.push(canonical);
  }
  return result;
}

async function canonicalDirectory(value: string, name: string): Promise<string> {
  const requested = validatePathText(value, name);
  let canonical: string;
  try { canonical = await realpath(resolve(requested)); }
  catch { throw new RequestError("automation_project_root_not_found", `${name} does not exist`); }
  if (!(await stat(canonical)).isDirectory()) throw new RequestError("invalid_automation_project_root", `${name} must be a directory`);
  return canonical;
}

function validateTarget(value: AutomationConversationTarget): AutomationConversationTarget {
  if (!value || typeof value !== "object") throw new RequestError("invalid_payload", "target must be an object");
  if (value.kind === "existing") {
    return { kind: "existing", conversationId: validateContextId(value.conversationId, "target.conversationId") };
  }
  if (value.kind !== "new" || (value.mode !== "dedicated" && value.mode !== "per-run")) {
    throw new RequestError("invalid_payload", "target must bind an existing conversation or describe how to create a new one");
  }
  const workspaceId = value.workspaceId ? validateContextId(value.workspaceId, "target.workspaceId") : null;
  const cwd = value.cwd ? validatePathText(value.cwd, "target.cwd") : null;
  if (!workspaceId && !cwd) {
    throw new RequestError("automation_target_boundary_required", "A new conversation requires a workspaceId or cwd");
  }
  return {
    kind: "new", mode: value.mode, assistantId: validateContextId(value.assistantId, "target.assistantId"), workspaceId, cwd,
  };
}

function targetCreateInput(target: Extract<AutomationConversationTarget, { kind: "new" }>): {
  assistantId: string; workspaceId?: string; cwd?: string;
} {
  return {
    assistantId: target.assistantId,
    ...(target.workspaceId ? { workspaceId: target.workspaceId } : {}),
    ...(target.cwd ? { cwd: target.cwd } : {}),
  };
}

function validateRateLimit(value: AutomationRateLimit): AutomationRateLimit {
  if (!value || typeof value !== "object") throw new RequestError("invalid_payload", "rateLimit must be an object");
  return {
    maxCalls: boundedInteger(value.maxCalls, "rateLimit.maxCalls", 1, MAX_RATE_CALLS),
    windowSeconds: boundedInteger(value.windowSeconds, "rateLimit.windowSeconds", 1, MAX_WINDOW_SECONDS),
  };
}

function validateRegistrationId(value: string): string {
  if (typeof value !== "string" || !SAFE_REGISTRATION_ID.test(value)) {
    throw new RequestError("invalid_registration_id", "registrationId must use 1-128 letters, numbers, dots, underscores, or hyphens");
  }
  return value;
}

function validatePackageId(value: string | null | undefined): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/.test(value)) {
    throw new RequestError("invalid_package_id", "ownerPackageId must be a Package id");
  }
  return value;
}

function validateContextId(value: string, name: string): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > MAX_CONTEXT_ID_LENGTH) {
    throw new RequestError("invalid_payload", `${name} must be a non-empty string no longer than ${MAX_CONTEXT_ID_LENGTH} characters`);
  }
  return value;
}

function validateShortText(value: string, name: string, maximum: number): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > maximum) {
    throw new RequestError("invalid_payload", `${name} must be a non-empty string no longer than ${maximum} characters`);
  }
  return value.trim();
}

function validatePathText(value: string, name: string): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > 4_096) {
    throw new RequestError("invalid_payload", `${name} must be a non-empty path`);
  }
  return value.trim();
}

function validateFutureTimestamp(value: string, name: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new RequestError("invalid_payload", `${name} must be an ISO timestamp`);
  }
  const normalized = new Date(value).toISOString();
  if (normalized <= new Date().toISOString()) throw new RequestError("invalid_payload", `${name} must be in the future`);
  return normalized;
}

function validateMessage(value: string): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > MAX_TEXT_LENGTH) {
    throw new RequestError("invalid_payload", `message must be a non-empty string no longer than ${MAX_TEXT_LENGTH} characters`);
  }
  return value;
}

function insideOrEqual(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function boundedInteger(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RequestError("invalid_payload", `${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function errorView(error: unknown): { code: string; message: string } {
  return { code: error instanceof RequestError ? error.code : "automation_turn_failed", message: error instanceof Error ? error.message : String(error) };
}

function automationCancelled(): RequestError { return new RequestError("automation_turn_cancelled", "Automation turn was cancelled"); }
function isStateConflict(error: unknown): boolean { return error instanceof RequestError && error.code === "automation_turn_state_conflict"; }
function isMessageStateConflict(error: unknown): boolean { return error instanceof RequestError && error.code === "automation_message_state_conflict"; }
function isMissingFile(error: unknown): boolean { return error instanceof Error && "code" in error && error.code === "ENOENT"; }

function failedMessageRetry(message: AutomationMessage): RequestError {
  return new RequestError("automation_message_failed", `Automation message ${message.messageId} already failed`, {
    httpStatus: 409, messageId: message.messageId,
    originalError: { code: message.errorCode, message: message.errorMessage },
  });
}

function pendingMessageRetry(message: AutomationMessage): RequestError {
  return new RequestError("automation_message_outcome_unknown", `Automation message ${message.messageId} has an unknown outcome`, {
    httpStatus: 409, messageId: message.messageId,
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
