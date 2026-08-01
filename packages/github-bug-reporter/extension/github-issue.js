import { spawn } from "node:child_process";

const MAX_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function normalizeIssueInput(input) {
  const repository = normalizeRepository(input?.repository);
  const title = requiredText(input?.title, "title", 256);
  const body = requiredText(input?.body, "body", 24_000);
  const labels = uniqueStrings(input?.labels, 20, 100);
  return { repository, title, body, labels };
}

export function buildConfirmationMessage(issue, duplicates = []) {
  const labelText = issue.labels.length > 0 ? issue.labels.join(", ") : "（无）";
  const duplicateText = duplicates.length > 0
    ? duplicates.map((item) => `#${item.number} [${item.state}] ${item.title}\n${item.url}`).join("\n\n")
    : "GitHub 搜索没有返回明显重复的问题。";
  return [
    `目标仓库：${issue.repository}`,
    `标题：${issue.title}`,
    `Labels：${labelText}`,
    "",
    "可能重复的 Issue：",
    duplicateText,
    "",
    "Issue 正文：",
    issue.body,
    "",
    "是否使用当前 gh 登录账号创建这个 GitHub Issue？",
  ].join("\n");
}

export async function prepareIssueSubmission(input, options = {}) {
  const issue = normalizeIssueInput(input);
  const runGh = options.runGh ?? runGithubCli;
  await runGh(["auth", "status", "--hostname", "github.com"], {
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  });

  let duplicates = [];
  try {
    const result = await runGh([
      "issue", "list",
      "--repo", issue.repository,
      "--state", "all",
      "--search", `${issue.title} in:title`,
      "--limit", "5",
      "--json", "number,title,url,state",
    ], { signal: options.signal, timeoutMs: options.timeoutMs });
    const parsed = JSON.parse(result.stdout || "[]");
    if (Array.isArray(parsed)) duplicates = parsed.filter(isDuplicateIssue).slice(0, 5);
  } catch {
    // 查重失败不阻止用户确认，但认证和最终提交仍然严格失败。
  }

  return { issue, duplicates };
}

export async function submitIssue(issue, options = {}) {
  const normalized = normalizeIssueInput(issue);
  const args = [
    "issue", "create",
    "--repo", normalized.repository,
    "--title", normalized.title,
    "--body-file", "-",
  ];
  for (const label of normalized.labels) args.push("--label", label);
  const result = await (options.runGh ?? runGithubCli)(args, {
    input: normalized.body,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  });
  const url = result.stdout.split(/\r?\n/).map((line) => line.trim()).find((line) => /^https:\/\/github\.com\//.test(line)) ?? null;
  return { repository: normalized.repository, title: normalized.title, labels: normalized.labels, url, output: result.stdout.trim() };
}

export async function viewIssue(reference, options = {}) {
  const parsed = parseGithubIssueReference(reference);
  const result = await (options.runGh ?? runGithubCli)([
    "issue", "view", String(parsed.number), "--repo", parsed.repository,
    "--json", "number,title,body,state,url,labels,comments",
  ], { signal: options.signal, timeoutMs: options.timeoutMs });
  return JSON.parse(result.stdout);
}

export async function commentIssue(reference, body, options = {}) {
  const parsed = parseGithubIssueReference(reference);
  const comment = requiredText(body, "body", 12_000);
  const result = await (options.runGh ?? runGithubCli)([
    "issue", "comment", String(parsed.number), "--repo", parsed.repository, "--body-file", "-",
  ], { input: comment, signal: options.signal, timeoutMs: options.timeoutMs });
  const url = result.stdout.split(/\r?\n/).map((line) => line.trim()).find((line) => /^https:\/\/github\.com\//.test(line)) ?? null;
  return { repository: parsed.repository, number: parsed.number, url, output: result.stdout.trim() };
}

export function parseGithubIssueReference(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  const url = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)(?:[?#].*)?$/.exec(raw);
  if (url) return { repository: `${url[1]}/${url[2]}`, number: Number(url[3]) };
  const short = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)$/.exec(raw);
  if (short) return { repository: short[1], number: Number(short[2]) };
  throw new Error("GitHub Issue 引用必须是 Issue URL 或 owner/name#number");
}

export function runGithubCli(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("gh", args, {
      cwd: options.cwd || process.cwd(),
      env: { ...process.env, GH_NO_UPDATE_NOTIFIER: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let settled = false;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const finish = (error, exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      const safeStdout = redactSensitive(stdout);
      const safeStderr = redactSensitive(stderr);
      if (error) reject(error);
      else if (exitCode !== 0) reject(new Error(safeStderr.trim() || safeStdout.trim() || `gh 退出码为 ${exitCode}`));
      else resolve({ stdout: safeStdout, stderr: safeStderr, exitCode });
    };
    const append = (current, chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        child.kill("SIGTERM");
        finish(new Error("gh 输出超过 1 MiB 限制"));
        return current;
      }
      return current + chunk.toString("utf8");
    };
    const abort = () => {
      child.kill("SIGTERM");
      finish(new Error("GitHub Issue 提交已取消"));
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error(`gh 执行超过 ${timeoutMs}ms 后超时`));
    }, timeoutMs);
    timer.unref?.();

    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
    child.on("error", (error) => finish(new Error(error.code === "ENOENT" ? "尚未安装 GitHub CLI（gh）" : redactSensitive(error.message))));
    child.on("close", (exitCode) => finish(undefined, exitCode));
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });
    if (options.input !== undefined) child.stdin.end(String(options.input));
    else child.stdin.end();
  });
}

export function redactSensitive(value) {
  return String(value ?? "")
    .replace(/\bgh[opsru]_[A-Za-z0-9_]{16,}\b/g, "[REDACTED_TOKEN]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[REDACTED_TOKEN]")
    .replace(/(Authorization\s*:\s*)(?:Bearer|token|Basic)?\s*[^\r\n]+/gi, "$1[REDACTED]")
    .replace(/((?:access_token|auth_token|token|password|secret)\s*[=:]\s*)[^\s&]+/gi, "$1[REDACTED]");
}

export function normalizeRepository(value) {
  let repository = requiredText(value, "repository", 200);
  repository = repository.replace(/^https:\/\/github\.com\//i, "").replace(/\.git$/i, "").replace(/^\/+|\/+$/g, "");
  if (!REPOSITORY_PATTERN.test(repository)) throw new Error("repository 必须是 owner/name 或 github.com 仓库地址");
  return repository;
}

function requiredText(value, field, maxLength) {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result) throw new Error(`${field} 不能为空`);
  if (result.length > maxLength) throw new Error(`${field} 不能超过 ${maxLength} 个字符`);
  return result;
}

function uniqueStrings(value, maxItems, maxLength) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("labels 必须是字符串数组");
  const result = [...new Set(value.map((item) => requiredText(item, "label", maxLength)))];
  if (result.length > maxItems) throw new Error(`labels 不能超过 ${maxItems} 项`);
  return result;
}

function isDuplicateIssue(value) {
  return value && typeof value === "object" && Number.isInteger(value.number) && typeof value.title === "string" && typeof value.url === "string" && typeof value.state === "string";
}
