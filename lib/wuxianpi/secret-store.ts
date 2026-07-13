import { randomBytes } from "node:crypto";
import type { GlobalWuxianPiConfigV1, JsonValue, McpServerConfig, TtsProfile } from "./contracts";
import { getWuxianPiPaths } from "./paths";
import { readJsonFile, writeJsonAtomic } from "./storage";

interface SecretDocument {
  schemaVersion: 1;
  values: Record<string, string>;
}

const EMPTY: SecretDocument = { schemaVersion: 1, values: {} };
const assertSecretRef = (ref: string) => {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(ref)) throw new Error("Invalid secret reference");
};

export async function listSecretRefs(): Promise<string[]> {
  const document = await readJsonFile<SecretDocument>(getWuxianPiPaths().secrets, EMPTY);
  return Object.keys(document.values).sort();
}

export async function getSecret(ref: string): Promise<string | undefined> {
  assertSecretRef(ref);
  const document = await readJsonFile<SecretDocument>(getWuxianPiPaths().secrets, EMPTY);
  return document.values[ref];
}

export async function setSecret(ref: string, value: string): Promise<void> {
  assertSecretRef(ref);
  if (!value) throw new Error("Secret value cannot be empty");
  const file = getWuxianPiPaths().secrets;
  const document = await readJsonFile<SecretDocument>(file, EMPTY);
  document.values[ref] = value;
  await writeJsonAtomic(file, document, 0o600);
}

export async function deleteSecret(ref: string): Promise<boolean> {
  assertSecretRef(ref);
  const file = getWuxianPiPaths().secrets;
  const document = await readJsonFile<SecretDocument>(file, EMPTY);
  if (!(ref in document.values)) return false;
  delete document.values[ref];
  await writeJsonAtomic(file, document, 0o600);
  return true;
}

export async function resolveSecretMap(
  plain: Record<string, string> | undefined,
  refs: Record<string, string> | undefined,
): Promise<Record<string, string>> {
  const result = { ...(plain ?? {}) };
  for (const [key, ref] of Object.entries(refs ?? {})) {
    const value = await getSecret(ref);
    if (value === undefined) throw new Error(`Missing secret reference: ${ref}`);
    result[key] = value;
  }
  return result;
}

export function redactSecrets<T extends JsonValue | Record<string, unknown>>(value: T): T {
  const sensitive = /authorization|api[-_]?key|token|secret|password/i;
  const visit = (item: unknown, key = ""): unknown => {
    if (sensitive.test(key) && typeof item === "string") return "***";
    if (Array.isArray(item)) return item.map((entry) => visit(entry));
    if (item && typeof item === "object") {
      return Object.fromEntries(Object.entries(item).map(([childKey, child]) => [childKey, visit(child, childKey)]));
    }
    return item;
  };
  return visit(value) as T;
}

export function createBridgeNonce(): string {
  return randomBytes(24).toString("base64url");
}

const maskValues = (values: Record<string, string> | undefined): Record<string, string> | undefined => values
  ? Object.fromEntries(Object.keys(values).map((key) => [key, "***"]))
  : undefined;

/** Public API projection: never returns inline env/header values. Secret refs remain visible. */
export function maskWuxianPiConfig(config: GlobalWuxianPiConfigV1): GlobalWuxianPiConfigV1 {
  return {
    ...config,
    mcpServers: config.mcpServers.map((server) => ({ ...server, env: maskValues(server.env), headers: maskValues(server.headers) })),
    ttsProfiles: config.ttsProfiles.map((profile) => ({ ...profile, headers: maskValues(profile.headers) })),
  };
}

function restoreMaskedRecord(next: Record<string, string> | undefined, previous: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!next) return next;
  return Object.fromEntries(Object.entries(next).map(([key, value]) => {
    if (value !== "***") return [key, value];
    if (previous?.[key] === undefined) throw new Error(`Masked value for ${key} has no existing secret to preserve`);
    return [key, previous[key]];
  }));
}

export function restoreMaskedMcpServers(next: McpServerConfig[], previous: McpServerConfig[]): McpServerConfig[] {
  return next.map((server) => {
    const old = previous.find((item) => item.id === server.id);
    return { ...server, env: restoreMaskedRecord(server.env, old?.env), headers: restoreMaskedRecord(server.headers, old?.headers) };
  });
}

export function restoreMaskedTtsProfiles(next: TtsProfile[], previous: TtsProfile[]): TtsProfile[] {
  return next.map((profile) => {
    const old = previous.find((item) => item.id === profile.id);
    return { ...profile, headers: restoreMaskedRecord(profile.headers, old?.headers) };
  });
}
