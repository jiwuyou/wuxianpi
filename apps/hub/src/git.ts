import { mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { GitSource, SourceHealth } from "./types.js";
import { asErrorMessage } from "./errors.js";

export interface CheckoutResult {
  directory: string;
  sourceHealth: SourceHealth[];
  cleanup(): Promise<void>;
}

export interface GitGateway {
  resolveRef(repositoryUrl: string, ref: string): Promise<string>;
  checkoutExact(sources: GitSource[], commit: string): Promise<CheckoutResult>;
}

interface GitCommandResult {
  stdout: string;
  stderr: string;
}

async function runGit(args: string[], cwd?: string, timeoutMs = 60_000): Promise<GitCommandResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_NOSYSTEM: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`git ${args[0] ?? "command"} timed out`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      const result = {
        stdout: Buffer.concat(stdout).toString("utf8").trim(),
        stderr: Buffer.concat(stderr).toString("utf8").trim(),
      };
      if (code === 0) resolve(result);
      else reject(new Error(result.stderr || `git exited with ${code}`));
    });
  });
}

async function fetchCommit(url: string, commitOrRef: string, checkoutDirectory?: string): Promise<string> {
  const root = checkoutDirectory ?? await mkdtemp(join(tmpdir(), "wuxianpi-hub-git-"));
  const ownsRoot = checkoutDirectory === undefined;
  try {
    await runGit(["init", "--quiet"], root);
    await runGit(["fetch", "--quiet", "--depth=1", "--no-tags", url, commitOrRef], root, 120_000);
    const result = await runGit(["rev-parse", "FETCH_HEAD^{commit}"], root);
    if (!/^[a-f0-9]{40}$/.test(result.stdout)) throw new Error("Remote did not resolve to a full Git commit");
    return result.stdout;
  } finally {
    if (ownsRoot) await rm(root, { recursive: true, force: true });
  }
}

export class RealGitGateway implements GitGateway {
  async resolveRef(repositoryUrl: string, ref: string): Promise<string> {
    return await fetchCommit(repositoryUrl, ref);
  }

  async checkoutExact(sources: GitSource[], commit: string): Promise<CheckoutResult> {
    const root = await mkdtemp(join(tmpdir(), "wuxianpi-hub-checkout-"));
    const checkout = join(root, "source");
    const sourceHealth: SourceHealth[] = [];
    let checkoutReady = false;

    try {
      for (const source of sources) {
        const checkedAt = new Date().toISOString();
        const probe = await mkdtemp(join(root, "probe-"));
        let retainedProbe = false;
        try {
          const resolved = await fetchCommit(source.url, commit, probe);
          if (resolved !== commit) {
            throw new Error(`Expected ${commit}, received ${resolved}`);
          }
          sourceHealth.push({
            url: source.url,
            kind: source.kind,
            status: "healthy",
            checkedAt,
            commit,
            error: null,
          });
          if (!checkoutReady) {
            await rename(probe, checkout);
            retainedProbe = true;
            await runGit(["checkout", "--quiet", "--detach", commit], checkout);
            checkoutReady = true;
          }
        } catch (error) {
          sourceHealth.push({
            url: source.url,
            kind: source.kind,
            status: "failed",
            checkedAt,
            commit: null,
            error: asErrorMessage(error),
          });
        } finally {
          if (!retainedProbe) await rm(probe, { recursive: true, force: true });
        }
      }

      const failedMirrors = sourceHealth.filter((item) => item.kind === "mirror" && item.status === "failed");
      if (!checkoutReady) throw new Error("The exact commit could not be fetched from any source");
      if (failedMirrors.length > 0) {
        throw new Error(`Declared mirror does not contain the approved commit: ${failedMirrors.map((item) => item.url).join(", ")}`);
      }

      const actual = (await runGit(["rev-parse", "HEAD"], checkout)).stdout;
      if (actual !== commit) throw new Error(`Checkout mismatch: expected ${commit}, received ${actual}`);

      return {
        directory: checkout,
        sourceHealth,
        cleanup: async () => await rm(root, { recursive: true, force: true }),
      };
    } catch (error) {
      await rm(root, { recursive: true, force: true });
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), { sourceHealth });
    }
  }
}
