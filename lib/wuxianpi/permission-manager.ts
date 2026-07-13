import { randomUUID } from "node:crypto";
import type { CapabilityRisk, PermissionDecision, PermissionGrant, PermissionRequest } from "./contracts";
import { readWuxianPiConfig, updateWuxianPiConfig } from "./config-store";

declare global {
  var __wuxianpiPermissionRequests: Map<string, PermissionRequest> | undefined;
  var __wuxianpiOncePermissions: Map<string, number> | undefined;
}

function requests(): Map<string, PermissionRequest> {
  if (!globalThis.__wuxianpiPermissionRequests) globalThis.__wuxianpiPermissionRequests = new Map();
  return globalThis.__wuxianpiPermissionRequests;
}

function oncePermissions(): Map<string, number> {
  if (!globalThis.__wuxianpiOncePermissions) globalThis.__wuxianpiOncePermissions = new Map();
  return globalThis.__wuxianpiOncePermissions;
}

const keyOf = (assistantId: string, capabilityId: string) => `${assistantId}\u0000${capabilityId}`;

export async function getPermissionDecision(assistantId: string, capabilityId: string): Promise<"assistant" | "once" | "deny" | undefined> {
  const onceExpiry = oncePermissions().get(keyOf(assistantId, capabilityId));
  if (onceExpiry && onceExpiry > Date.now()) return "once";
  if (onceExpiry) oncePermissions().delete(keyOf(assistantId, capabilityId));
  return (await readWuxianPiConfig()).permissions.find((grant) => grant.assistantId === assistantId && grant.capabilityId === capabilityId)?.decision;
}

export async function setPermissionDecision(assistantId: string, capabilityId: string, decision: PermissionDecision): Promise<void> {
  const key = keyOf(assistantId, capabilityId);
  if (decision === "once") {
    oncePermissions().set(key, Date.now() + 15 * 60 * 1000);
    return;
  }
  await updateWuxianPiConfig((config) => {
    const grant: PermissionGrant = { assistantId, capabilityId, decision, updatedAt: new Date().toISOString() };
    return { ...config, permissions: [...config.permissions.filter((item) => keyOf(item.assistantId, item.capabilityId) !== key), grant] };
  });
}

export async function revokePermission(assistantId: string, capabilityId: string): Promise<void> {
  oncePermissions().delete(keyOf(assistantId, capabilityId));
  await updateWuxianPiConfig((config) => ({
    ...config,
    permissions: config.permissions.filter((item) => keyOf(item.assistantId, item.capabilityId) !== keyOf(assistantId, capabilityId)),
  }));
}

export async function listPermissionGrants(assistantId?: string): Promise<PermissionGrant[]> {
  return (await readWuxianPiConfig()).permissions.filter((grant) => !assistantId || grant.assistantId === assistantId);
}

export function createPermissionRequest(input: Omit<PermissionRequest, "id">): PermissionRequest {
  const existing = Array.from(requests().values()).find((request) => request.assistantId === input.assistantId && request.capabilityId === input.capabilityId && (!request.expiresAt || request.expiresAt > Date.now()));
  if (existing) return existing;
  const request = { ...input, id: randomUUID(), expiresAt: input.expiresAt ?? Date.now() + 5 * 60 * 1000 };
  requests().set(request.id, request);
  return request;
}

export function listPermissionRequests(assistantId?: string): PermissionRequest[] {
  const now = Date.now();
  for (const [id, request] of requests()) if (request.expiresAt && request.expiresAt <= now) requests().delete(id);
  return Array.from(requests().values()).filter((request) => !assistantId || request.assistantId === assistantId);
}

export async function resolvePermissionRequest(id: string, decision: PermissionDecision): Promise<PermissionRequest> {
  const request = requests().get(id);
  if (!request) throw new Error("Permission request not found or expired");
  await setPermissionDecision(request.assistantId, request.capabilityId, decision);
  requests().delete(id);
  return request;
}

export function riskNeedsConfirmation(risk: CapabilityRisk[]): boolean {
  return risk.some((item) => item !== "read" && item !== "audio");
}
