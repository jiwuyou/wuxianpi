import { apiFailure } from "@/lib/wuxianpi/api";
import { readWebExtensionAsset } from "@/lib/wuxianpi/web-extension-manager";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string; path: string[] }> }) {
  try {
    const { id, path } = await params;
    const asset = await readWebExtensionAsset(id, path.join("/"));
    return new Response(Buffer.from(asset.data), { headers: { "content-type": asset.contentType, "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; frame-ancestors 'self';", "x-content-type-options": "nosniff", "cache-control": "private, max-age=300" } });
  } catch (error) { return apiFailure(error); }
}
