import type { CapabilityCatalogData } from "@/lib/wuxianpi/contracts";
import { apiFailure, apiSuccess } from "@/lib/wuxianpi/api";
import { buildCapabilityCatalog } from "@/lib/wuxianpi/capability-registry";
import { readWuxianPiConfig } from "@/lib/wuxianpi/config-store";

export async function GET(request: Request) {
  try {
    const cwd = new URL(request.url).searchParams.get("cwd") ?? undefined;
    const [catalog, config] = await Promise.all([buildCapabilityCatalog(cwd), readWuxianPiConfig()]);
    return apiSuccess<CapabilityCatalogData>({ catalog, config });
  } catch (error) { return apiFailure(error); }
}
