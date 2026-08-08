export const AUTOMATION_API_ROOT = "/api/automation/v1";
export const AUTOMATION_CUSTOM_MESSAGE_TYPE = "wuxianpi.automation-turn";

export type AutomationRegistrationStatus = "pending" | "active" | "paused" | "expired" | "revoked";

export interface AutomationRateLimit {
  maxCalls: number;
  windowSeconds: number;
}

export interface AutomationRateUsage {
  used: number;
  limit: number;
  windowSeconds: number;
  nextAllowedAt: string | null;
}

export type AutomationConversationTarget =
  | { kind: "existing"; conversationId: string }
  | {
      kind: "new";
      mode: "dedicated" | "per-run";
      assistantId: string;
      workspaceId: string | null;
      cwd: string | null;
    };

export interface AutomationRegistration {
  id: string;
  title: string;
  status: AutomationRegistrationStatus;
  applicantConversationId: string;
  targetConversationId: string | null;
  target: AutomationConversationTarget;
  reason: string;
  projectRoot: string;
  rateLimit: AutomationRateLimit;
  rateUsage: AutomationRateUsage;
  expiresAt: string;
  credentialPath: string | null;
  createdAt: string;
  approvedAt: string | null;
  lastTriggeredAt: string | null;
  pausedAt: string | null;
  revokedAt: string | null;
  updatedAt: string;
}

export interface AutomationRegistrationRecord extends Omit<AutomationRegistration, "rateUsage" | "credentialPath"> {
  tokenHash: string | null;
}

export type AutomationTurnStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface AutomationTurn {
  turnId: string;
  registrationId: string;
  runId: string;
  conversationId: string;
  idempotencyKey: string;
  status: AutomationTurnStatus;
  finalLeafId: string | null;
  assistantText: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}

export type AutomationMessageStatus = "pending" | "succeeded" | "failed";

export interface AutomationMessage {
  messageId: string;
  registrationId: string;
  runId: string;
  conversationId: string;
  idempotencyKey: string;
  status: AutomationMessageStatus;
  entryId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
  updatedAt: string;
}

export interface AutomationMessageContext {
  registrationId: string;
  registrationTitle: string;
  runId: string;
  conversationId: string;
  message: string;
  artifactRefs: string[];
}

export interface AutomationIdempotentMessageContext extends AutomationMessageContext {
  idempotencyKey: string;
}

export interface AutomationTurnContext extends AutomationMessageContext {
  idempotencyKey: string;
}

export interface AutomationSessionTurnResult {
  finalLeafId: string;
  assistantText: string;
}

export interface AutomationSessionRegistry {
  assertAutomationConversation(conversationId: string): Promise<void>;
  createAutomationConversation(input: {
    assistantId: string;
    workspaceId?: string;
    cwd?: string;
  }): Promise<{ conversationId: string }>;
  appendAutomationMessage(input: AutomationIdempotentMessageContext): Promise<{ entryId: string }>;
  runAutomationTurn(input: AutomationTurnContext & {
    signal: AbortSignal;
    onStarted: () => void;
  }): Promise<AutomationSessionTurnResult>;
}

export function publicRegistration(
  registration: AutomationRegistrationRecord,
  rateUsage: AutomationRateUsage,
  credentialPath: string | null,
): AutomationRegistration {
  const { tokenHash: _tokenHash, ...view } = registration;
  return { ...view, rateUsage, credentialPath };
}
