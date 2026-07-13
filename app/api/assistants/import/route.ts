import type { AssistantMutationData } from "@/lib/wuxianpi/contracts";
import { apiFailure, apiSuccess, WuxianPiApiError } from "@/lib/wuxianpi/api";
import { importAssistantZip } from "@/lib/wuxianpi/assistant-manager";

export async function POST(request: Request) {
  try {
    const contentType = request.headers.get("content-type") ?? "";
    let id: string | null = new URL(request.url).searchParams.get("id");
    let bytes: Uint8Array;
    if (contentType.includes("multipart/form-data")) {
      const form = await request.formData();
      id = id ?? (typeof form.get("id") === "string" ? String(form.get("id")) : null);
      const file = form.get("file");
      if (!(file instanceof File)) throw new WuxianPiApiError("file is required");
      bytes = new Uint8Array(await file.arrayBuffer());
    } else bytes = new Uint8Array(await request.arrayBuffer());
    if (!id) throw new WuxianPiApiError("assistant id is required");
    return apiSuccess<AssistantMutationData>({ assistant: await importAssistantZip(id, bytes) }, { status: 201 });
  } catch (error) { return apiFailure(error); }
}
