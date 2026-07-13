import { randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { strFromU8, unzipSync } from "fflate";
import type { CapabilityDiagnostic, ExtensionBridgePermission, ExtensionBridgeRequest, JsonValue, WebExtensionManifestV1, WebExtensionSummary } from "./contracts";
import { WUXIANPI_SCHEMA_VERSION } from "./contracts";
import { assertSafeId, getWuxianPiPaths, isPathInside, webExtensionPath } from "./paths";
import { ensurePrivateDir, readJsonFile, removeIfExists, writeJsonAtomic } from "./storage";

declare global {
  var __wuxianpiBridgeNonces: Map<string, { extensionId: string; assistantId: string; expiresAt: number }> | undefined;
  var __wuxianpiExtensionStorageLocks: Map<string, Promise<void>> | undefined;
}

const nonces = () => globalThis.__wuxianpiBridgeNonces ??= new Map();
const storageLocks = () => globalThis.__wuxianpiExtensionStorageLocks ??= new Map();
const MAX_STORAGE_ITEM_BYTES = 256 * 1024;
const MAX_STORAGE_TOTAL_BYTES = 1024 * 1024;

function validateManifest(manifest: WebExtensionManifestV1): WebExtensionManifestV1 {
  if (manifest.schemaVersion !== WUXIANPI_SCHEMA_VERSION || manifest.apiVersion !== "1") throw new Error("Unsupported web extension schema or API version");
  assertSafeId(manifest.id, "extension id");
  if (!manifest.name?.trim() || !manifest.version?.trim()) throw new Error("Extension name and version are required");
  for (const entry of manifestEntries(manifest)) if (path.isAbsolute(entry) || entry.includes("..") || entry.includes("\\")) throw new Error(`Unsafe extension entry: ${entry}`);
  return manifest;
}

function manifestEntries(manifest: WebExtensionManifestV1): string[] {
  return [manifest.entry, ...Object.values(manifest.contributes ?? {}).flatMap((value) => Array.isArray(value) ? value.map((item) => "entry" in item ? item.entry : undefined) : [])].filter(Boolean) as string[];
}

async function readManifest(directory: string): Promise<WebExtensionManifestV1> {
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Extension path must be a real directory");
  return validateManifest(JSON.parse(await readFile(path.join(directory, "wuxianpi-extension.json"), "utf8")) as WebExtensionManifestV1);
}

export async function listWebExtensionSummaries(): Promise<WebExtensionSummary[]> {
  await ensurePrivateDir(getWuxianPiPaths().webExtensions);
  const entries = await readdir(getWuxianPiPaths().webExtensions, { withFileTypes: true });
  const output: WebExtensionSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(entry.name)) continue;
    const directory = webExtensionPath(entry.name);
    const diagnostics: CapabilityDiagnostic[] = [];
    try {
      const manifest = await readManifest(directory);
      if (manifest.id !== entry.name) throw new Error(`Extension manifest id ${manifest.id} does not match directory ${entry.name}`);
      output.push({ id: entry.name, path: directory, manifest, enabled: true, resourceBaseUrl: `/api/web-extensions/${encodeURIComponent(entry.name)}/assets/`, diagnostics });
    } catch (error) {
      output.push({ id: entry.name, path: directory, manifest: { schemaVersion: 1, apiVersion: "1", id: entry.name, name: entry.name, version: "invalid" }, enabled: false, resourceBaseUrl: `/api/web-extensions/${encodeURIComponent(entry.name)}/assets/`, diagnostics: [{ level: "error", code: "extension.invalid", message: String(error) }] });
    }
  }
  return output.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
}

export async function getWebExtensionSummary(id: string): Promise<WebExtensionSummary> {
  const extension = (await listWebExtensionSummaries()).find((item) => item.id === id);
  if (!extension) throw new Error(`Web extension not found: ${id}`);
  return extension;
}

export async function listWebExtensions(): Promise<WebExtensionManifestV1[]> {
  return (await listWebExtensionSummaries()).filter((item) => item.enabled).map((item) => item.manifest);
}

export async function installWebExtensionZip(bytes: Uint8Array): Promise<WebExtensionSummary> {
  await ensurePrivateDir(getWuxianPiPaths().webExtensions);
  if (bytes.byteLength > 25 * 1024 * 1024) throw new Error("Web extension bundle exceeds 25 MiB");
  let expandedBytes = 0;
  let fileCount = 0;
  const archive = unzipSync(bytes, { filter: (entry) => {
    if (!entry.name || entry.name.startsWith("/") || entry.name.includes("..") || entry.name.includes("\\")) throw new Error("Unsafe path in extension archive");
    fileCount += 1;
    expandedBytes += entry.originalSize;
    if (fileCount > 2_000 || expandedBytes > 50 * 1024 * 1024 || entry.originalSize > 10 * 1024 * 1024) throw new Error("Extension archive expands beyond safety limits");
    return !entry.name.endsWith("/");
  } });
  const manifestBytes = archive["wuxianpi-extension.json"];
  if (!manifestBytes) throw new Error("wuxianpi-extension.json is required at archive root");
  const manifest = validateManifest(JSON.parse(strFromU8(manifestBytes)) as WebExtensionManifestV1);
  for (const entry of manifestEntries(manifest)) if (!archive[entry]) throw new Error(`Extension entry is missing from archive: ${entry}`);
  const destination = webExtensionPath(manifest.id);
  try { await lstat(destination); throw new Error(`Extension ${manifest.id} already exists`); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await mkdir(destination, { recursive: false, mode: 0o700 });
  try {
    for (const [name, data] of Object.entries(archive)) {
      const target = path.join(destination, name);
      if (!isPathInside(destination, target)) throw new Error("Extension archive escaped destination");
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, data, { mode: 0o600 });
    }
    return (await listWebExtensionSummaries()).find((item) => item.id === manifest.id)!;
  } catch (error) {
    await removeIfExists(destination);
    throw error;
  }
}

