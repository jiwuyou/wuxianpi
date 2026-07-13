import type { GlobalWuxianPiConfigV1 } from "./contracts";
import { WUXIANPI_SCHEMA_VERSION } from "./contracts";
import { assertSafeId, getWuxianPiPaths } from "./paths";
import { readJsonFile, writeJsonAtomic } from "./storage";

export const DEFAULT_WUXIANPI_CONFIG: GlobalWuxianPiConfigV1 = {
  schemaVersion: WUXIANPI_SCHEMA_VERSION,
  defaults: {
    thinkingLevel: "medium",
    tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
    skills: [],
    mcpServers: [],
    webExtensions: [],
    maxLiveSessions: 2,
    idleSessionMs: 2 * 60 * 1000,
  },
  mcpServers: [],
  ttsProfiles: [
    { id: "browser:default", name: "Browser speech", provider: "browser-speech", enabled: true },
    { id: "termux:default", name: "Android system voice", provider: "termux-api", enabled: true },
  ],
  permissions: [],
  ubuntu: { enabled: false, distro: "ubuntu", nodePath: "node", idleTimeoutMs: 5 * 60 * 1000 },
};

function mergeConfig(raw: Partial<GlobalWuxianPiConfigV1>): GlobalWuxianPiConfigV1 {
  const merged: GlobalWuxianPiConfigV1 = {
    ...DEFAULT_WUXIANPI_CONFIG,
    ...raw,
    schemaVersion: WUXIANPI_SCHEMA_VERSION,
    defaults: { ...DEFAULT_WUXIANPI_CONFIG.defaults, ...(raw.defaults ?? {}) },
    mcpServers: Array.isArray(raw.mcpServers) ? raw.mcpServers : [],
    ttsProfiles: Array.isArray(raw.ttsProfiles) ? raw.ttsProfiles : DEFAULT_WUXIANPI_CONFIG.ttsProfiles,
    permissions: Array.isArray(raw.permissions) ? raw.permissions : [],
    ubuntu: { ...DEFAULT_WUXIANPI_CONFIG.ubuntu!, ...(raw.ubuntu ?? {}) },
  };
  merged.defaults.maxLiveSessions = Math.min(10, Math.max(1, merged.defaults.maxLiveSessions ?? 2));
  merged.defaults.idleSessionMs = Math.min(60 * 60 * 1000, Math.max(30_000, merged.defaults.idleSessionMs ?? 120_000));
  const mcpIds = new Set<string>();
  for (const server of merged.mcpServers) {
    assertSafeId(server.id, "MCP server id");
    if (mcpIds.has(server.id)) throw new Error(`Duplicate MCP server id: ${server.id}`);
    mcpIds.add(server.id);
    if (server.transport === "stdio" && !server.command) throw new Error(`MCP stdio server ${server.id} requires command`);
    if (server.transport === "streamable-http") {
      if (!server.url) throw new Error(`MCP HTTP server ${server.id} requires url`);
      const url = new URL(server.url);
      if (!["http:", "https:"].includes(url.protocol)) throw new Error(`MCP server ${server.id} must use http or https`);
    }
  }
  const ttsIds = new Set<string>();
  for (const profile of merged.ttsProfiles) {
    if (!/^[a-z0-9][a-z0-9._:-]{0,127}$/.test(profile.id)) throw new Error(`Invalid TTS profile id: ${profile.id}`);
    if (ttsIds.has(profile.id)) throw new Error(`Duplicate TTS profile id: ${profile.id}`);
    ttsIds.add(profile.id);
  }
  return merged;
}

export async function readWuxianPiConfig(): Promise<GlobalWuxianPiConfigV1> {
  const raw = await readJsonFile<Partial<GlobalWuxianPiConfigV1>>(getWuxianPiPaths().config, {});
  if (raw.schemaVersion !== undefined && raw.schemaVersion !== WUXIANPI_SCHEMA_VERSION) {
    throw new Error(`Unsupported WuxianPi config schema: ${raw.schemaVersion}`);
  }
  return mergeConfig(raw);
}

export async function writeWuxianPiConfig(config: GlobalWuxianPiConfigV1): Promise<GlobalWuxianPiConfigV1> {
  const normalized = mergeConfig(config);
  await writeJsonAtomic(getWuxianPiPaths().config, normalized);
  return normalized;
}

export async function updateWuxianPiConfig(
  updater: (config: GlobalWuxianPiConfigV1) => GlobalWuxianPiConfigV1,
): Promise<GlobalWuxianPiConfigV1> {
  const previous = globalThis.__wuxianpiConfigWriteLock ?? Promise.resolve();
  let resolveLock!: () => void;
  globalThis.__wuxianpiConfigWriteLock = new Promise<void>((resolve) => { resolveLock = resolve; });
  await previous;
  try { return await writeWuxianPiConfig(updater(await readWuxianPiConfig())); }
  finally { resolveLock(); }
}

declare global { var __wuxianpiConfigWriteLock: Promise<void> | undefined; }
