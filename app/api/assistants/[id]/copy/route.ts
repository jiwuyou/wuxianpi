import type { AssistantCopyRequest, AssistantMutationData } from "@/lib/wuxianpi/contracts";
import { apiFailure, apiSuccess } from "@/lib/wuxianpi/api";
import { cloneAssistant } from "@/lib/wuxianpi/assistant-manager";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await request.json() as AssistantCopyRequest;
    const assistant = await cloneAssistant(id, body.targetId, body.name);
    return apiSuccess<AssistantMutationData>({ assistant }, { status: 201 });
  } catch (error) { return apiFailure(error); }
}
