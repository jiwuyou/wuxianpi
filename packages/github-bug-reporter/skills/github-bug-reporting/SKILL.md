---
name: github-bug-reporting
description: 诊断可能的软件缺陷，整理最小复现并提交问题；优先使用 GitHub，GitHub 不可用时可降级到 WuxianPi Hub。
---

# 软件问题报告

当试错过程暴露出可能由软件实现导致的问题时，使用本 Skill。不要把命令写错、依赖
缺失、网络失败、权限不足、不受支持的环境或用户配置错误直接判断为软件 Bug。

## 提交前

1. 排除无关变量后，尽量重新复现问题。
2. 记录组件、版本、Commit、平台以及触发问题的命令或操作。
3. 明确区分预期行为和实际行为。
4. 从报告中移除凭据、Cookie、Authorization Header、私人内容和无关日志。
5. 优先使用调用方指定仓库，其次按组件、Package 发布仓库和 Git origin 确定归属。
6. 无法确定归属时询问用户，不得猜测仓库。

## 工作流程

先调用 `prepare_software_issue`。该工具只生成持久草稿，并搜索 GitHub 和 WuxianPi Hub
中可能重复的问题，不会提交。

向用户说明判断依据、目标仓库、标题和主要正文，并询问是否同意：

> 是否同意提交这个问题？将优先提交到 GitHub；如果 GitHub 不可用，则提交到
> WuxianPi Hub。

用户同意后，模型可以直接调用 `submit_software_issue`：

```json
{
  "draftId": "draft_...",
  "userConfirmed": true,
  "fallbackToHub": true
}
```

工具信任模型对用户授权的声明，不要求交互式确认卡片或额外确认令牌。不得在用户没有
同意时把 `userConfirmed` 设置为 `true`，也不得使用 Shell 绕过该流程。

## 渠道规则

- 本地 `gh` 可用并已登录时，以用户自己的 GitHub 身份提交。
- GitHub 提交成功后，不创建 Hub Issue。
- GitHub 不可用且 `fallbackToHub=true` 时，创建 Hub Issue。
- `fallbackToHub=false` 时只保留草稿并返回 GitHub 错误。
- Hub Issue 后续可以由维护者手动迁移到 GitHub。

## Issue 内容

正文优先包含：问题描述、复现步骤、预期行为、实际行为、运行环境、已脱敏日志和已经
尝试的方法。存在高度相似的问题时，应优先建议用户补充已有 Issue。

提交成功后使用 `get_software_issue` 跟踪状态；需要补充信息时，在用户同意后使用
`comment_software_issue`。
