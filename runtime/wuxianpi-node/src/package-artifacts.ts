import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { gunzipSync, unzipSync } from "fflate";
import { RequestError } from "./protocol.js";
import type { PackageArtifact } from "./package-types.js";
import { runBoundedCommand } from "./package-build.js";
import { safePackagePath } from "./package-validator.js";

export interface PackageArtifactManagerOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class PackageArtifactManager {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: PackageArtifactManagerOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10 * 60_000;
  }

  async materialize(artifacts: PackageArtifact[], ids: string[], candidateRoot: string, cacheRoot: string, logRoot: string): Promise<void> {
    const byId = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
    for (const id of ids) {
      const artifact = byId.get(id);
      if (!artifact) throw new RequestError("artifact_not_found", `Package artifact is missing: ${id}`);
      const cached = join(cacheRoot, artifact.sha256, basename(artifact.fileName));
      await this.ensureCached(artifact, cached);
      await this.unpack(artifact, cached, candidateRoot, logRoot);
    }
  }

  private async ensureCached(artifact: PackageArtifact, path: string): Promise<void> {
    if (await matchesArtifact(path, artifact)) return;
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const failures: Array<{ url: string; message: string }> = [];
    for (const source of [...artifact.sources].sort((left, right) => {
      const kind = (left.kind === "github-release" ? 0 : 1) - (right.kind === "github-release" ? 0 : 1);
      return kind || right.priority - left.priority;
    })) {
      const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
      try {
        await this.download(source.url, temporary, artifact.sizeBytes);
        await verifyArtifact(temporary, artifact);
        await rename(temporary, path);
        return;
      } catch (error) {
        await rm(temporary, { force: true });
        failures.push({ url: source.url, message: error instanceof Error ? error.message : String(error) });
      }
    }
    throw new RequestError("artifact_download_failed", `Unable to download verified artifact ${artifact.id}`, { failures });
  }

  private async download(url: string, path: string, maxBytes: number): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref();
    let response: Response;
    try { response = await this.fetchImpl(url, { signal: controller.signal }); }
    catch (error) { clearTimeout(timer); throw error; }
    if (!response.ok || !response.body) {
      clearTimeout(timer);
      throw new Error(`HTTP ${response.status}`);
    }
    const announced = Number(response.headers.get("content-length") ?? 0);
    if (announced > maxBytes) {
      clearTimeout(timer);
      throw new Error(`Artifact is larger than declared size (${announced} > ${maxBytes})`);
    }
    let received = 0;
    const limiter = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        received += chunk.byteLength;
        if (received > maxBytes) throw new Error(`Artifact exceeded declared size ${maxBytes}`);
        controller.enqueue(chunk);
      },
    });
    try {
      await pipeline(Readable.fromWeb(response.body.pipeThrough(limiter) as never), createWriteStream(path, { mode: 0o600 }));
    } finally {
      clearTimeout(timer);
    }
  }

  private async unpack(artifact: PackageArtifact, archivePath: string, candidateRoot: string, logRoot: string): Promise<void> {
    if (artifact.archive === "none") {
      const target = safePackagePath(candidateRoot, artifact.fileName);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, await readFile(archivePath), { mode: 0o700 });
      return;
    }
    if (artifact.archive === "zip") {
      const entries = unzipSync(new Uint8Array(await readFile(archivePath)));
      for (const [name, bytes] of Object.entries(entries)) {
        const target = safePackagePath(candidateRoot, name);
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, bytes, { mode: 0o600 });
      }
      return;
    }
    const logPath = join(logRoot, `artifact-${artifact.sha256.slice(0, 12)}.log`);
    const archive = artifact.archive === "tar.gz" ? "-xzf" : "--zstd -xf";
    await runBoundedCommand(candidateRoot, {
      command: `tar ${archive} ${shellQuote(archivePath)} -C ${shellQuote(candidateRoot)}`,
      timeoutSeconds: 600,
    }, logPath);
  }
}

async function matchesArtifact(path: string, artifact: PackageArtifact): Promise<boolean> {
  try { await verifyArtifact(path, artifact); return true; }
  catch { return false; }
}

async function verifyArtifact(path: string, artifact: PackageArtifact): Promise<void> {
  const info = await stat(path);
  if (info.size !== artifact.sizeBytes) throw new RequestError("artifact_size_mismatch", `Artifact ${artifact.id} size mismatch`);
  const digest = createHash("sha256").update(await readFile(path)).digest("hex");
  if (digest !== artifact.sha256) throw new RequestError("artifact_sha_mismatch", `Artifact ${artifact.id} SHA-256 mismatch`);
}

function shellQuote(value: string): string { return `'${value.replace(/'/g, `'"'"'`)}'`; }
