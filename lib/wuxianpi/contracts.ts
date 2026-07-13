export const WUXIANPI_SCHEMA_VERSION = 1 as const;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type CapabilityRisk = "read" | "write" | "execute" | "network" | "external" | "audio";
export type PermissionDecision = "once" | "assistant" | "deny";
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
  enabled?: boolean;
}

export interface WebExtensionContribution {
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
  permissions?: CapabilityRisk[];
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
  method: "assistant.get" | "storage.get" | "storage.set" | "tts.speak" | "tools.call" | "ui.notify" | "ui.resize" | "ui.close";
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

export interface AssistantCreateRequest {
  id: string;
  manifest: AssistantManifestV1;
  files?: Partial<AssistantFiles>;
}

export interface AssistantUpdateRequest {
  manifest?: Partial<Omit<AssistantManifestV1, "schemaVersion">>;
  files?: Partial<AssistantFiles>;
}

export interface NewAgentSessionRequest {
  assistantId?: string;
  cwd?: string;
  overrides?: SessionRuntimeOverrides;
  type: string;
  message?: string;
  images?: unknown[];
  provider?: string;
  modelId?: string;
  thinkingLevel?: string;
  toolNames?: string[];
  [key: string]: unknown;
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
