import type { WebExtensionListData } from "@/lib/wuxianpi/contracts";
import { apiFailure, apiSuccess, WuxianPiApiError } from "@/lib/wuxianpi/api";
import { installWebExtensionZip, issueBridgeNonce, listWebExtensionSummaries, uninstallWebExtension } from "@/lib/wuxianpi/web-extension-manager";
import { getWebExtensionSummary } from "@/lib/wuxianpi/web-extension-manager";
import { getAssistant } from "@/lib/wuxianpi/assistant-manager";
import { resolveAssistantRuntime } from "@/lib/wuxianpi/runtime-resolver";

export async function GET() {
  try { return apiSuccess<WebExtensionListData>({ extensions: await listWebExtensionSummaries() }); }
  catch (error) { return apiFailure(error); }
}

export async function POST(request: Request) {
  try {
    const contentType = request.headers.get("content-type") ?? "";
    if (contentType.includes("multipart/form-data")) {
      const form = await request.formData();
      const file = form.get("file");
      if (!(file instanceof File)) throw new WuxianPiApiError("file is required");
      const extension = await installWebExtensionZip(new Uint8Array(await file.arrayBuffer()));
      return apiSuccess({ extension }, { status: 201 });
    }
    if (contentType.includes("application/zip") || contentType.includes("application/octet-stream")) {
      const extension = await installWebExtensionZip(new Uint8Array(await request.arrayBuffer()));
      return apiSuccess({ extension }, { status: 201 });
    }
    const body = await request.json() as { action: "nonce" | "uninstall"; extensionId: string; assistantId?: string };
    if (body.action === "uninstall") { await uninstallWebExtension(body.extensionId); return apiSuccess({ extensionId: body.extensionId, uninstalled: true }); }
    if (!body.assistantId) throw new WuxianPiApiError("assistantId is required");
    await Promise.all([getWebExtensionSummary(body.extensionId), getAssistant(body.assistantId)]);
    const runtime = await resolveAssistantRuntime(body.assistantId);
    if (!runtime.webExtensionIds.includes(body.extensionId)) throw new WuxianPiApiError("Web extension is not enabled or approved for this assistant", 403, "PERMISSION_REQUIRED");
    return apiSuccess({ extensionId: body.extensionId, assistantId: body.assistantId, nonce: issueBridgeNonce(body.extensionId, body.assistantId) });
  } catch (error) { return apiFailure(error); }
}
