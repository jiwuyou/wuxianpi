import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { RequestError } from "./protocol.js";
import type {
  ExperienceUpdateState, MainstreamExperienceSource,
} from "./package-types.js";
import { writeAtomicJson } from "./package-storage.js";

const execFileAsync = promisify(execFile);
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1" };

export interface PackageExperienceManagerOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class PackageExperienceManager {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: PackageExperienceManagerOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async readState(input: {
    root: string;
    packageId: string;
    contributionId: string;
    experienceSpaceId: string;
  }): Promise<ExperienceUpdateState> {
    const paths = experiencePaths(input.root);
    try {
      const state = JSON.parse(await readFile(paths.state, "utf8")) as ExperienceUpdateState;
      if (state.schemaVersion !== 1 || state.packageId !== input.packageId || state.contributionId !== input.contributionId ||
          state.experienceSpaceId !== input.experienceSpaceId) {
        throw new RequestError("invalid_experience_state", `Experience state identity is invalid for ${input.contributionId}`);
      }
      return state;
    } catch (error) {
      if (!isMissing(error)) throw error;
      return emptyState(input, paths);
    }
  }

  async update(input: {
    root: string;
    packageId: string;
    contributionId: string;
    experienceSpaceId: string;
    source: MainstreamExperienceSource;
  }): Promise<ExperienceUpdateState & { changed: boolean }> {
    const paths = experiencePaths(input.root);
    await mkdir(paths.revisions, { recursive: true, mode: 0o700 });
    await mkdir(paths.conflicts, { recursive: true, mode: 0o700 });
    const current = await this.readState(input);
    const fetched = await this.fetchSource(input.source, paths.git);
    if (fetched.revision === current.currentRevision && current.status === "ready") return { ...current, changed: false };

    const previous = await readOptional(paths.mainstream);
    const localCorrection = await readOptional(paths.localCorrection);
    await writeAtomicText(join(paths.revisions, `${safeRevision(fetched.revision)}.md`), fetched.content);

    const merged = current.currentRevision
      ? await mergeExperience(previous, localCorrection, fetched.content)
      : { content: combineMainstreamAndCorrection(fetched.content, localCorrection), conflict: false };
    const now = new Date().toISOString();
    if (merged.conflict) {
      const conflictPath = join(paths.conflicts, `${safeRevision(fetched.revision)}.md`);
      await writeAtomicText(conflictPath, merged.content);
      const state: ExperienceUpdateState = {
        ...current,
        candidateRevision: fetched.revision,
        status: "conflict",
        conflictPath,
        updatedAt: now,
      };
      await writeAtomicJson(paths.state, state);
      return { ...state, changed: false };
    }

    await writeAtomicText(paths.mainstream, fetched.content);
    await writeAtomicText(paths.effective, merged.content);
    const state: ExperienceUpdateState = {
      schemaVersion: 1,
      packageId: input.packageId,
      contributionId: input.contributionId,
      experienceSpaceId: input.experienceSpaceId,
      previousRevision: current.currentRevision,
      currentRevision: fetched.revision,
      candidateRevision: null,
      status: "ready",
      mainstreamPath: paths.mainstream,
      localCorrectionPath: paths.localCorrection,
      effectivePath: paths.effective,
      conflictPath: null,
      updatedAt: now,
    };
    await writeAtomicJson(paths.state, state);
    return { ...state, changed: true };
  }

  private async fetchSource(source: MainstreamExperienceSource, gitRoot: string): Promise<{ revision: string; content: string }> {
    assertHttpsUrl(source.url);
    if (source.type === "https-json") return this.fetchJson(source.url);
    await mkdir(gitRoot, { recursive: true, mode: 0o700 });
    if (!(await gitResult(gitRoot, ["rev-parse", "--git-dir"], this.timeoutMs)).ok) {
      await git(gitRoot, ["init"], this.timeoutMs);
    }
    await git(gitRoot, ["fetch", "--force", "--depth=1", "--no-tags", source.url, source.ref], this.timeoutMs);
    const revision = (await git(gitRoot, ["rev-parse", "FETCH_HEAD"], this.timeoutMs)).trim();
    if (!/^[a-f0-9]{40}$/.test(revision)) throw new RequestError("invalid_experience_revision", "Mainstream Git source did not resolve to an immutable commit");
    const content = await git(gitRoot, ["show", `${revision}:${source.path}`], this.timeoutMs);
    return { revision, content: normalizeExperienceContent(content) };
  }

