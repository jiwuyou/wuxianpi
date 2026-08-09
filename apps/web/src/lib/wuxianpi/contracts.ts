export const WUXIANPI_SCHEMA_VERSION = 1 as const;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type CapabilityRisk = "read" | "write" | "execute" | "network" | "external" | "audio";
export type PermissionDecision = "once" | "assistant" | "deny";
export type ExtensionBridgePermission =
  | "assistant.read"
  | "storage.read"
  | "storage.write"
  | "tts.speak"
  | "tools.call"
  | "ui.notify"
  | "ui.resize"
  | "ui.close"
  | "ui.openSession"
  | "session.readScope"
  | "session.rebind"
  | "session.create"
  | "workspace.list"
  | "workspace.create"
  | "workspace.file.read"
  | "workspace.file.write"
  | "package.invoke";
export type CapabilitySource = "pi-builtin" | "pi-extension" | "skill" | "mcp" | "tts" | "web-extension" | "ubuntu";
export type CapabilityStatus = "available" | "unavailable" | "error";
export type RuntimeLocation = "termux" | "ubuntu";

export interface ModelRef {
  provider: string;
  modelId: string;
}

export interface AssistantTtsConfig {
  profileId?: string;
  autoSpeak?: boolean;
  rate?: number;
  pitch?: number;
  readCode?: boolean;
}

export interface AssistantManifestV1 {
  schemaVersion: typeof WUXIANPI_SCHEMA_VERSION;
  name: string;
  description?: string;
  avatar?: string;
  greeting?: string;
  starterPrompts?: string[];
  model?: ModelRef | "inherit";
  thinkingLevel?: string | "inherit";
  tools?: string[] | "inherit";
  skills?: string[] | "inherit";
  mcpServers?: string[] | "inherit";
  webExtensions?: string[] | "inherit";
  tts?: AssistantTtsConfig | "inherit";
  archived?: boolean;
}

export interface AssistantSummary {
  id: string;
  path: string;
  manifest: AssistantManifestV1;
  sessionCount: number;
  lastActiveAt?: string;
  diagnostics: CapabilityDiagnostic[];
}

export interface AssistantFiles {
  agents: string;
  memory: string;
  workspaces: string;
}

export interface AssistantBundleV1 {
  schemaVersion: typeof WUXIANPI_SCHEMA_VERSION;
  manifest: AssistantManifestV1;
  files: AssistantFiles;
}

export interface TtsProfile {
  id: string;
  name: string;
  provider: "browser-speech" | "termux-api" | "openai-compatible" | "http";
  voice?: string;
  model?: string;
  baseUrl?: string;
  secretRef?: string;
  headers?: Record<string, string>;
  rate?: number;
  pitch?: number;
  enabled?: boolean;
}

export interface McpServerConfig {
  id: string;
  name: string;
  transport: "stdio" | "streamable-http";
  runtime?: RuntimeLocation;
  command?: string;
  args?: string[];
  cwd?: string;
  url?: string;
  env?: Record<string, string>;
  envSecretRefs?: Record<string, string>;
  headers?: Record<string, string>;
  headerSecretRefs?: Record<string, string>;
  timeoutMs?: number;
  lifecycle?: "keep-alive" | "lazy" | "lazy-keep-alive" | "eager";
  auth?: "oauth" | "bearer" | false;
  enabled?: boolean;
}

export interface WebExtensionContribution {
  navigationItems?: Array<{ id: string; title: string; icon?: string; entry: string }>;
  fullPages?: Array<{ id: string; title: string; entry: string }>;
  settingsPanels?: Array<{ id: string; title: string; entry: string }>;
  assistantEditorTabs?: Array<{ id: string; title: string; entry: string }>;
  chatActions?: Array<{ id: string; title: string; icon?: string }>;
  toolRenderers?: Array<{ toolPattern: string; entry: string }>;
}

export interface WebExtensionManifestV1 {
  schemaVersion: typeof WUXIANPI_SCHEMA_VERSION;
  id: string;
  name: string;
  version: string;
  apiVersion: "1";
  description?: string;
  entry?: string;
  permissions?: ExtensionBridgePermission[];
  contributes?: WebExtensionContribution;
}

export interface PermissionGrant {
  assistantId: string;
  capabilityId: string;
  decision: Exclude<PermissionDecision, "once">;
  updatedAt: string;
}

export interface GlobalWuxianPiConfigV1 {
  schemaVersion: typeof WUXIANPI_SCHEMA_VERSION;
  defaults: {
    model?: ModelRef;
    thinkingLevel?: string;
    tools?: string[];
    skills?: string[];
    mcpServers?: string[];
    webExtensions?: string[];
    tts?: AssistantTtsConfig;
    maxLiveSessions?: number;
    idleSessionMs?: number;
  };
  mcpServers: McpServerConfig[];
  ttsProfiles: TtsProfile[];
  permissions: PermissionGrant[];
  ubuntu?: {
    enabled: boolean;
    distro?: string;
    nodePath?: string;
    idleTimeoutMs?: number;
  };
}

