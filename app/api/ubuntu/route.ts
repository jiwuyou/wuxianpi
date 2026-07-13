import type { UbuntuActionRequest } from "@/lib/wuxianpi/contracts";
import { apiFailure, apiSuccess, WuxianPiApiError } from "@/lib/wuxianpi/api";
import { callUbuntuTool, cancelUbuntuCall, getUbuntuStatus, shutdownUbuntuWorker, startUbuntuWorker } from "@/lib/wuxianpi/ubuntu-bridge";
import { createPermissionRequest, getPermissionDecision } from "@/lib/wuxianpi/permission-manager";

export async function POST(request: Request) {
  try {
    const body = await request.json() as UbuntuActionRequest;
    if (body.action === "status") return apiSuccess(await getUbuntuStatus(false));
    if (body.action === "start") { await startUbuntuWorker(); return apiSuccess(await getUbuntuStatus(false)); }
    if (body.action === "listTools") return apiSuccess(await getUbuntuStatus(true));
    if (body.action === "shutdown") { await shutdownUbuntuWorker(); return apiSuccess(await getUbuntuStatus(false)); }
    if (!body.assistantId) throw new WuxianPiApiError("assistantId is required");
    const decision = await getPermissionDecision(body.assistantId, "ubuntu:worker");
    if (decision !== "assistant" && decision !== "once") {
      if (decision !== "deny") createPermissionRequest({ assistantId: body.assistantId, capabilityId: "ubuntu:worker", title: "Use Ubuntu worker", description: "Allow execution in the optional Ubuntu environment", risk: ["execute", "write", "network"] });
      throw new WuxianPiApiError("Ubuntu worker permission is required", 403, decision === "deny" ? "PERMISSION_DENIED" : "PERMISSION_REQUIRED");
    }
    if (body.action === "cancel") return apiSuccess(await cancelUbuntuCall(body.callId ?? ""));
    if (!body.toolName) throw new WuxianPiApiError("toolName is required");
    return apiSuccess(await callUbuntuTool(body.toolName, body.arguments, body.callId, body.assistantId));
  } catch (error) { return apiFailure(error); }
}
