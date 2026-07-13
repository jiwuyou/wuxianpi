import type { AssistantCreateRequest, AssistantListData, AssistantMutationData } from "@/lib/wuxianpi/contracts";
import { apiFailure, apiSuccess } from "@/lib/wuxianpi/api";
import { createAssistant, listAssistants } from "@/lib/wuxianpi/assistant-manager";
import { listAllSessions } from "@/lib/session-reader";
import { assistantIdFromCwd } from "@/lib/wuxianpi/paths";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const includeArchived = new URL(request.url).searchParams.get("includeArchived") === "true";
    const [assistants, sessions] = await Promise.all([listAssistants({ includeArchived }), listAllSessions()]);
    const data: AssistantListData = { assistants, legacySessionCount: sessions.filter((session) => !assistantIdFromCwd(session.cwd)).length };
    return apiSuccess(data);
  } catch (error) { return apiFailure(error); }
}

export async function POST(request: Request) {
  try {
    const assistant = await createAssistant(await request.json() as AssistantCreateRequest);
    return apiSuccess<AssistantMutationData>({ assistant }, { status: 201 });
  } catch (error) { return apiFailure(error); }
}
