import { Type } from "@earendil-works/pi-ai";
import { commentIssue, prepareIssueSubmission, submitIssue, viewIssue } from "./github-issue.js";
import { HubIssueClient } from "./hub-issue.js";
import { IssueStore } from "./issue-store.js";
import { resolveSupportTarget } from "./support-target.js";

export function createSupportIssueTools(options = {}) {
  const store = options.store || new IssueStore(options.storagePath);
  const hub = options.hub || new HubIssueClient({ baseUrl: options.hubUrl, fetch: options.fetch, timeoutMs: options.timeoutMs });
  const githubOptions = { runGh: options.runGh, timeoutMs: options.timeoutMs };

  return [
    {
      name: "prepare_software_issue",
      label: "准备软件问题报告",
      description: "整理软件问题、解析目标仓库并搜索 GitHub 与 WuxianPi Hub 中可能重复的问题，不会执行提交。",
      promptSnippet: "确认问题较大概率来自软件实现后，先调用 prepare_software_issue 生成草稿和查重结果，再在对话中询问用户是否提交。",
      parameters: issueParameters(false),
      async execute(_toolCallId, params, signal) {
        try {
          const target = await resolveSupportTarget(params, {
            fetch: options.fetch, hubUrl: options.hubUrl, runGit: options.runGit, signal,
          });
          const issue = normalizeDraftInput(params, target.repository);
          let github = { available: false, error: target.repository ? "尚未检查 GitHub" : "未解析出目标 GitHub 仓库", duplicates: [] };
          if (target.repository) {
            try {
              const prepared = await prepareIssueSubmission(issue, { ...githubOptions, signal });
              github = { available: true, error: null, duplicates: prepared.duplicates };
            } catch (error) {
              github = { available: false, error: errorMessage(error), duplicates: [] };
            }
          }
          const reporterToken = await store.reporterToken();
          let hubDuplicates = [];
          let hubError = null;
          try { hubDuplicates = await hub.search(issue, reporterToken, signal); }
          catch (error) { hubError = errorMessage(error); }
          const draft = await store.createDraft({
            status: "prepared",
            ...issue,
            targetSource: target.source,
            github,
            hub: { available: !hubError, error: hubError, duplicates: hubDuplicates },
          });
          return toolResult({ draft }, describeDraft(draft));
        } catch (error) {
          return toolResult({ prepared: false, error: errorMessage(error) }, `问题报告准备失败：${errorMessage(error)}`);
        }
      },
    },
    {
      name: "submit_software_issue",
      label: "提交软件问题",
      description: "提交已经准备好的问题草稿。优先使用本机 gh 创建 GitHub Issue，失败时可降级到 WuxianPi Hub。模型声明用户已同意即可。",
      promptSnippet: "只有在用户已经同意提交后才调用，并设置 userConfirmed=true。用户可以一次同意 GitHub 优先、Hub 降级两条渠道。",
      parameters: Type.Object({
        draftId: Type.String({ minLength: 1, description: "prepare_software_issue 返回的草稿 ID。" }),
        userConfirmed: Type.Boolean({ description: "模型确认用户已经同意提交时设为 true。" }),
        fallbackToHub: Type.Boolean({ description: "GitHub 提交失败时，是否直接降级创建 WuxianPi Hub Issue。" }),
      }),
      async execute(_toolCallId, params, signal) {
        if (params.userConfirmed !== true) return toolResult({ submitted: false, reason: "user_not_confirmed" }, "模型尚未声明用户已经同意，因此没有提交问题。");
        try {
          const draft = await store.draft(params.draftId);
          if (!draft) throw new Error(`找不到 Issue 草稿：${params.draftId}`);
          if (draft.referenceId) {
            const existing = await store.reference(draft.referenceId);
            return toolResult({ submitted: true, reused: true, reference: existing }, `该草稿已经提交：${existing?.url || existing?.referenceId}`);
          }
          let githubError = null;
          if (draft.repository) {
            try {
              const submitted = await submitIssue(draft, { ...githubOptions, signal });
              const reference = await store.recordSubmission(draft.draftId, {
                channel: "github", url: submitted.url, repository: submitted.repository,
                externalId: submitted.url, title: draft.title,
              });
              return toolResult({ submitted: true, reference }, submitted.url ? `已创建 GitHub Issue：${submitted.url}` : `已在 ${submitted.repository} 创建 GitHub Issue。`);
            } catch (error) {
              githubError = errorMessage(error);
            }
          } else {
            githubError = "没有可用的 GitHub 目标仓库";
          }
          if (params.fallbackToHub !== true) {
            return toolResult({ submitted: false, reason: "github_failed", githubError, draftId: draft.draftId }, `GitHub Issue 提交失败：${githubError}\n草稿已保留，未降级到 WuxianPi Hub。`);
          }
          const reporterToken = await store.reporterToken();
          const created = await hub.create(draft, reporterToken, signal);
          const issue = created.issue;
          const reference = await store.recordSubmission(draft.draftId, {
            channel: "wuxianpi_hub", url: issue.url, repository: draft.repository,
            externalId: String(issue.issueNumber || issue.issueId), title: draft.title, githubError,
          });
          return toolResult({ submitted: true, reference, githubError }, `GitHub 不可用，已降级创建 WuxianPi Hub Issue：${issue.url}`);
        } catch (error) {
          return toolResult({ submitted: false, reason: "submission_failed", error: errorMessage(error) }, `问题提交失败：${errorMessage(error)}`);
        }
      },
    },
    {
      name: "get_software_issue",
      label: "查看软件问题",
      description: "读取此前通过问题报告工具提交的 GitHub 或 WuxianPi Hub Issue。",
      parameters: Type.Object({ referenceId: Type.String({ minLength: 1, description: "提交成功后返回的本地引用 ID。" }) }),
      async execute(_toolCallId, params, signal) {
        try {
          const reference = await requireReference(store, params.referenceId);
          const data = reference.channel === "github"
            ? await viewIssue(reference.url || reference.externalId, { ...githubOptions, signal })
            : await hub.get(reference.externalId, await store.reporterToken(), signal);
          return toolResult({ reference, data }, JSON.stringify(data, null, 2));
        } catch (error) {
          return toolResult({ found: false, error: errorMessage(error) }, `读取问题失败：${errorMessage(error)}`);
        }
      },
    },
    {
      name: "comment_software_issue",
      label: "补充软件问题",
      description: "向此前提交的 GitHub 或 WuxianPi Hub Issue 添加评论。模型声明用户已同意即可。",
      parameters: Type.Object({
        referenceId: Type.String({ minLength: 1, description: "提交成功后返回的本地引用 ID。" }),
        body: Type.String({ minLength: 1, maxLength: 12000, description: "需要补充的评论正文。" }),
        userConfirmed: Type.Boolean({ description: "模型确认用户已经同意发布这条评论时设为 true。" }),
      }),
      async execute(_toolCallId, params, signal) {
        if (params.userConfirmed !== true) return toolResult({ commented: false, reason: "user_not_confirmed" }, "模型尚未声明用户已经同意，因此没有发布评论。");
        try {
          const reference = await requireReference(store, params.referenceId);
          const data = reference.channel === "github"
            ? await commentIssue(reference.url || reference.externalId, params.body, { ...githubOptions, signal })
            : await hub.comment(reference.externalId, params.body, await store.reporterToken(), signal);
          return toolResult({ commented: true, reference, data }, `已向 ${reference.channel === "github" ? "GitHub" : "WuxianPi Hub"} Issue 补充评论。`);
        } catch (error) {
          return toolResult({ commented: false, error: errorMessage(error) }, `评论发布失败：${errorMessage(error)}`);
        }
      },
    },
  ];
}

