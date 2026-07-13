import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function assertSafeId(value: string, label = "id"): string {
  if (!SAFE_ID.test(value)) {
    throw new Error(`${label} must match ${SAFE_ID.source}`);
  }
  return value;
}

export function getWuxianPiPaths() {
  const agentDir = getAgentDir();
  const root = path.join(agentDir, "wuxianpi");
  return {
    agentDir,
    root,
    assistants: path.join(agentDir, "assistants"),
    config: path.join(root, "config.json"),
    secrets: path.join(root, "secrets.json"),
    webExtensions: path.join(root, "extensions"),
    extensionStorage: path.join(root, "extension-storage"),
    runtime: path.join(root, "runtime"),
  };
}

export function assistantPath(id: string): string {
  return path.join(getWuxianPiPaths().assistants, assertSafeId(id, "assistant id"));
}

export function webExtensionPath(id: string): string {
  return path.join(getWuxianPiPaths().webExtensions, assertSafeId(id, "extension id"));
}

export function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function assistantIdFromCwd(cwd: string): string | undefined {
  const root = getWuxianPiPaths().assistants;
  const relative = path.relative(path.resolve(root), path.resolve(cwd));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || relative.includes(path.sep)) return undefined;
  return SAFE_ID.test(relative) ? relative : undefined;
}
