import { spawn } from "node:child_process";

const CORE_TARGETS = new Map([
  ["wuxianpi", "jiwuyou/wuxianpi"],
  ["runtime", "jiwuyou/wuxianpi"],
  ["web", "jiwuyou/wuxianpi"],
  ["hub", "jiwuyou/wuxianpi"],
  ["market", "jiwuyou/wuxianpi"],
  ["package-manager", "jiwuyou/wuxianpi"],
  ["github-bug-reporter", "jiwuyou/wuxianpi-github-bug-reporter"],
  ["service-manager", "jiwuyou/service-manager"],
  ["android", "jiwuyou/openhouseai-app"],
  ["apk", "jiwuyou/openhouseai-app"],
  ["webview", "jiwuyou/openhouseai-app"],
  ["termux-integration", "jiwuyou/openhouseai-app"],
  ["rescue", "jiwuyou/wuxianpi-rescue"],
  ["bootstrap", "jiwuyou/openhouseai-bootstrap"],
  ["update-hub", "jiwuyou/openhouseai-update-hub"],
]);

export async function resolveSupportTarget(input, options = {}) {
  if (input.repository) return { repository: normalizeRepository(input.repository), source: "explicit" };
  if (input.packageId) {
    const repository = await repositoryForPackage(input.packageId, options).catch(() => null);
    if (repository) return { repository, source: "hub_package" };
  }
  const component = String(input.component || "").trim().toLowerCase();
  if (component && CORE_TARGETS.has(component)) return { repository: CORE_TARGETS.get(component), source: "core_component" };
  if (input.cwd) {
    const origin = await (options.runGit || runGit)(["config", "--get", "remote.origin.url"], { cwd: input.cwd, signal: options.signal }).catch(() => null);
    if (origin?.stdout) return { repository: normalizeRepository(origin.stdout.trim()), source: "git_origin" };
  }
  return { repository: null, source: "unresolved" };
}

async function repositoryForPackage(packageId, options) {
  const baseUrl = String(options.hubUrl || process.env.WUXIANPI_HUB_URL || "https://wuxianpihub.webefficacy.com").replace(/\/+$/, "");
  const fetchFn = options.fetch || globalThis.fetch;
  const response = await fetchFn(`${baseUrl}/api/v1/packages/${encodeURIComponent(packageId)}`, { signal: options.signal });
  if (!response.ok) throw new Error(`Hub Package 查询失败：HTTP ${response.status}`);
  const body = await response.json();
  const source = body?.package?.links?.find((link) => link?.kind === "source")?.url;
  return source ? normalizeRepository(source) : null;
}

export function normalizeRepository(value) {
  let repository = String(value || "").trim();
  repository = repository
    .replace(/^git@github\.com:/i, "")
    .replace(/^ssh:\/\/git@github\.com\//i, "")
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/^\/+|\/+$/g, "");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("无法从输入中解析 GitHub 仓库 owner/name");
  return repository;
}

function runGit(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd: options.cwd || process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const abort = () => { child.kill("SIGTERM"); reject(new Error("Git 仓库解析已取消")); };
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(stderr.trim() || `git 退出码为 ${code}`)));
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });
  });
}