export interface SessionRuntimeOverrides {
  model?: ModelRef;
  thinkingLevel?: string;
  tools?: string[];
  skills?: string[];
  mcpServers?: string[];
  webExtensions?: string[];
  tts?: AssistantTtsConfig;
}

export interface CreateSessionRequest {
  assistantId: string;
  workspaceId?: string;
  cwd?: string;
  overrides?: SessionRuntimeOverrides;
  type?: "ensure_session" | "prompt";
  message?: string;
  images?: unknown[];
  streamingBehavior?: "steer" | "followUp";
  provider?: string;
  modelId?: string;
  thinkingLevel?: string;
  toolNames?: string[];
}

export interface Workspace {
  id: string;
  name: string;
  rootCwd: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  instructions: string;
  memory: string;
}

export interface WorkspaceCreateRequest {
  id?: string;
  name: string;
  rootCwd: string;
  archived?: boolean;
  instructions?: string;
  memory?: string;
}

export interface WorkspaceUpdateRequest {
  name?: string;
  rootCwd?: string;
  archived?: boolean;
  instructions?: string;
  memory?: string;
}

export interface WorkspaceListOptions {
  includeArchived?: boolean;
}

export interface WorkspaceListData {
  workspaces: Workspace[];
}

export interface WorkspaceMutationData {
  workspace: Workspace;
}

export interface WorkspaceDeleteData {
  removed: boolean;
}

export type AutomationRegistrationStatus = "pending" | "active" | "paused" | "expired" | "revoked";

export interface AutomationRateLimit {
  maxCalls: number;
  windowSeconds: number;
}

export interface AutomationRateUsage extends AutomationRateLimit {
  used: number;
  nextAllowedAt: string | null;
}

export type AutomationTarget =
  | { kind: "existing"; conversationId: string }
  | { kind: "new"; mode: "dedicated" | "per-run"; assistantId: string; workspaceId: string | null; cwd: string | null };

