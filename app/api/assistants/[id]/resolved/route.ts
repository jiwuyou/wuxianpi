import { apiFailure, apiSuccess } from "@/lib/wuxianpi/api";
import { resolveAssistantRuntime } from "@/lib/wuxianpi/runtime-resolver";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const overridesParam = new URL(request.url).searchParams.get("overrides");
    const overrides = overridesParam ? JSON.parse(overridesParam) : {};
    return apiSuccess(await resolveAssistantRuntime(id, overrides));
  } catch (error) { return apiFailure(error); }
}
