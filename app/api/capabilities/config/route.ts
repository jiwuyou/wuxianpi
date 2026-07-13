import type { CapabilityConfigPatch } from "@/lib/wuxianpi/contracts";
import { apiFailure, apiSuccess } from "@/lib/wuxianpi/api";
import { readWuxianPiConfig, updateWuxianPiConfig } from "@/lib/wuxianpi/config-store";
import { maskWuxianPiConfig, restoreMaskedMcpServers, restoreMaskedTtsProfiles } from "@/lib/wuxianpi/secret-store";

export async function GET() { try { return apiSuccess(maskWuxianPiConfig(await readWuxianPiConfig())); } catch (error) { return apiFailure(error); } }

export async function PATCH(request: Request) {
  try {
    const patch = await request.json() as CapabilityConfigPatch;
    const config = await updateWuxianPiConfig((current) => ({
      ...current,
      defaults: { ...current.defaults, ...(patch.defaults ?? {}) },
      mcpServers: patch.mcpServers ? restoreMaskedMcpServers(patch.mcpServers, current.mcpServers) : current.mcpServers,
      ttsProfiles: patch.ttsProfiles ? restoreMaskedTtsProfiles(patch.ttsProfiles, current.ttsProfiles) : current.ttsProfiles,
      ubuntu: patch.ubuntu === undefined ? current.ubuntu : patch.ubuntu,
    }));
    return apiSuccess(maskWuxianPiConfig(config));
  } catch (error) { return apiFailure(error); }
}
