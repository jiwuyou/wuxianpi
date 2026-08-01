import { Type } from "@earendil-works/pi-ai";
import { buildConfirmationMessage, prepareIssueSubmission, submitIssue } from "./github-issue.js";

export function createGithubIssueTool(options = {}) {
  return {
    name: "submit_github_issue",
    label: "提交 GitHub Issue",
    description: "诊断并复现可能的软件 Bug 后，搜索重复 Issue，向用户展示最终报告，并且只有获得明确同意后才通过 gh 创建 Issue。",
    promptSnippet: "只有在较大概率确认可复现的软件 Bug 时才使用 submit_github_issue。先向用户解释判断依据；工具还会要求用户确认最终提交内容。",
    parameters: Type.Object({
      repository: Type.String({ description: "目标 GitHub 仓库，格式为 owner/name 或 github.com 仓库地址。" }),
      title: Type.String({ minLength: 1, maxLength: 256, description: "简洁、可搜索的 Issue 标题。" }),
      body: Type.String({ minLength: 1, maxLength: 24000, description: "完整的 Markdown Issue 正文，应包含复现步骤、预期行为、实际行为、运行环境、已脱敏日志和已尝试的方法。" }),
      labels: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { maxItems: 20, description: "需要添加的现有仓库 Labels，例如 bug。" })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (!ctx?.hasUI || !ctx.ui?.confirm) return toolResult({ submitted: false, reason: "interactive_confirmation_unavailable" }, "当前环境无法显示用户确认，因此不能提交 Issue。此时应在对话中保留草稿。");
      try {
        const prepared = await prepareIssueSubmission(params, { runGh: options.runGh, signal, timeoutMs: options.timeoutMs });
        const approved = await ctx.ui.confirm("提交 GitHub Issue？", buildConfirmationMessage(prepared.issue, prepared.duplicates), { signal });
        if (!approved) return toolResult({ submitted: false, reason: "user_declined", duplicates: prepared.duplicates }, "用户没有同意提交 GitHub Issue。");
        const submitted = await submitIssue(prepared.issue, { runGh: options.runGh, signal, timeoutMs: options.timeoutMs });
        return toolResult({ submitted: true, duplicates: prepared.duplicates, ...submitted }, submitted.url ? `已创建 GitHub Issue：${submitted.url}` : `已在 ${submitted.repository} 创建 GitHub Issue。`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return toolResult({ submitted: false, reason: "submission_failed", error: message }, `GitHub Issue 提交失败：${message}`);
      }
    },
  };
}

export default function registerGithubIssueTool(pi) {
  pi.registerTool(createGithubIssueTool());
}

function toolResult(details, text) {
  return { content: [{ type: "text", text }], details };
}
