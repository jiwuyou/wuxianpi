import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { promisify } from "node:util";
import { RequestError } from "./protocol.js";
import type { HubGitSource, InstalledPackageState } from "./package-types.js";

const execFileAsync = promisify(execFile);
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1" };

export interface GitUpdateResult {
  head: string;
  status: "ready" | "merge_conflict";
  conflicts: string[];
  sourceUrl: string;
}

export class PackageGitRepository {
  async initialize(path: string): Promise<void> {
    await mkdir(path, { recursive: true, mode: 0o700 });
    if (!(await this.isRepository(path))) await git(path, ["init"]);
  }

  async fetchExact(path: string, sources: HubGitSource[], commit: string): Promise<{ ref: string; sourceUrl: string }> {
    await this.initialize(path);
    const ref = `refs/wuxianpi/market/${commit}`;
    const failures: Array<{ url: string; message: string }> = [];
    for (const source of sortGitSources(sources)) {
      try {
        await git(path, ["fetch", "--force", "--no-tags", source.url, `+${commit}:${ref}`], 5 * 60_000);
        const resolved = await this.revParse(path, ref);
        if (resolved !== commit) throw new Error(`resolved ${resolved}`);
        return { ref, sourceUrl: source.url };
      } catch (error) {
        failures.push({ url: source.url, message: errorMessage(error) });
      }
    }
    throw new RequestError("git_commit_unavailable", `Unable to fetch exact commit ${commit}`, { failures });
  }

  async checkoutInitial(path: string, ref: string): Promise<string> {
    await git(path, ["checkout", "-B", "wuxianpi-local", ref]);
    return this.revParse(path, "HEAD");
  }

  async prepareUpdate(path: string, state: InstalledPackageState, sources: HubGitSource[], targetCommit: string): Promise<GitUpdateResult> {
    if (await this.hasUnmerged(path)) {
      return { head: await this.revParse(path, "HEAD"), status: "merge_conflict", conflicts: await this.conflicts(path), sourceUrl: "" };
    }
    if ((await this.status(path)).length > 0) {
      throw new RequestError("local_changes_uncommitted", "Commit local Package changes before updating");
    }
    const current = await this.revParse(path, "HEAD");
    if (state.targetCommit === targetCommit && state.sourceStatus === "candidate_ready" && current === state.localHead) {
      return { head: current, status: "ready", conflicts: [], sourceUrl: "cached" };
    }
    const fetched = await this.fetchExact(path, sources, targetCommit);
    if (current === state.baseCommit && current === state.localHead) {
      await git(path, ["checkout", "-B", "wuxianpi-local", fetched.ref]);
      return { head: await this.revParse(path, "HEAD"), status: "ready", conflicts: [], sourceUrl: fetched.sourceUrl };
    }
    const merge = await gitResult(path, ["merge", "--no-ff", "--no-commit", fetched.ref], 5 * 60_000);
    if (merge.code !== 0) {
      const conflicts = await this.conflicts(path);
      if (conflicts.length > 0) return { head: current, status: "merge_conflict", conflicts, sourceUrl: fetched.sourceUrl };
      throw new RequestError("git_merge_failed", merge.stderr || merge.stdout || "Git merge failed");
    }
    if (await this.hasMergeHead(path)) await gitCommit(path, `Merge WuxianPi market ${targetCommit.slice(0, 12)}`);
    return { head: await this.revParse(path, "HEAD"), status: "ready", conflicts: [], sourceUrl: fetched.sourceUrl };
  }

  async commitLocal(path: string, message: string): Promise<{ committed: boolean; head: string; completedMerge: boolean }> {
    const conflicts = await this.conflicts(path);
    if (conflicts.length > 0) throw new RequestError("merge_conflict_unresolved", "Resolve all Package merge conflicts before committing", { conflicts });
    const completedMerge = await this.hasMergeHead(path);
    await git(path, ["add", "-A"]);
    const staged = (await gitResult(path, ["diff", "--cached", "--quiet"])).code !== 0;
    if (!staged && !completedMerge) return { committed: false, head: await this.revParse(path, "HEAD"), completedMerge: false };
    await gitCommit(path, message.trim() || "WuxianPi local Package changes");
    return { committed: true, head: await this.revParse(path, "HEAD"), completedMerge };
  }

  status(path: string): Promise<string[]> {
    return git(path, ["status", "--porcelain"]).then((output) => output.split("\n").filter(Boolean));
  }

  conflicts(path: string): Promise<string[]> {
    return git(path, ["diff", "--name-only", "--diff-filter=U"]).then((output) => output.split("\n").filter(Boolean));
  }

  revParse(path: string, ref: string): Promise<string> {
    return git(path, ["rev-parse", ref]).then((output) => output.trim());
  }

  showFile(path: string, commit: string, filePath: string): Promise<string> {
    return git(path, ["show", `${commit}:${filePath}`]);
  }

  private async hasUnmerged(path: string): Promise<boolean> { return (await this.conflicts(path)).length > 0; }
  private async hasMergeHead(path: string): Promise<boolean> { return (await gitResult(path, ["rev-parse", "-q", "--verify", "MERGE_HEAD"])).code === 0; }
  private async isRepository(path: string): Promise<boolean> { return (await gitResult(path, ["rev-parse", "--git-dir"])).code === 0; }
}

async function git(path: string, args: string[], timeout = 120_000): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd: path, env: GIT_ENV, timeout, maxBuffer: 8 * 1024 * 1024 });
    return stdout;
  } catch (error) {
    throw new RequestError("git_failed", errorMessage(error));
  }
}

async function gitResult(path: string, args: string[], timeout = 120_000): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, { cwd: path, env: GIT_ENV, timeout, maxBuffer: 8 * 1024 * 1024 });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const value = error as { code?: number | string; stdout?: string; stderr?: string; message?: string };
    return { code: typeof value.code === "number" ? value.code : 1, stdout: value.stdout ?? "", stderr: value.stderr ?? value.message ?? "" };
  }
}

async function gitCommit(path: string, message: string): Promise<void> {
  await git(path, ["-c", "user.name=WuxianPi Local", "-c", "user.email=wuxianpi@localhost", "commit", "-m", message]);
}

function sortGitSources(sources: HubGitSource[]): HubGitSource[] {
  return [...sources].sort((left, right) => {
    const kind = (left.kind === "github" ? 0 : 1) - (right.kind === "github" ? 0 : 1);
    return kind || right.priority - left.priority;
  });
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "stderr" in error && typeof (error as { stderr?: unknown }).stderr === "string") return (error as { stderr: string }).stderr;
  return String(error);
}
