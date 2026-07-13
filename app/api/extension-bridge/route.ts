import type { ExtensionBridgeRequest, ExtensionBridgeResponse, JsonValue, TtsSpeakRequest } from "@/lib/wuxianpi/contracts";
import { apiFailure, apiSuccess } from "@/lib/wuxianpi/api";
import { getAssistant } from "@/lib/wuxianpi/assistant-manager";
import { callMcpTool } from "@/lib/wuxianpi/mcp-manager";
import { speak } from "@/lib/wuxianpi/tts-manager";
import { assertWebExtensionBridgePermission, extensionStorageGet, extensionStorageSet, getWebExtensionSummary, validateBridgeNonce } from "@/lib/wuxianpi/web-extension-manager";
import { callUbuntuTool } from "@/lib/wuxianpi/ubuntu-bridge";
import { resolveAssistantRuntime } from "@/lib/wuxianpi/runtime-resolver";
import { getPermissionDecision, requireExecutionPermission } from "@/lib/wuxianpi/permission-manager";

function success(request: ExtensionBridgeRequest, result: JsonValue): ExtensionBridgeResponse {
  return { type: "wuxianpi_bridge_response", requestId: request.requestId, extensionId: request.extensionId, nonce: request.nonce, ok: true, result };
}

export async function POST(httpRequest: Request) {
  let request: ExtensionBridgeRequest | undefined;
  try {
    request = await httpRequest.json() as ExtensionBridgeRequest;
    const { assistantId } = validateBridgeNonce(request.nonce, request.extensionId);
    const extension = await getWebExtensionSummary(request.extensionId);
    const required = assertWebExtensionBridgePermission(extension.manifest, request.method);
    const extensionCapabilityId = `web-extension:${request.extensionId}`;
    const extensionDecision = await getPermissionDecision(assistantId, extensionCapabilityId);
    if (extensionDecision === "deny") throw new Error(`Permission denied for ${extensionCapabilityId}`);
    if (["storage.write", "tts.speak", "tools.call"].includes(required)) {
      await requireExecutionPermission(assistantId, extensionCapabilityId, {
        title: `Use ${extension.manifest.name}`,
        description: `Allow ${extension.manifest.name} to perform ${required}`,
        risk: required === "storage.write" ? ["write"] : required === "tts.speak" ? ["audio", "network"] : ["execute", "external"],
      });
    }
    const params = (request.params && typeof request.params === "object" && !Array.isArray(request.params) ? request.params : {}) as Record<string, JsonValue>;
    let result: JsonValue = null;
    if (request.method === "assistant.get") result = JSON.parse(JSON.stringify(await getAssistant(assistantId))) as JsonValue;
    else if (request.method === "storage.get") result = await extensionStorageGet(request.extensionId, assistantId, String(params.key ?? "")) ?? null;
    else if (request.method === "storage.set") { await extensionStorageSet(request.extensionId, assistantId, String(params.key ?? ""), params.value ?? null); result = { stored: true }; }
    else if (request.method === "tts.speak") result = await speak({ ...(params as unknown as TtsSpeakRequest), assistantId }) as unknown as JsonValue;
    else if (request.method === "tools.call") {
      const toolName = String(params.toolName ?? "");
      if (toolName.startsWith("ubuntu:")) {
        const decision = await getPermissionDecision(assistantId, "ubuntu:worker");
        if (decision !== "assistant" && decision !== "once") throw new Error("Ubuntu worker is not approved for this assistant");
        result = await callUbuntuTool(toolName.slice(7), params.arguments, undefined, assistantId);
      } else {
        const serverId = String(params.serverId ?? "");
        const runtime = await resolveAssistantRuntime(assistantId);
        if (!runtime.mcpServerIds.includes(serverId)) throw new Error(`MCP server ${serverId} is not enabled or approved for this assistant`);
        result = await callMcpTool(serverId, toolName, params.arguments, { assistantId });
      }
    } else result = params;
    return apiSuccess(success(request, result));
  } catch (error) {
    if (!request) return apiFailure(error);
    const response: ExtensionBridgeResponse = { type: "wuxianpi_bridge_response", requestId: request.requestId, extensionId: request.extensionId, nonce: request.nonce, ok: false, error: { code: "BRIDGE_ERROR", message: error instanceof Error ? error.message : String(error) } };
    return apiSuccess(response);
  }
}