export interface AutomationRegistration {
  id: string;
  title: string;
  status: AutomationRegistrationStatus;
  applicantConversationId: string;
  targetConversationId: string | null;
  target: AutomationTarget;
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

export interface AutomationListData { automations: AutomationRegistration[]; }

export interface AutomationCreateRequest {
  id: string;
  title: string;
  applicantConversationId: string;
  target?: AutomationTarget;
  reason: string;
  projectRoot: string;
  rateLimit: AutomationRateLimit;
  expiresAt: string;
}

export type AutomationUpdateRequest = Partial<Omit<AutomationCreateRequest, "id" | "applicantConversationId">>;

export interface ResolvedAssistantRuntime {
  assistantId: string;
  cwd: string;
  model?: ModelRef;
  thinkingLevel?: string;
  toolNames: string[];
  skillNames: string[];
  mcpServerIds: string[];
  webExtensionIds: string[];
  tts?: AssistantTtsConfig;
  diagnostics: CapabilityDiagnostic[];
}

export interface CapabilityDiagnostic {
  capabilityId?: string;
  level: "info" | "warning" | "error";
  code: string;
  message: string;
}

export interface CapabilityDescriptor {
  id: string;
  name: string;
  description?: string;
  source: CapabilitySource;
  risk: CapabilityRisk[];
  status: CapabilityStatus;
  assistantSelectable: boolean;
  diagnostics?: CapabilityDiagnostic[];
  selection?: {
    field: "tools" | "skills" | "mcpServers" | "webExtensions";
    values: string[];
  };
  metadata?: Record<string, JsonValue>;
}

export interface CapabilityCatalog {
  generatedAt: string;
  capabilities: CapabilityDescriptor[];
  diagnostics: CapabilityDiagnostic[];
}

export interface PermissionRequest {
  id: string;
  assistantId: string;
  capabilityId: string;
  title: string;
  description: string;
  risk: CapabilityRisk[];
  expiresAt?: number;
  metadata?: Record<string, JsonValue>;
}

export interface ExtensionBridgeRequest {
  type: "wuxianpi_bridge_request";
  requestId: string;
  extensionId: string;
  nonce: string;
  method:
    | "assistant.get" | "storage.get" | "storage.set" | "tts.speak" | "tools.call"
    | "ui.notify" | "ui.resize" | "ui.close" | "ui.openSession"
    | "session.getScope" | "session.rebind" | "session.create"
    | "workspace.list" | "workspace.create" | "workspace.file.read" | "workspace.file.write"
    | "package.invoke";
  params?: JsonValue;
}

export interface ExtensionBridgeResponse {
  type: "wuxianpi_bridge_response";
  requestId: string;
  extensionId: string;
  nonce: string;
  ok: boolean;
  result?: JsonValue;
  error?: { code: string; message: string };
}

export type AssistantAvatarAssetMutation =
  | { action: "upload"; mimeType: "image/png" | "image/jpeg" | "image/webp"; data: string }
  | { action: "remove" };

export interface AssistantCreateRequest {
  id: string;
  manifest: AssistantManifestV1;
  files?: Partial<AssistantFiles>;
  avatarAsset?: AssistantAvatarAssetMutation;
}

export interface AssistantUpdateRequest {
  manifest?: Partial<Omit<AssistantManifestV1, "schemaVersion">>;
  files?: Partial<AssistantFiles>;
  avatarAsset?: AssistantAvatarAssetMutation;
}

export interface NewAgentSessionRequest {
  assistantId: string;
  workspaceId?: string;
  cwd?: string;
  overrides?: SessionRuntimeOverrides;
  type: "ensure_session" | "prompt";
  message?: string;
  images?: unknown[];
  streamingBehavior?: "steer" | "followUp";
  provider?: string;
  modelId?: string;
  thinkingLevel?: string;
  toolNames?: string[];
}

export interface ApiSuccess<T> {
  success: true;
  data: T;
}

export interface ApiFailure {
  success: false;
  error: string;
  code?: string;
  details?: JsonValue;
}

export type ApiResult<T> = ApiSuccess<T> | ApiFailure;

export interface AssistantListData {
  assistants: AssistantSummary[];
  legacySessionCount: number;
}

export interface AssistantDetailData {
  assistant: AssistantSummary;
  files: AssistantFiles;
}

export interface AssistantMutationData {
  assistant: AssistantSummary;
}

export interface AssistantCopyRequest {
  targetId: string;
  name?: string;
}

export interface CapabilityConfigPatch {
  defaults?: Partial<GlobalWuxianPiConfigV1["defaults"]>;
  mcpServers?: McpServerConfig[];
  ttsProfiles?: TtsProfile[];
  ubuntu?: GlobalWuxianPiConfigV1["ubuntu"];
}

export interface CapabilityCatalogData {
  catalog: CapabilityCatalog;
  config: GlobalWuxianPiConfigV1;
}

export interface SecretSummary {
  name: string;
  configured: boolean;
  updatedAt?: string;
}

export interface SecretMutationRequest {
  name: string;
  value?: string;
}

export interface McpActionRequest {
  action: "test" | "listTools" | "call" | "cancel";
  serverId: string;
  assistantId?: string;
  toolName?: string;
  arguments?: JsonValue;
  callId?: string;
}

export interface McpActionData {
  serverId: string;
  tools?: CapabilityDescriptor[];
  result?: JsonValue;
  diagnostics?: CapabilityDiagnostic[];
  adapterInstalled?: boolean;
  configPath?: string;
}

export interface TtsSpeakRequest {
  profileId: string;
  text: string;
  assistantId?: string;
  rate?: number;
  pitch?: number;
  readCode?: boolean;
  preview?: boolean;
}

export interface TtsClientInstruction {
  kind: "browser-speech";
  text: string;
  voice?: string;
  rate?: number;
  pitch?: number;
}

export interface PermissionResponseRequest {
  requestId: string;
  decision: PermissionDecision;
}

export interface PermissionRevokeRequest {
  assistantId: string;
  capabilityId: string;
}

export type PermissionMutationRequest =
  | { action: "decide"; request: PermissionResponseRequest }
  | { action: "revoke"; request: PermissionRevokeRequest };

export interface PermissionStateData {
  pending: PermissionRequest[];
  grants: PermissionGrant[];
}

export interface WebExtensionSummary {
  id: string;
  path: string;
  manifest: WebExtensionManifestV1;
  enabled: boolean;
  resourceBaseUrl: string;
  diagnostics: CapabilityDiagnostic[];
  builtin?: boolean;
}

export interface WebExtensionListData {
  extensions: WebExtensionSummary[];
}

export interface UbuntuActionRequest {
  action: "status" | "start" | "listTools" | "call" | "cancel" | "shutdown";
  assistantId?: string;
  toolName?: string;
  arguments?: JsonValue;
  callId?: string;
}

export interface UbuntuStatusData {
  available: boolean;
  running: boolean;
  distro?: string;
  tools?: CapabilityDescriptor[];
  diagnostics: CapabilityDiagnostic[];
}

export interface UbuntuRpcRequest {
  jsonrpc: "2.0";
  id: string;
  method: "health" | "tools/list" | "tools/call" | "cancel" | "shutdown";
  params?: {
    assistantId?: string;
    toolName?: string;
    arguments?: JsonValue;
    callId?: string;
    relativePath?: string;
  };
}

export interface UbuntuRpcResponse {
  jsonrpc: "2.0";
  id: string;
  result?: JsonValue;
  error?: { code: number; message: string; data?: JsonValue };
}
