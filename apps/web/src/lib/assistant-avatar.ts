import type { AssistantAvatarAssetMutation, AssistantSummary } from "@/lib/wuxianpi/contracts";

const INPUT_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_INPUT_BYTES = 4 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const AVATAR_SIZE = 512;

export function assistantAvatarUrl(assistant: Pick<AssistantSummary, "id" | "manifest"> | null | undefined): string | null {
  const avatar = assistant?.manifest.avatar?.trim();
  if (!assistant || !avatar) return null;
  if (/^https?:\/\//i.test(avatar)) return avatar;
  if (avatar.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(avatar) || avatar.startsWith("/")) return null;
  const segments = avatar.replace(/\\/g, "/").split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return null;
  return `/api/web/v1/assistants/${encodeURIComponent(assistant.id)}/avatar?v=${encodeURIComponent(avatar)}`;
}

export function assistantAvatarBackground(url: string): string {
  return `url(${JSON.stringify(url)})`;
}

export async function prepareAssistantAvatar(file: File): Promise<{
  mutation: Extract<AssistantAvatarAssetMutation, { action: "upload" }>;
  previewUrl: string;
}> {
  if (!INPUT_TYPES.has(file.type)) throw new Error("请选择 PNG、JPEG 或 WebP 图片。");
  if (file.size <= 0 || file.size > MAX_INPUT_BYTES) throw new Error("头像原图不能超过 4 MiB。");

  const bitmap = await createImageBitmap(file);
  try {
    const sourceSize = Math.min(bitmap.width, bitmap.height);
    if (!sourceSize) throw new Error("无法读取头像尺寸。");
    const sourceX = Math.floor((bitmap.width - sourceSize) / 2);
    const sourceY = Math.floor((bitmap.height - sourceSize) / 2);
    const outputSize = Math.min(AVATAR_SIZE, sourceSize);
    const canvas = document.createElement("canvas");
    canvas.width = outputSize;
    canvas.height = outputSize;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("浏览器无法处理头像图片。");
    context.drawImage(bitmap, sourceX, sourceY, sourceSize, sourceSize, 0, 0, outputSize, outputSize);
    const blob = await canvasBlob(canvas, "image/webp", 0.86);
    if (!INPUT_TYPES.has(blob.type)) throw new Error("浏览器无法生成受支持的头像格式。");
    if (blob.size <= 0 || blob.size > MAX_OUTPUT_BYTES) throw new Error("处理后的头像仍超过 1 MiB，请选择更简单的图片。");
    return {
      mutation: { action: "upload", mimeType: blob.type as "image/png" | "image/jpeg" | "image/webp", data: await blobBase64(blob) },
      previewUrl: URL.createObjectURL(blob),
    };
  } finally {
    bitmap.close();
  }
}

function canvasBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob(
    (blob) => blob ? resolve(blob) : reject(new Error("浏览器无法编码头像图片。")),
    type,
    quality,
  ));
}

function blobBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = typeof reader.result === "string" ? reader.result : "";
      const comma = value.indexOf(",");
      if (comma < 0) reject(new Error("浏览器无法读取头像图片。"));
      else resolve(value.slice(comma + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error("浏览器无法读取头像图片。"));
    reader.readAsDataURL(blob);
  });
}
