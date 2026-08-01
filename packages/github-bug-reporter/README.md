# WuxianPi 软件问题报告助手

这个 Package 为 WuxianPi 助手提供统一的问题准备、提交、查看和评论工具。

提交顺序：

1. 使用设备本地已经登录的 `gh` 创建 GitHub Issue。
2. GitHub 不可用且用户允许降级时，创建 WuxianPi Hub Issue。

模型通过普通对话取得用户同意，并在提交参数中设置 `userConfirmed=true`。工具不要求
额外的 UI 确认令牌。GitHub 成功时不会重复创建 Hub Issue。

Package 不包含 GitHub Token，不依赖 GitHub MCP，也不使用 Hub 机器人账号。
