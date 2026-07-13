import path from "node:path";
import { access, mkdir, open, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir, tmpdir } from "node:os";

const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function assertSafeId(value: string, label = "id"): string {
  if (!SAFE_ID.test(value)) {
    throw new Error(`${label} must match ${SAFE_ID.source}`);
  }
  return value;
}

export function getWuxianPiPaths() {
  const configuredAgentDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = configuredAgentDir?.startsWith("~/")
    ? path.join(homedir(), configuredAgentDir.slice(2))
    : configuredAgentDir || path.join(homedir(), ".pi", "agent");
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

export interface RuntimeTempResolverOptions {
  env?: NodeJS.ProcessEnv;
  osTmpDir?: string;
  probeDirectory?: (directory: string) => Promise<boolean>;
}

async function probeWritableDirectory(directory: string): Promise<boolean> {
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await access(directory, constants.W_OK);
    const probe = path.join(directory, `.wuxianpi-write-probe-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const handle = await open(probe, "wx", 0o600);
    await handle.close();
    await rm(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

/** Resolve a verified writable temporary directory across Termux and regular Linux. */
export async function resolveWuxianPiRuntimeTempDir(options: RuntimeTempResolverOptions = {}): Promise<string> {
  const env = options.env ?? process.env;
  const osTemporaryDirectory = options.osTmpDir ?? tmpdir();
  const isTermux = process.platform === "android" || Boolean(env.TERMUX_VERSION) || env.PREFIX?.includes("com.termux") === true;
  const candidates = [
    env.TMPDIR,
    ...(isTermux ? [env.PREFIX ? path.join(env.PREFIX, "tmp") : undefined, env.HOME ? path.join(env.HOME, ".cache", "wuxianpi", "tmp") : undefined] : []),
    osTemporaryDirectory,
    ...(!isTermux && env.HOME ? [path.join(env.HOME, ".cache", "wuxianpi", "tmp")] : []),
  ].filter((candidate): candidate is string => Boolean(candidate));
  const probe = options.probeDirectory ?? probeWritableDirectory;
  for (const candidate of [...new Set(candidates.map((item) => path.resolve(item)))]) {
    if (await probe(candidate)) return candidate;
  }
  throw new Error(`No writable WuxianPi runtime temporary directory found (checked: ${candidates.join(", ")})`);
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
