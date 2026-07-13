import type { AssistantDetailData, AssistantMutationData, AssistantUpdateRequest } from "@/lib/wuxianpi/contracts";
import { apiFailure, apiSuccess } from "@/lib/wuxianpi/api";
import { deleteAssistant, getAssistant, readAssistantBundle, updateAssistant } from "@/lib/wuxianpi/assistant-manager";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const [assistant, bundle] = await Promise.all([getAssistant(id), readAssistantBundle(id)]);
    return apiSuccess<AssistantDetailData>({ assistant, files: bundle.files });
  } catch (error) { return apiFailure(error); }
}

export async function PATCH(request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const assistant = await updateAssistant(id, await request.json() as AssistantUpdateRequest);
    return apiSuccess<AssistantMutationData>({ assistant });
  } catch (error) { return apiFailure(error); }
}

export async function DELETE(request: Request, context: Context) {
  try {
    const { id } = await context.params;
    await deleteAssistant(id, new URL(request.url).searchParams.get("permanent") === "true");
    return apiSuccess({ id });
  } catch (error) { return apiFailure(error); }
}
