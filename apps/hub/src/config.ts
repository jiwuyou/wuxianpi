import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PublisherCredential } from "./types.js";

export interface HubConfig {
  host: string;
  port: number;
  dbPath: string;
  publicUrl: string;
  publicDir: string;
  assetDir: string;
  packageSchema: object;
  adminToken: string;
  publisherCredentials: Map<string, PublisherCredential>;
  githubClientId: string;
  sessionDays: number;
  maxDownloadBytes: number;
  mirrorServiceUrl: string;
  mirrorServiceToken: string;
}

function parsePublisherCredentials(raw: string | undefined): Map<string, PublisherCredential> {
  const result = new Map<string, PublisherCredential>();
  if (!raw) return result;
  const values = JSON.parse(raw) as Record<string, string | { token: string; name?: string; profileUrl?: string | null }>;
  for (const [id, value] of Object.entries(values)) {
    if (typeof value === "string") {
      result.set(id, { id, token: value, name: id, profileUrl: null });
    } else {
      result.set(id, { id, token: value.token, name: value.name ?? id, profileUrl: value.profileUrl ?? null });
    }
  }
  return result;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): HubConfig {
  const port = Number.parseInt(env.HUB_PORT ?? "20878", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("HUB_PORT is invalid");
  const maxDownloadBytes = Number.parseInt(env.HUB_VERIFY_MAX_BYTES ?? String(256 * 1024 * 1024), 10);
  if (!Number.isInteger(maxDownloadBytes) || maxDownloadBytes < 1024) throw new Error("HUB_VERIFY_MAX_BYTES is invalid");
  const sessionDays = Number.parseInt(env.HUB_SESSION_DAYS ?? "30", 10);
  if (!Number.isInteger(sessionDays) || sessionDays < 1 || sessionDays > 365) throw new Error("HUB_SESSION_DAYS is invalid");
  const packageSchemaPath = resolve(env.HUB_PACKAGE_SCHEMA ?? "contracts/wuxianpi-package.schema.json");
  return {
    host: env.HUB_HOST ?? "127.0.0.1",
    port,
    dbPath: resolve(env.HUB_DB_PATH ?? "data/hub.sqlite"),
    publicUrl: (env.HUB_PUBLIC_URL ?? `http://127.0.0.1:${port}`).replace(/\/$/, ""),
    publicDir: resolve(env.HUB_PUBLIC_DIR ?? "public"),
    assetDir: resolve(env.HUB_ASSET_DIR ?? "data/assets"),
    packageSchema: JSON.parse(readFileSync(packageSchemaPath, "utf8")) as object,
    adminToken: env.HUB_ADMIN_TOKEN ?? "",
    publisherCredentials: parsePublisherCredentials(env.HUB_PUBLISHER_TOKENS),
    githubClientId: env.HUB_GITHUB_CLIENT_ID?.trim() ?? "",
    sessionDays,
    maxDownloadBytes,
    mirrorServiceUrl: env.HUB_MIRROR_SERVICE_URL?.trim().replace(/\/$/, "") ?? "",
    mirrorServiceToken: env.HUB_MIRROR_SERVICE_TOKEN?.trim() ?? "",
  };
}
