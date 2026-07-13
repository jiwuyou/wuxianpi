import type { PermissionMutationRequest, PermissionStateData } from "@/lib/wuxianpi/contracts";
import { apiFailure, apiSuccess } from "@/lib/wuxianpi/api";
import { listPermissionGrants, listPermissionRequests, resolvePermissionRequest, revokePermission } from "@/lib/wuxianpi/permission-manager";
import { destroyRpcSessionsForAssistant } from "@/lib/rpc-manager";

export async function GET(request: Request) {
  try {
    const assistantId = new URL(request.url).searchParams.get("assistantId") ?? undefined;
    return apiSuccess<PermissionStateData>({ pending: listPermissionRequests(assistantId), grants: await listPermissionGrants(assistantId) });
  } catch (error) { return apiFailure(error); }
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as PermissionMutationRequest;
    if (body.action === "decide") {
      const resolved = await resolvePermissionRequest(body.request.requestId, body.request.decision);
      destroyRpcSessionsForAssistant(resolved.assistantId);
    } else {
      await revokePermission(body.request.assistantId, body.request.capabilityId);
      destroyRpcSessionsForAssistant(body.request.assistantId);
    }
    return apiSuccess<PermissionStateData>({ pending: listPermissionRequests(), grants: await listPermissionGrants() });
  } catch (error) { return apiFailure(error); }
}
