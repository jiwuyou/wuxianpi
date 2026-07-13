import { constants } from "node:fs";
import { access, mkdir, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

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
