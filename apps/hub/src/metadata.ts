import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PackagePresentationMetadata, ScreenshotMetadata } from "./types.js";
import { HubError } from "./errors.js";

const HTTPS_URL = /^https:\/\/[^\s]+$/;
const SHA256 = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const LINK_KINDS = new Set(["homepage", "source", "documentation", "support", "license"]);
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

function assertUniqueIds(items: Array<{ id: string }>, label: string): void {
  const ids = new Set<string>();
  for (const item of items) {
    if (!ID.test(item.id)) throw new HubError(400, "invalid_metadata", `${label} has an invalid id: ${item.id}`);
    if (ids.has(item.id)) throw new HubError(400, "invalid_metadata", `${label} contains duplicate id: ${item.id}`);
    ids.add(item.id);
  }
}

export function validatePublisherMetadata(value: unknown): PackagePresentationMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HubError(400, "invalid_metadata", "metadata must be an object");
  }
  const input = value as Record<string, unknown>;
  if (!Array.isArray(input.links) || !Array.isArray(input.screenshots)) {
    throw new HubError(400, "invalid_metadata", "metadata.links and metadata.screenshots are required arrays");
  }

  const links = input.links.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new HubError(400, "invalid_metadata", "Invalid link metadata");
    const link = raw as Record<string, unknown>;
    if (link.source !== "publisher") throw new HubError(400, "invalid_metadata_source", "Publisher links must use source=publisher");
    if (typeof link.id !== "string" || typeof link.label !== "string" || typeof link.url !== "string" || typeof link.kind !== "string") {
      throw new HubError(400, "invalid_metadata", "Link fields are incomplete");
    }
    if (!LINK_KINDS.has(link.kind) || !HTTPS_URL.test(link.url)) throw new HubError(400, "invalid_metadata", "Link kind or URL is invalid");
    return {
      id: link.id,
      kind: link.kind as PackagePresentationMetadata["links"][number]["kind"],
      label: link.label,
      url: link.url,
      source: "publisher" as const,
    };
  });

  const screenshots = input.screenshots.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new HubError(400, "invalid_metadata", "Invalid screenshot metadata");
    const item = raw as Record<string, unknown>;
    if (item.source !== "publisher") throw new HubError(400, "invalid_metadata_source", "Publisher screenshots must use source=publisher");
    if (
      typeof item.id !== "string" || typeof item.alt !== "string" || typeof item.mediaType !== "string" ||
      typeof item.width !== "number" || typeof item.height !== "number" || typeof item.sha256 !== "string" ||
      !Array.isArray(item.downloadSources)
    ) throw new HubError(400, "invalid_metadata", "Screenshot fields are incomplete");
    if (!IMAGE_TYPES.has(item.mediaType) || !Number.isInteger(item.width) || item.width <= 0 || !Number.isInteger(item.height) || item.height <= 0 || !SHA256.test(item.sha256)) {
      throw new HubError(400, "invalid_metadata", "Screenshot media metadata is invalid");
    }
    if (item.downloadSources.length === 0) throw new HubError(400, "invalid_metadata", "Screenshot requires at least one download source");
    const downloadSources = item.downloadSources.map((sourceRaw) => {
      if (!sourceRaw || typeof sourceRaw !== "object" || Array.isArray(sourceRaw)) throw new HubError(400, "invalid_metadata", "Invalid screenshot source");
      const source = sourceRaw as Record<string, unknown>;
      if ((source.kind !== "github" && source.kind !== "mirror") || typeof source.url !== "string" || !HTTPS_URL.test(source.url) || typeof source.priority !== "number" || !Number.isInteger(source.priority) || source.priority < 0 || source.priority > 1000) {
        throw new HubError(400, "invalid_metadata", "Screenshot download source is invalid");
      }
      return { kind: source.kind as "github" | "mirror", url: source.url, priority: source.priority };
    });
    return {
      id: item.id,
      alt: item.alt,
      mediaType: item.mediaType as ScreenshotMetadata["mediaType"],
      width: item.width,
      height: item.height,
      sha256: item.sha256,
      source: "publisher" as const,
      downloadSources,
    };
  });

  assertUniqueIds(links, "links");
  assertUniqueIds(screenshots, "screenshots");
  return { links, screenshots };
}

function pngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24 || Buffer.from(bytes.subarray(0, 8)).toString("hex") !== "89504e470d0a1a0a") return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) { offset += 1; continue; }
    const marker = bytes[offset + 1] ?? 0;
    if (marker >= 0xc0 && marker <= 0xc3) {
      return { width: ((bytes[offset + 7] ?? 0) << 8) + (bytes[offset + 8] ?? 0), height: ((bytes[offset + 5] ?? 0) << 8) + (bytes[offset + 6] ?? 0) };
    }
    const length = ((bytes[offset + 2] ?? 0) << 8) + (bytes[offset + 3] ?? 0);
    if (length < 2) break;
    offset += length + 2;
  }
  return null;
}

function webpDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 30 || Buffer.from(bytes.subarray(0, 4)).toString("ascii") !== "RIFF" || Buffer.from(bytes.subarray(8, 12)).toString("ascii") !== "WEBP") return null;
  const kind = Buffer.from(bytes.subarray(12, 16)).toString("ascii");
  if (kind === "VP8X") {
    return {
      width: 1 + (bytes[24] ?? 0) + ((bytes[25] ?? 0) << 8) + ((bytes[26] ?? 0) << 16),
      height: 1 + (bytes[27] ?? 0) + ((bytes[28] ?? 0) << 8) + ((bytes[29] ?? 0) << 16),
    };
  }
  if (kind === "VP8 " && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return {
      width: ((bytes[27] ?? 0) << 8 | (bytes[26] ?? 0)) & 0x3fff,
      height: ((bytes[29] ?? 0) << 8 | (bytes[28] ?? 0)) & 0x3fff,
    };
  }
  if (kind === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
    const bits = (bytes[21] ?? 0) | ((bytes[22] ?? 0) << 8) | ((bytes[23] ?? 0) << 16) | ((bytes[24] ?? 0) << 24);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  return null;
}

