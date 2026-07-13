import type { UbuntuActionRequest } from "@/lib/wuxianpi/contracts";
import { apiFailure, apiSuccess, WuxianPiApiError } from "@/lib/wuxianpi/api";
import { callUbuntuTool, cancelUbuntuCall, getUbuntuStatus, shutdownUbuntuWorker, startUbuntuWorker } from "@/lib/wuxianpi/ubuntu-bridge";

export async function POST(request: Request) {
  try {
    const body = await request.json() as UbuntuActionRequest;
    if (body.action === "status") return apiSuccess(await getUbuntuStatus(false));
    if (body.action === "start") { await startUbuntuWorker(); return apiSuccess(await getUbuntuStatus(false)); }
    if (body.action === "listTools") return apiSuccess(await getUbuntuStatus(true));
    if (body.action === "shutdown") { await shutdownUbuntuWorker(); return apiSuccess(await getUbuntuStatus(false)); }
    if (!body.assistantId) throw new WuxianPiApiError("assistantId is required");
    if (body.action === "cancel") return apiSuccess(await cancelUbuntuCall(body.callId ?? "", body.assistantId));
    if (!body.toolName) throw new WuxianPiApiError("toolName is required");
    return apiSuccess(await callUbuntuTool(body.toolName, body.arguments, body.callId, body.assistantId));
  } catch (error) { return apiFailure(error); }
}