export async function uninstallWebExtension(id: string): Promise<void> {
  await removeIfExists(webExtensionPath(id));
}

export async function readWebExtensionAsset(id: string, assetPath: string): Promise<{ data: Uint8Array; contentType: string }> {
  const root = webExtensionPath(id);
  const manifest = await readManifest(root);
  if (manifest.id !== id) throw new Error("Extension id does not match its directory");
  const target = path.resolve(root, assetPath);
  if (!isPathInside(root, target)) throw new Error("Asset path escapes extension directory");
  const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(target)]);
  if (!isPathInside(realRoot, realTarget)) throw new Error("Asset path resolves outside extension directory");
  const stat = await lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Extension asset is not a regular file");
  const ext = path.extname(target).toLowerCase();
  const contentType = ({ ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".woff2": "font/woff2" } as Record<string, string>)[ext] ?? "application/octet-stream";
  return { data: new Uint8Array(await readFile(target)), contentType };
}

export function issueBridgeNonce(extensionId: string, assistantId: string): string {
  const nonce = randomBytes(24).toString("base64url");
  nonces().set(nonce, { extensionId, assistantId, expiresAt: Date.now() + 30 * 60 * 1000 });
  return nonce;
}

export function validateBridgeNonce(nonce: string, extensionId: string): { assistantId: string } {
  const item = nonces().get(nonce);
  if (!item || item.extensionId !== extensionId || item.expiresAt <= Date.now()) {
    nonces().delete(nonce);
    throw new Error("Invalid or expired extension bridge nonce");
  }
  return { assistantId: item.assistantId };
}

export async function extensionStorageGet(extensionId: string, assistantId: string, key: string): Promise<JsonValue | undefined> {
  assertSafeId(extensionId, "extension id"); assertSafeId(assistantId, "assistant id"); assertStorageKey(key);
  const file = path.join(getWuxianPiPaths().extensionStorage, extensionId, `${assistantId}.json`);
  const value = (await readJsonFile<Record<string, JsonValue>>(file, {}))[key];
  if (value !== undefined && Buffer.byteLength(JSON.stringify(value)) > MAX_STORAGE_ITEM_BYTES) throw new Error("Stored extension value exceeds item limit");
  return value;
}

export async function extensionStorageSet(extensionId: string, assistantId: string, key: string, value: JsonValue): Promise<void> {
  assertSafeId(extensionId, "extension id"); assertSafeId(assistantId, "assistant id"); assertStorageKey(key);
  const file = path.join(getWuxianPiPaths().extensionStorage, extensionId, `${assistantId}.json`);
  const serializedValue = JSON.stringify(value);
  if (Buffer.byteLength(serializedValue) > MAX_STORAGE_ITEM_BYTES) throw new Error("Extension storage item exceeds 256 KiB");
  await withStorageLock(file, async () => {
    const data = await readJsonFile<Record<string, JsonValue>>(file, {});
    data[key] = value;
    if (Buffer.byteLength(JSON.stringify(data)) > MAX_STORAGE_TOTAL_BYTES) throw new Error("Extension storage exceeds 1 MiB per assistant");
    await writeJsonAtomic(file, data);
  });
}

function assertStorageKey(key: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(key)) throw new Error("Invalid extension storage key");
}

const bridgePermissionByMethod: Record<ExtensionBridgeRequest["method"], ExtensionBridgePermission> = {
  "assistant.get": "assistant.read", "storage.get": "storage.read", "storage.set": "storage.write", "tts.speak": "tts.speak", "tools.call": "tools.call",
  "ui.notify": "ui.notify", "ui.resize": "ui.resize", "ui.close": "ui.close",
};

export function assertWebExtensionBridgePermission(manifest: WebExtensionManifestV1, method: ExtensionBridgeRequest["method"]): ExtensionBridgePermission {
  const required = bridgePermissionByMethod[method];
  if (!manifest.permissions?.includes(required)) throw new Error(`Extension did not declare ${required}`);
  return required;
}

async function withStorageLock(file: string, operation: () => Promise<void>): Promise<void> {
  const previous = storageLocks().get(file) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  storageLocks().set(file, current);
  await previous;
  try { await operation(); }
  finally {
    release();
    if (storageLocks().get(file) === current) storageLocks().delete(file);
  }
}