  private async fetchJson(url: string): Promise<{ revision: string; content: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref();
    let response: Response;
    try {
      response = await this.fetchImpl(url, { headers: { accept: "application/json" }, signal: controller.signal });
    } catch (error) {
      throw new RequestError("experience_source_unavailable", `Unable to fetch mainstream experience: ${errorMessage(error)}`);
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) throw new RequestError("experience_source_failed", `Mainstream experience returned HTTP ${response.status}`, { httpStatus: response.status });
    let payload: unknown;
    try { payload = await response.json(); }
    catch { throw new RequestError("invalid_experience_source", "Mainstream experience response is not valid JSON"); }
    const content = experienceJsonContent(payload);
    const explicitRevision = isRecord(payload) && typeof payload.revision === "string" ? payload.revision.trim() : "";
    const revision = explicitRevision || response.headers.get("etag")?.replace(/^W\//, "").replace(/^"|"$/g, "") ||
      createHash("sha256").update(content).digest("hex");
    if (!revision || revision.length > 240) throw new RequestError("invalid_experience_revision", "Mainstream experience revision is invalid");
    return { revision, content };
  }
}

async function mergeExperience(previous: string, localCorrection: string, next: string): Promise<{ content: string; conflict: boolean }> {
  if (!localCorrection.trim()) return { content: next, conflict: false };
  const directory = await mkdtemp(join(tmpdir(), "wuxianpi-experience-merge-"));
  const ours = join(directory, "local.md");
  const base = join(directory, "previous.md");
  const theirs = join(directory, "mainstream.md");
  try {
    await Promise.all([
      writeFile(ours, combineMainstreamAndCorrection(previous, localCorrection), "utf8"),
      writeFile(base, previous, "utf8"),
      writeFile(theirs, next, "utf8"),
    ]);
    const result = await gitResult(directory, ["merge-file", "-p", "--diff3", ours, base, theirs], 30_000);
    if (result.ok) return { content: result.stdout, conflict: false };
    if (result.code === 1) return { content: result.stdout, conflict: true };
    throw new RequestError("experience_merge_failed", result.stderr || "Unable to merge mainstream experience");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function combineMainstreamAndCorrection(mainstream: string, localCorrection: string): string {
  if (!localCorrection.trim()) return mainstream;
  return `${mainstream.trimEnd()}\n\n${localCorrection.trim()}\n`;
}

function experiencePaths(root: string) {
  return {
    state: join(root, "state.json"),
    mainstream: join(root, "mainstream.md"),
    localCorrection: join(root, "local-correction.md"),
    effective: join(root, "effective.md"),
    revisions: join(root, "revisions"),
    conflicts: join(root, "conflicts"),
    git: join(root, "git-source"),
  };
}

function emptyState(input: {
  packageId: string;
  contributionId: string;
  experienceSpaceId: string;
}, paths: ReturnType<typeof experiencePaths>): ExperienceUpdateState {
  return {
    schemaVersion: 1,
    packageId: input.packageId,
    contributionId: input.contributionId,
    experienceSpaceId: input.experienceSpaceId,
    previousRevision: null,
    currentRevision: null,
    candidateRevision: null,
    status: "empty",
    mainstreamPath: paths.mainstream,
    localCorrectionPath: paths.localCorrection,
    effectivePath: paths.effective,
    conflictPath: null,
    updatedAt: new Date(0).toISOString(),
  };
}

function experienceJsonContent(payload: unknown): string {
  if (typeof payload === "string") return normalizeExperienceContent(payload);
  if (!isRecord(payload)) throw new RequestError("invalid_experience_source", "Mainstream experience JSON must be an object or string");
  for (const key of ["content", "markdown", "experience"]) {
    if (typeof payload[key] === "string") return normalizeExperienceContent(payload[key]);
  }
  const { revision: _revision, ...content } = payload;
  return `${JSON.stringify(content, null, 2)}\n`;
}

function normalizeExperienceContent(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) throw new RequestError("invalid_experience_source", "Mainstream experience content is empty");
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (isRecord(parsed)) return experienceJsonContent(parsed);
  } catch { /* plain text or Markdown */ }
  return `${trimmed}\n`;
}

async function git(cwd: string, args: string[], timeout: number): Promise<string> {
  const result = await gitResult(cwd, args, timeout);
  if (!result.ok) throw new RequestError("experience_git_failed", result.stderr || `git ${args[0]} failed`);
  return result.stdout;
}

async function gitResult(cwd: string, args: string[], timeout: number): Promise<{ ok: boolean; code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, { cwd, env: GIT_ENV, timeout, maxBuffer: 8 * 1024 * 1024 });
    return { ok: true, code: 0, stdout, stderr };
  } catch (error) {
    const value = error as { code?: number | string; stdout?: string; stderr?: string; message?: string };
    return { ok: false, code: typeof value.code === "number" ? value.code : 2, stdout: value.stdout ?? "", stderr: value.stderr ?? value.message ?? "" };
  }
}

async function writeAtomicText(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { mode: 0o600 });
  await rename(temporary, path);
}

async function readOptional(path: string): Promise<string> {
  try { return await readFile(path, "utf8"); }
  catch (error) { if (isMissing(error)) return ""; throw error; }
}

function safeRevision(revision: string): string {
  return createHash("sha256").update(revision).digest("hex");
}

function assertHttpsUrl(value: string): void {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new RequestError("invalid_experience_source", "Mainstream experience URL is invalid"); }
  if (url.protocol !== "https:") throw new RequestError("invalid_experience_source", "Mainstream experience URL must use HTTPS");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT";
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
