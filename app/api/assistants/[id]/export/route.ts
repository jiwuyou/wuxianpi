import { apiFailure } from "@/lib/wuxianpi/api";
import { exportAssistantZip } from "@/lib/wuxianpi/assistant-manager";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const zip = await exportAssistantZip(id);
    return new Response(Buffer.from(zip), { headers: { "content-type": "application/zip", "content-disposition": `attachment; filename="${id}.zip"`, "cache-control": "no-store" } });
  } catch (error) { return apiFailure(error); }
}