export interface DownloadVerifier {
  fetchBytes(url: string, maxBytes: number): Promise<{ bytes: Uint8Array; contentType: string | null }>;
}

export class FetchDownloadVerifier implements DownloadVerifier {
  async fetchBytes(url: string, maxBytes: number): Promise<{ bytes: Uint8Array; contentType: string | null }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(url, { signal: controller.signal, redirect: "follow" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const declared = Number(response.headers.get("content-length") ?? "0");
      if (declared > maxBytes) throw new Error(`Object exceeds ${maxBytes} bytes`);
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Response body is unavailable");
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        total += next.value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          throw new Error(`Object exceeds ${maxBytes} bytes`);
        }
        chunks.push(next.value);
      }
      return { bytes: Buffer.concat(chunks), contentType: response.headers.get("content-type")?.split(";", 1)[0] ?? null };
    } finally {
      clearTimeout(timer);
    }
  }
}

export interface VerifiedAsset {
  bytes: Uint8Array;
  mediaType: ScreenshotMetadata["mediaType"];
}

export class VerifiedAssetStore {
  constructor(private readonly directory: string) {}

  async put(sha256: string, mediaType: ScreenshotMetadata["mediaType"], bytes: Uint8Array): Promise<void> {
    if (!SHA256.test(sha256) || createHash("sha256").update(bytes).digest("hex") !== sha256) {
      throw new Error("Verified asset digest does not match its content address");
    }
    await mkdir(this.directory, { recursive: true });
    const suffix = randomUUID();
    const bytesTemp = join(this.directory, `${sha256}.${suffix}.tmp`);
    const metadataTemp = join(this.directory, `${sha256}.${suffix}.json.tmp`);
    try {
      await writeFile(bytesTemp, bytes);
      await writeFile(metadataTemp, JSON.stringify({ mediaType }));
      await rename(bytesTemp, join(this.directory, sha256));
      await rename(metadataTemp, join(this.directory, `${sha256}.json`));
    } finally {
      await rm(bytesTemp, { force: true });
      await rm(metadataTemp, { force: true });
    }
  }

  async get(sha256: string): Promise<VerifiedAsset | null> {
    if (!SHA256.test(sha256)) return null;
    try {
      const [bytes, metadataBytes] = await Promise.all([
        readFile(join(this.directory, sha256)),
        readFile(join(this.directory, `${sha256}.json`), "utf8"),
      ]);
      if (createHash("sha256").update(bytes).digest("hex") !== sha256) return null;
      const metadata = JSON.parse(metadataBytes) as { mediaType?: unknown };
      if (!IMAGE_TYPES.has(String(metadata.mediaType))) return null;
      return { bytes, mediaType: metadata.mediaType as ScreenshotMetadata["mediaType"] };
    } catch {
      return null;
    }
  }
}

export async function verifyScreenshot(
  screenshot: ScreenshotMetadata,
  downloader: DownloadVerifier,
  maxBytes: number,
): Promise<Uint8Array> {
  const failures: string[] = [];
  for (const source of [...screenshot.downloadSources].sort((a, b) => b.priority - a.priority)) {
    try {
      const { bytes, contentType } = await downloader.fetchBytes(source.url, maxBytes);
      if (createHash("sha256").update(bytes).digest("hex") !== screenshot.sha256) throw new Error("SHA-256 mismatch");
      if (contentType && contentType !== screenshot.mediaType) throw new Error(`Expected ${screenshot.mediaType}, received ${contentType}`);
      const dimensions = screenshot.mediaType === "image/png" ? pngDimensions(bytes)
        : screenshot.mediaType === "image/jpeg" ? jpegDimensions(bytes)
        : webpDimensions(bytes);
      if (!dimensions) throw new Error(`Unsupported or invalid ${screenshot.mediaType} data`);
      if (dimensions.width !== screenshot.width || dimensions.height !== screenshot.height) throw new Error("Image dimensions do not match metadata");
      return bytes;
    } catch (error) {
      failures.push(`${source.url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`Screenshot ${screenshot.id} failed verification: ${failures.join("; ")}`);
}

export async function verifyArtifact(
  artifact: { id: string; sha256: string; sizeBytes: number; sources: Array<{ url: string; priority: number }> },
  downloader: DownloadVerifier,
  maxBytes: number,
): Promise<void> {
  if (artifact.sizeBytes > maxBytes) throw new Error(`Artifact ${artifact.id} exceeds Hub verification limit`);
  const failures: string[] = [];
  for (const source of [...artifact.sources].sort((a, b) => b.priority - a.priority)) {
    try {
      const { bytes } = await downloader.fetchBytes(source.url, maxBytes);
      if (bytes.byteLength !== artifact.sizeBytes) throw new Error(`Expected ${artifact.sizeBytes} bytes, received ${bytes.byteLength}`);
      if (createHash("sha256").update(bytes).digest("hex") !== artifact.sha256) throw new Error("SHA-256 mismatch");
      return;
    } catch (error) {
      failures.push(`${source.url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`Artifact ${artifact.id} failed verification: ${failures.join("; ")}`);
}
