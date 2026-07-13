import type {
  ApiResult,
  AssistantCopyRequest,
  AssistantCreateRequest,
  AssistantDetailData,
  AssistantListData,
  AssistantMutationData,
  AssistantSummary,
  AssistantUpdateRequest,
  CapabilityCatalogData,
  CapabilityConfigPatch,
  CapabilityCatalog,
  GlobalWuxianPiConfigV1,
  ExtensionBridgeResponse,
  PermissionMutationRequest,
  PermissionStateData,
  TtsClientInstruction,
  TtsSpeakRequest,
  WebExtensionListData,
  WebExtensionSummary,
  McpActionData,
  McpActionRequest,
} from "@/lib/wuxianpi/contracts";
import { WUXIANPI_API_ROUTES } from "@/lib/wuxianpi/contracts";

export class WuxianPiApiError extends Error {
  constructor(message: string, public readonly status?: number, public readonly code?: string) {
    super(message);
    this.name = "WuxianPiApiError";
  }
}

async function parseResponse<T>(response: Response): Promise<T> {
  const contentType = response.headers.get("content-type") ?? "";
  const payload = contentType.includes("application/json")
    ? await response.json().catch(() => null) as ApiResult<T> | T | null
    : await response.text().catch(() => "");

  if (!response.ok) {
    const failure = payload && typeof payload === "object" && "success" in payload && payload.success === false
      ? payload
      : null;
    throw new WuxianPiApiError(
      failure?.error ?? (typeof payload === "string" && payload ? payload : `HTTP ${response.status}`),
      response.status,
      failure?.code,
    );
  }

  if (payload && typeof payload === "object" && "success" in payload) {
    const result = payload as ApiResult<T>;
    if (!result.success) throw new WuxianPiApiError(result.error, response.status, result.code);
    return result.data;
  }
  return payload as T;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(path, { ...init, headers });
  return parseResponse<T>(response);
}

export async function listAssistants(options?: { includeArchived?: boolean }): Promise<AssistantSummary[]> {
  const query = options?.includeArchived ? "?includeArchived=true" : "";
  const payload = await request<AssistantListData>(`${WUXIANPI_API_ROUTES.assistants}${query}`);
  return payload.assistants;
}

export function getAssistant(id: string): Promise<AssistantDetailData> {
  return request<AssistantDetailData>(WUXIANPI_API_ROUTES.assistant(id));
}

export function createAssistant(input: AssistantCreateRequest): Promise<AssistantSummary> {
  return request<AssistantMutationData>(WUXIANPI_API_ROUTES.assistants, {
    method: "POST",
    body: JSON.stringify(input),
  }).then((data) => data.assistant);
}

export function updateAssistant(id: string, input: AssistantUpdateRequest): Promise<AssistantSummary> {
  return request<AssistantMutationData>(WUXIANPI_API_ROUTES.assistant(id), {
    method: "PATCH",
    body: JSON.stringify(input),
  }).then((data) => data.assistant);
}

export function setAssistantArchived(id: string, archived: boolean): Promise<AssistantSummary> {
  return updateAssistant(id, { manifest: { archived } });
}

export function cloneAssistant(id: string, newId?: string): Promise<AssistantSummary> {
  const payload: AssistantCopyRequest = { targetId: newId ?? `${id}-copy` };
  return request<AssistantMutationData>(WUXIANPI_API_ROUTES.assistantCopy(id), {
    method: "POST",
    body: JSON.stringify(payload),
  }).then((data) => data.assistant);
}

export function importAssistant(file: File, id: string): Promise<AssistantSummary> {
  const form = new FormData();
  form.set("id", id);
  form.set("file", file);
  return request<AssistantMutationData>(WUXIANPI_API_ROUTES.assistantImport, {
    method: "POST",
    body: form,
  }).then((data) => data.assistant);
}

export async function exportAssistant(id: string): Promise<void> {
  const response = await fetch(WUXIANPI_API_ROUTES.assistantExport(id));
  if (!response.ok) await parseResponse<never>(response);
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${id}.wuxianpi.zip`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function getCapabilityCatalog(): Promise<CapabilityCatalog> {
  return request<CapabilityCatalogData>(WUXIANPI_API_ROUTES.capabilities).then((data) => data.catalog);
}

export function getGlobalConfig(): Promise<GlobalWuxianPiConfigV1> {
  return request<CapabilityCatalogData>(WUXIANPI_API_ROUTES.capabilities).then((data) => data.config);
}

export function updateGlobalConfig(config: GlobalWuxianPiConfigV1 | CapabilityConfigPatch): Promise<GlobalWuxianPiConfigV1> {
  const patch: CapabilityConfigPatch = "schemaVersion" in config
    ? { defaults: config.defaults, mcpServers: config.mcpServers, ttsProfiles: config.ttsProfiles, ubuntu: config.ubuntu }
    : config;
  return request<GlobalWuxianPiConfigV1>(WUXIANPI_API_ROUTES.capabilityConfig, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export function speakText(input: TtsSpeakRequest, signal?: AbortSignal): Promise<TtsClientInstruction | Blob | null> {
  return fetch(WUXIANPI_API_ROUTES.tts, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
    signal,
  }).then(async (response) => {
    if (!response.ok) return parseResponse<never>(response);
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.startsWith("audio/")) return response.blob();
    const data = await parseResponse<
      | { kind: "client"; instruction: TtsClientInstruction }
      | { kind: "audio"; mimeType: string; data: string }
      | { kind: "completed"; provider: "termux-api" }
    >(response);
    if (data.kind === "client") return data.instruction;
    if (data.kind === "completed") return null;
    const binary = atob(data.data);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return new Blob([bytes], { type: data.mimeType });
  });
}

export async function listWebExtensions(): Promise<WebExtensionSummary[]> {
  const payload = await request<WebExtensionListData>(WUXIANPI_API_ROUTES.webExtensions);
  return payload.extensions;
}

export function bridgeExtension(_extensionId: string, payload: unknown): Promise<ExtensionBridgeResponse> {
  return request<ExtensionBridgeResponse>(WUXIANPI_API_ROUTES.extensionBridge, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function issueExtensionNonce(extensionId: string, assistantId?: string): Promise<string> {
  return request<{ extensionId: string; assistantId?: string; nonce: string }>(WUXIANPI_API_ROUTES.webExtensions, {
    method: "POST",
    body: JSON.stringify({ action: "nonce", extensionId, assistantId }),
  }).then((data) => data.nonce);
}

export function getPermissionState(): Promise<PermissionStateData> {
  return request<PermissionStateData>(WUXIANPI_API_ROUTES.permissions);
}

export function performMcpAction(input: McpActionRequest): Promise<McpActionData> {
  return request<McpActionData>(WUXIANPI_API_ROUTES.mcp, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function mutatePermission(input: PermissionMutationRequest): Promise<PermissionStateData> {
  return request<PermissionStateData>(WUXIANPI_API_ROUTES.permissions, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function isUnavailableError(error: unknown): boolean {
  return error instanceof WuxianPiApiError && [404, 405, 501].includes(error.status ?? 0);
}
