import type { JsonValue, TtsSpeakRequest } from "@/lib/wuxianpi/contracts";
import { apiFailure, apiSuccess } from "@/lib/wuxianpi/api";
import { speak } from "@/lib/wuxianpi/tts-manager";
import { readWuxianPiConfig } from "@/lib/wuxianpi/config-store";
import { maskWuxianPiConfig } from "@/lib/wuxianpi/secret-store";

export async function GET() {
  try { return apiSuccess({ profiles: maskWuxianPiConfig(await readWuxianPiConfig()).ttsProfiles }); }
  catch (error) { return apiFailure(error); }
}

export async function POST(request: Request) {
  try { return apiSuccess(await speak(await request.json() as TtsSpeakRequest) as unknown as JsonValue); }
  catch (error) { return apiFailure(error); }
}
