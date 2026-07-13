import type { McpActionData, McpActionRequest } from "@/lib/wuxianpi/contracts";
import { apiFailure, apiSuccess, WuxianPiApiError } from "@/lib/wuxianpi/api";
import { callMcpTool, cancelMcpCall, listMcpTools, testMcpServer } from "@/lib/wuxianpi/mcp-manager";

export async function POST(request: Request) {
  try {
    const body = await request.json() as McpActionRequest;
    const data: McpActionData = { serverId: body.serverId };
    if (body.action === "test") await testMcpServer(body.serverId);
    else if (body.action === "listTools") data.tools = await listMcpTools(body.serverId);
    else if (body.action === "call") {
      if (!body.toolName) throw new WuxianPiApiError("toolName is required");
      if (!body.assistantId) throw new WuxianPiApiError("assistantId is required");
      data.result = await callMcpTool(body.serverId, body.toolName, body.arguments, { callId: body.callId, assistantId: body.assistantId });
    } else if (body.action === "cancel") data.result = { cancelled: Boolean(body.callId && cancelMcpCall(body.callId, body.assistantId)) };
    return apiSuccess(data);
  } catch (error) { return apiFailure(error); }
}
