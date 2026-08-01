# GitHub Bug 报告助手

这个 WuxianPi Package 提供统一的中文 Bug 报告 Skill 和
`submit_github_issue` Pi 工具。

工具使用本地已经授权的 GitHub CLI。它会检查登录状态、搜索可能重复的 Issue，
并通过交互确认向用户展示准确的目标仓库、标题、Labels 和完整正文。只有用户同意后，
工具才会执行 `gh issue create`。

使用条件：

- AI 所在环境已经安装 `git` 和 `gh`；
- 已经针对 `github.com` 完成 `gh auth login`；
- WuxianPi 或 Pi UI 能够响应 Extension 的确认请求。

Package 不包含任何凭据，也不依赖 GitHub MCP。
