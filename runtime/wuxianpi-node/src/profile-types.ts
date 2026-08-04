export type WorkspaceId = string;
export type AssistantId = string;
export type SessionId = string;

export interface WorkspaceRecord {
  id: WorkspaceId;
  name: string;
  rootCwd: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateWorkspaceInput {
  id: WorkspaceId;
  name: string;
  rootCwd: string;
  archived?: boolean;
}

export interface UpdateWorkspaceInput {
  name?: string;
  rootCwd?: string;
  archived?: boolean;
}

export interface WorkspaceListFilter {
  includeArchived?: boolean;
}

export interface WorkspaceContextFiles {
  instructions: string;
  memory: string;
}

export interface WorkspaceContext extends WorkspaceContextFiles {
  workspace: WorkspaceRecord;
  directory: string;
  instructionsPath: string;
  memoryPath: string;
}

export interface CreateManagedWorkspaceInput {
  id?: WorkspaceId;
  name: string;
  rootCwd: string;
  archived?: boolean;
  instructions?: string;
  memory?: string;
}

export interface UpdateManagedWorkspaceInput extends UpdateWorkspaceInput {
  instructions?: string;
  memory?: string;
}

export interface SessionProfileBinding {
  sessionId: SessionId;
  assistantId: AssistantId;
  workspaceId: WorkspaceId | null;
  cwd: string;
  inheritedFromSessionId: SessionId | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSessionBindingInput {
  sessionId: SessionId;
  assistantId: AssistantId;
  workspaceId?: WorkspaceId | null;
  cwd: string;
  inheritedFromSessionId?: SessionId | null;
}

export interface InheritSessionBindingInput {
  sourceSessionId: SessionId;
  targetSessionId: SessionId;
  cwd?: string;
  workspaceId?: WorkspaceId | null;
}

export interface SessionBindingListFilter {
  assistantId?: AssistantId;
  workspaceId?: WorkspaceId | null;
  cwd?: string;
  limit?: number;
  offset?: number;
}

export type BindingReconciliationStatus = "created" | "unchanged";

export interface BindingReconciliationResult {
  status: BindingReconciliationStatus;
  binding: SessionProfileBinding;
}

export type ProfileContextResourceKind =
  | "shared-user"
  | "assistant-agents"
  | "assistant-memory"
  | "workspace-instructions"
  | "workspace-memory"
  | "package-context"
  | "functional-assistant-context";

export interface SuppliedProfileContext {
  id: string;
  content: string;
  title?: string;
  sourcePath?: string;
}

export interface AssembleProfileContextInput {
  assistantId: AssistantId;
  workspaceId?: WorkspaceId | null;
  packageContexts?: SuppliedProfileContext[];
  functionalAssistantContexts?: SuppliedProfileContext[];
}

export interface ProfileContextResource {
  order: number;
  kind: ProfileContextResourceKind;
  id: string;
  title: string;
  sourcePath?: string;
  sha256: string;
  sizeBytes: number;
}

export interface AssembledProfileContext {
  assistantId: AssistantId;
  workspaceId: WorkspaceId | null;
  prompt: string;
  resources: ProfileContextResource[];
}