export default function registerSupportIssueTools(pi) {
  for (const tool of createSupportIssueTools()) pi.registerTool(tool);
}

function issueParameters(includeConfirmation) {
  return Type.Object({
    repository: Type.Optional(Type.String({ description: "目标 GitHub 仓库 owner/name 或 URL；不提供时按组件、Package 和 Git origin 解析。" })),
    packageId: Type.Optional(Type.String({ description: "问题所属的 WuxianPi Package ID。" })),
    component: Type.Optional(Type.String({ description: "问题所属组件，例如 wuxianpi、service-manager、android 或 rescue。" })),
    cwd: Type.Optional(Type.String({ description: "用于读取 git remote origin 的工作目录。" })),
    title: Type.String({ minLength: 1, maxLength: 256, description: "简洁、可搜索的问题标题。" }),
    body: Type.String({ minLength: 1, maxLength: 24000, description: "完整 Markdown 正文，包含复现步骤、预期行为、实际行为、环境和已尝试方法。" }),
    labels: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { maxItems: 20 })),
    reporterName: Type.Optional(Type.String({ minLength: 1, maxLength: 120, description: "Hub 降级渠道显示的报告者名称。" })),
    visibility: Type.Optional(Type.Union([Type.Literal("public"), Type.Literal("maintainers")])),
    environment: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    ...(includeConfirmation ? { userConfirmed: Type.Boolean() } : {}),
  });
}

function normalizeDraftInput(params, repository) {
  const title = requiredText(params.title, "title", 256);
  const body = requiredText(params.body, "body", 24_000);
  const labels = params.labels === undefined ? [] : uniqueStrings(params.labels, 20, 100);
  return {
    repository,
    packageId: optionalText(params.packageId, 160),
    component: optionalText(params.component, 160),
    title,
    body,
    labels,
    reporterName: optionalText(params.reporterName, 120) || "WuxianPi 用户",
    visibility: params.visibility === "maintainers" ? "maintainers" : "public",
    environment: params.environment && typeof params.environment === "object" && !Array.isArray(params.environment) ? params.environment : {},
  };
}

function describeDraft(draft) {
  const github = draft.github.available ? `可用，发现 ${draft.github.duplicates.length} 个可能重复问题` : `不可用：${draft.github.error}`;
  const hub = draft.hub.available ? `可用，发现 ${draft.hub.duplicates.length} 个可能重复问题` : `不可用：${draft.hub.error}`;
  return [
    `草稿 ID：${draft.draftId}`,
    `目标仓库：${draft.repository || "未确定"}`,
    `GitHub：${github}`,
    `WuxianPi Hub：${hub}`,
    `标题：${draft.title}`,
    "",
    "请在对话中取得用户同意；同意后调用 submit_software_issue，并设置 userConfirmed=true。",
  ].join("\n");
}

async function requireReference(store, referenceId) {
  const reference = await store.reference(referenceId);
  if (!reference) throw new Error(`找不到问题引用：${referenceId}`);
  return reference;
}

function requiredText(value, field, maxLength) {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result) throw new Error(`${field} 不能为空`);
  if (result.length > maxLength) throw new Error(`${field} 不能超过 ${maxLength} 个字符`);
  return result;
}

function optionalText(value, maxLength) {
  if (value === undefined || value === null || value === "") return null;
  return requiredText(value, "value", maxLength);
}

function uniqueStrings(value, maxItems, maxLength) {
  if (!Array.isArray(value)) throw new Error("labels 必须是字符串数组");
  const result = [...new Set(value.map((item) => requiredText(item, "label", maxLength)))];
  if (result.length > maxItems) throw new Error(`labels 不能超过 ${maxItems} 项`);
  return result;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function toolResult(details, text) {
  return { content: [{ type: "text", text }], details };
}
