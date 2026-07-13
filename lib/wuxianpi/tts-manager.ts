import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { JsonValue, TtsClientInstruction, TtsProfile, TtsSpeakRequest } from "./contracts";
import { readWuxianPiConfig } from "./config-store";
import { getSecret } from "./secret-store";

const execFileAsync = promisify(execFile);

export type TtsResult =
  | { kind: "client"; instruction: TtsClientInstruction }
  | { kind: "audio"; mimeType: string; data: string }
  | { kind: "completed"; provider: "termux-api" };

function prepareText(text: string, readCode = false): string {
  let result = text.trim();
  if (!readCode) result = result.replace(/```[\s\S]*?```/g, "（代码块已省略）").replace(/`([^`]+)`/g, "$1");
  result = result.replace(/<details[\s\S]*?<\/details>/gi, "").replace(/\[(.*?)\]\([^)]*\)/g, "$1");
  if (!result) throw new Error("There is no speakable text");
  if (result.length > 20_000) throw new Error("TTS text exceeds 20,000 characters");
  return result;
}

async function getProfile(profileId: string): Promise<TtsProfile> {
  const profile = (await readWuxianPiConfig()).ttsProfiles.find((item) => item.id === profileId);
  if (!profile) throw new Error(`Unknown TTS profile: ${profileId}`);
  if (profile.enabled === false) throw new Error(`TTS profile is disabled: ${profileId}`);
  return profile;
}

function validatedBaseUrl(profile: TtsProfile): URL {
  if (!profile.baseUrl) throw new Error(`TTS profile ${profile.id} is missing baseUrl`);
  const url = new URL(profile.baseUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("TTS baseUrl must use http or https");
  return url;
}

async function cloudSpeak(profile: TtsProfile, request: TtsSpeakRequest, text: string): Promise<TtsResult> {
  const base = validatedBaseUrl(profile);
  const url = profile.provider === "openai-compatible" ? new URL("audio/speech", base.href.endsWith("/") ? base : new URL(`${base.href}/`)) : base;
  const headers: Record<string, string> = { "content-type": "application/json", ...(profile.headers ?? {}) };
  if (profile.secretRef) {
    const secret = await getSecret(profile.secretRef);
    if (!secret) throw new Error(`Missing TTS secret: ${profile.secretRef}`);
    headers.authorization = `Bearer ${secret}`;
  }
  const body: JsonValue = profile.provider === "openai-compatible"
    ? { model: profile.model ?? "tts-1", voice: profile.voice ?? "alloy", input: text, speed: request.rate ?? profile.rate ?? 1 }
    : { text, voice: profile.voice ?? "", model: profile.model ?? "", rate: request.rate ?? profile.rate ?? 1, pitch: request.pitch ?? profile.pitch ?? 0 };
  const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`TTS provider returned ${response.status}: ${(await response.text()).slice(0, 500)}`);
  const mimeType = response.headers.get("content-type")?.split(";")[0] || "audio/mpeg";
  if (mimeType.includes("json")) {
    const json = await response.json() as { audio?: string; data?: string; mimeType?: string };
    const data = json.audio ?? json.data;
    if (!data) throw new Error("TTS JSON response did not include audio or data");
    return { kind: "audio", mimeType: json.mimeType ?? "audio/mpeg", data };
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > 25 * 1024 * 1024) throw new Error("TTS audio exceeds 25 MiB");
  return { kind: "audio", mimeType, data: Buffer.from(bytes).toString("base64") };
}

export async function speak(request: TtsSpeakRequest): Promise<TtsResult> {
  const profile = await getProfile(request.profileId);
  const text = prepareText(request.text, request.readCode);
  const rate = request.rate ?? profile.rate;
  const pitch = request.pitch ?? profile.pitch;
  if (profile.provider === "browser-speech") {
    return { kind: "client", instruction: { kind: "browser-speech", text, voice: profile.voice, rate, pitch } };
  }
  if (profile.provider === "termux-api") {
    const args = [text];
    if (profile.voice) args.unshift("-v", profile.voice);
    if (rate !== undefined) args.unshift("-r", String(rate));
    if (pitch !== undefined) args.unshift("-p", String(pitch));
    await execFileAsync("termux-tts-speak", args, { timeout: 120_000, maxBuffer: 1024 * 1024 });
    return { kind: "completed", provider: "termux-api" };
  }
  return cloudSpeak(profile, request, text);
}
