export const AUTOMATION_API_ROOT = "/api/automation/v1";
export const AUTOMATION_CUSTOM_MESSAGE_TYPE = "wuxianpi.automation-turn";

export type AutomationTurnStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface AutomationBinding {
  taskId: string;
  conversationId: string;
  taskRoot: string;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AutomationBindingRecord extends AutomationBinding {
  tokenHash: string;
}

export interface AutomationTurn {
  turnId: string;
  taskId: string;
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
  taskId: string;
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
  taskId: string;
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
  appendAutomationMessage(input: AutomationIdempotentMessageContext): Promise<{ entryId: string }>;
  runAutomationTurn(input: AutomationTurnContext & {
    signal: AbortSignal;
    onStarted: () => void;
  }): Promise<AutomationSessionTurnResult>;
}

export function publicBinding(binding: AutomationBindingRecord): AutomationBinding {
  const { tokenHash: _tokenHash, ...view } = binding;
  return view;
}
