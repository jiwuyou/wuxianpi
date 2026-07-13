import type { McpActionData, McpActionRequest } from "@/lib/wuxianpi/contracts";
import { apiFailure, apiSuccess, WuxianPiApiError } from "@/lib/wuxianpi/api";
import { callMcpTool, cancelMcpCall, listMcpTools, testMcpServer } from "@/lib/wuxianpi/mcp-manager";
import { createPermissionRequest, getPermissionDecision } from "@/lib/wuxianpi/permission-manager";

async function requireMcpPermission(body: McpActionRequest): Promise<void> {
  if (!body.assistantId || body.action === "test" || body.action === "listTools") return;
  const capabilityId = `mcp:${body.serverId}`;
  const decision = await getPermissionDecision(body.assistantId, capabilityId);
  if (decision === "assistant" || decision === "once") return;
  if (decision !== "deny") createPermissionRequest({ assistantId: body.assistantId, capabilityId, title: "Use MCP server", description: `Allow this assistant to call ${body.serverId}`, risk: ["network", "external", "write"] });
  throw new WuxianPiApiError("MCP permission is required", 403, decision === "deny" ? "PERMISSION_DENIED" : "PERMISSION_REQUIRED");
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as McpActionRequest;
    await requireMcpPermission(body);
    const data: McpActionData = { serverId: body.serverId };
    if (body.action === "test") await testMcpServer(body.serverId);
    else if (body.action === "listTools") data.tools = await listMcpTools(body.serverId);
    else if (body.action === "call") {
      if (!body.toolName) throw new WuxianPiApiError("toolName is required");
      data.result = await callMcpTool(body.serverId, body.toolName, body.arguments, { callId: body.callId });
    } else if (body.action === "cancel") data.result = { cancelled: Boolean(body.callId && cancelMcpCall(body.callId)) };
    return apiSuccess(data);
  } catch (error) { return apiFailure(error); }
}
