#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1" };

export async function prepareDistributionPackages({ lockPath, outputPath, fetchImpl = fetch }) {
  const lock = JSON.parse(await readFile(resolve(lockPath), "utf8"));
  validateLock(lock);
  const output = resolve(outputPath);
  await mkdir(dirname(output), { recursive: true });
  const staging = await mkdtemp(`${output}.staging-`);
  try {
    const index = { schemaVersion: 1, distributionId: lock.distributionId, packages: [] };
    for (const entry of lock.packages) {
      const plan = entry.gitSources
        ? {
          schemaVersion: 1,
          packageId: entry.packageId,
          releaseId: entry.releaseId,
          version: entry.version,
          approvedCommit: entry.approvedCommit,
          manifestPath: "wuxianpi-package.json",
          manifestDigest: entry.manifestDigest,
          gitSources: entry.gitSources,
          artifacts: entry.artifacts ?? [],
          compatibility: entry.compatibility ?? { hostCapabilities: [], packages: [] },
          verification: { status: "passed", checks: ["distribution-lock"] },
          revoked: false,
        }
        : await fetchInstallPlan(lock.hubUrl, entry, fetchImpl);
      validatePlanAgainstLock(plan, entry);
      if (plan.compatibility.packages.length > 0) {
        throw new Error(`${entry.packageId}: distribution Package cannot include Package dependencies`);
      }
      const packageRoot = join(staging, entry.packageId);
      const sourceRoot = join(packageRoot, "source");
      await mkdir(sourceRoot, { recursive: true });
      await fetchExactCommit(sourceRoot, plan.gitSources, plan.approvedCommit);
      const manifestPath = safeRelativePath(sourceRoot, plan.manifestPath);
      const manifestBytes = await readFile(manifestPath);
      const manifestDigest = createHash("sha256").update(manifestBytes).digest("hex");
      if (manifestDigest !== plan.manifestDigest) throw new Error(`${entry.packageId}: manifest digest mismatch`);
      const manifest = JSON.parse(manifestBytes.toString("utf8"));
      if (manifest.id !== entry.packageId || manifest.version !== plan.version) throw new Error(`${entry.packageId}: manifest identity mismatch`);
      if (manifest.build?.mode === "local" || manifest.requires?.packages?.length !== 0) {
        throw new Error(`${entry.packageId}: distribution Package cannot use local builds or Package dependencies`);
      }
      await prepareArtifacts(packageRoot, plan.artifacts, fetchImpl, entry.packageId);
      const contributions = new Map((manifest.contributions ?? []).map((item) => [item.id, item]));
      for (const binding of entry.initialBindings) {
        for (const contributionId of binding.contributionIds) {
          const contribution = contributions.get(contributionId);
          if (!contribution) throw new Error(`${entry.packageId}: missing initial binding ${contributionId}`);
          const functionalAssistant = contribution.type === "wuxianpi.assistantTemplate" && contribution.kind === "functional";
          if (contribution.assistantSelectable !== true && !functionalAssistant) throw new Error(`${entry.packageId}: initial binding is not assistant-selectable: ${contributionId}`);
        }
      }
      await writeFile(join(packageRoot, "install-plan.json"), `${JSON.stringify(plan, null, 2)}\n`);
      index.packages.push({ packageId: entry.packageId, initialBindings: entry.initialBindings });
    }
    await writeFile(join(staging, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
    await rm(output, { recursive: true, force: true });
    await rename(staging, output);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  return output;
}

async function prepareArtifacts(packageRoot, artifacts, fetchImpl, packageId) {
  const artifactRoot = join(packageRoot, "artifacts");
  await mkdir(artifactRoot, { recursive: true });
  for (const artifact of artifacts) {
    if (!artifact?.fileName || basename(artifact.fileName) !== artifact.fileName ||
        !/^[a-f0-9]{64}$/.test(artifact.sha256 ?? "") || !Number.isInteger(artifact.sizeBytes) || artifact.sizeBytes < 1) {
      throw new Error(`${packageId}: invalid distribution Artifact ${artifact?.id ?? "(missing)"}`);
    }
    const failures = [];
    let bytes;
    for (const source of sortSources(artifact.sources ?? [])) {
      try {
        const response = await fetchImpl(source.url, { headers: { accept: "application/octet-stream" } });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const candidate = Buffer.from(await response.arrayBuffer());
        if (candidate.length !== artifact.sizeBytes) throw new Error(`size ${candidate.length} != ${artifact.sizeBytes}`);
        if (createHash("sha256").update(candidate).digest("hex") !== artifact.sha256) throw new Error("SHA-256 mismatch");
        bytes = candidate;
        break;
      } catch (error) {
        failures.push(`${source.url}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (!bytes) throw new Error(`${packageId}: unable to prepare Artifact ${artifact.id}: ${failures.join("; ")}`);
    await writeFile(join(artifactRoot, artifact.fileName), bytes, { mode: 0o600 });
  }
}

async function fetchInstallPlan(hubUrl, entry, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const url = new URL(`/api/v1/packages/${encodeURIComponent(entry.packageId)}/install-plan`, hubUrl);
    url.searchParams.set("releaseId", entry.releaseId);
    const response = await fetchImpl(url, { headers: { accept: "application/json" }, signal: controller.signal });
    const body = await response.text();
    if (!response.ok) throw new Error(`${entry.packageId}: Hub returned ${response.status}: ${body}`);
    return JSON.parse(body);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchExactCommit(sourceRoot, sources, commit) {
  await git(sourceRoot, ["init", "--quiet"]);
  const ref = `refs/wuxianpi/preinstalled/${commit}`;
  const failures = [];
  for (const source of sortSources(sources)) {
    try {
      await git(sourceRoot, ["fetch", "--force", "--no-tags", source.url, `+${commit}:${ref}`], 5 * 60_000);
      if (await git(sourceRoot, ["rev-parse", ref]) !== commit) throw new Error("resolved commit mismatch");
      await git(sourceRoot, ["checkout", "--quiet", "-B", "wuxianpi-local", ref]);
      if (await git(sourceRoot, ["rev-parse", "HEAD"]) !== commit) throw new Error("checked out commit mismatch");
      if ((await git(sourceRoot, ["status", "--porcelain"])).trim()) throw new Error("worktree is dirty");
      return;
    } catch (error) {
      failures.push(`${source.url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`Unable to fetch ${commit}: ${failures.join("; ")}`);
}

function validateLock(lock) {
  if (lock?.schemaVersion !== 1 || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(lock.distributionId ?? "") || !Array.isArray(lock.packages)) {
    throw new Error("Invalid distribution Package lock");
  }
  if (!String(lock.hubUrl ?? "").startsWith("https://")) throw new Error("Distribution Hub URL must use HTTPS");
  const ids = new Set();
  for (const entry of lock.packages) {
    if (!/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/.test(entry.packageId ?? "") || ids.has(entry.packageId)) throw new Error(`Invalid or duplicate Package id: ${entry.packageId}`);
    ids.add(entry.packageId);
    if (!/^[a-f0-9]{40}$/.test(entry.approvedCommit ?? "") || !/^[a-f0-9]{64}$/.test(entry.manifestDigest ?? "") || !entry.releaseId) {
      throw new Error(`${entry.packageId}: invalid locked Release identity`);
    }
    if (!Array.isArray(entry.initialBindings)) throw new Error(`${entry.packageId}: initialBindings must be an array`);
  }
}

function validatePlanAgainstLock(plan, entry) {
  if (plan?.schemaVersion !== 1 || plan.packageId !== entry.packageId || plan.releaseId !== entry.releaseId ||
      plan.approvedCommit !== entry.approvedCommit || plan.manifestDigest !== entry.manifestDigest) {
    throw new Error(`${entry.packageId}: Hub Install Plan does not match the distribution lock`);
  }
  if (plan.revoked || plan.verification?.status !== "passed") throw new Error(`${entry.packageId}: Release is revoked or unverified`);
  if (!Array.isArray(plan.gitSources) || plan.gitSources.length === 0) throw new Error(`${entry.packageId}: Install Plan has no Git sources`);
}

function safeRelativePath(root, value) {
  if (typeof value !== "string" || value.startsWith("/") || value.includes("\\") || value.split("/").includes("..")) throw new Error(`Unsafe Package path: ${value}`);
  return join(root, value);
}

function sortSources(sources) {
  return [...sources].sort((left, right) => {
    const kind = (left.kind === "github" ? 0 : 1) - (right.kind === "github" ? 0 : 1);
    return kind || Number(right.priority ?? 0) - Number(left.priority ?? 0);
  });
}

async function git(cwd, args, timeout = 120_000) {
  const { stdout } = await execFileAsync("git", args, { cwd, env: GIT_ENV, timeout, maxBuffer: 8 * 1024 * 1024 });
  return stdout.trim();
}

function parseCli(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if ((key !== "--lock" && key !== "--output") || !value) throw new Error("Usage: prepare-packages.mjs --lock FILE --output DIR");
    values[key.slice(2)] = value;
  }
  if (!values.lock || !values.output) throw new Error("Usage: prepare-packages.mjs --lock FILE --output DIR");
  return values;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const input = parseCli(process.argv.slice(2));
  prepareDistributionPackages({ lockPath: input.lock, outputPath: input.output })
    .then((output) => console.log(`Prepared distribution Packages: ${output}`))
    .catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
