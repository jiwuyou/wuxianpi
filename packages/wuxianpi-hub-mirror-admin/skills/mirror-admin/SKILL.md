---
name: wuxianpi-hub-mirror-admin
description: 当用户需要管理 WuxianPi Hub 的 OpenHouse Git Mirror、同步公开 GitHub 仓库、调整镜像配置或查看镜像任务时，使用本指南。
---

# WuxianPi Hub Git Mirror 管理

本 Skill 用于管理 WuxianPi Hub 的 OpenHouse Git Mirror。默认 Hub：

```text
https://wuxianpihub.webefficacy.com
```

可以通过 `HUB_ORIGIN` 指定其他 Hub。

## 权限模型

GitHub Token 只用于向 Hub 换取短期 Hub Session Token：

```text
GitHub CLI 身份
  -> /api/v1/auth/github/token-exchange
  -> Hub Session Token
  -> /api/v1/admin/mirrors/*
```

不需要 Mirror Token。Mirror Token 属于 Hub 服务端连接镜像服务的凭据，不能向用户索取，也不能写入 Package、命令参数、URL 或日志。

开始前检查：

```bash
gh auth status
command -v jq
command -v curl
```

如果当前 GitHub CLI 账户不是用户要求的账户，不要静默执行 `gh auth switch`；先说明将切换本机 GitHub CLI 身份并取得确认。

只有 Hub `/api/v1/me` 返回 `role: "admin"` 时，才能执行 Admin API。普通 `user`、Package maintainer 或 publisher 权限不足以管理全局 Mirror。

## 创建临时 Hub Session

使用当前已确认的 GitHub CLI 身份换取 Hub Session。不要打印 `HUB_TOKEN`，不要开启会记录命令环境的 shell trace：

```bash
export HUB_ORIGIN="${HUB_ORIGIN:-https://wuxianpihub.webefficacy.com}"
export HUB_TOKEN="$(
  gh auth token |
  jq -Rs '{githubToken: rtrimstr("\\n"), kind: "browser", label: "mirror-admin-cli"}' |
  curl -fsS \
    -H "Content-Type: application/json" \
    --data-binary @- \
    "$HUB_ORIGIN/api/v1/auth/github/token-exchange" |
  jq -r '.token'
)"
```

立即验证身份：

```bash
curl -fsS \
  -H "Authorization: Bearer $HUB_TOKEN" \
  "$HUB_ORIGIN/api/v1/me" |
  jq '.user | {login, role}'
```

如果角色不是 `admin`，停止流程，不要尝试自行提升角色。

## 只读操作

列出当前 Mirror Target 不需要用户确认：

```bash
curl -fsS \
  -H "Authorization: Bearer $HUB_TOKEN" \
  "$HUB_ORIGIN/api/v1/admin/mirrors/targets" |
  jq
```

查看某个 Target 的运行记录也属于只读操作：

```bash
curl -fsS \
  -H "Authorization: Bearer $HUB_TOKEN" \
  "$HUB_ORIGIN/api/v1/admin/mirrors/targets/$TARGET_ID/jobs" |
  jq
```

## 写操作确认规则

新增仓库、修改配置、立即同步、暂停、恢复和删除 Target 都是有副作用的操作。执行前必须向用户说明：

- 目标仓库 URL
- branch
- 同步间隔
- 最大大小
- 操作类型
- 目标 ID（已有 Target）

获得明确确认后才能执行。

### 新增公开仓库

```bash
curl -fsS -X POST \
  -H "Authorization: Bearer $HUB_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{
    "repositoryUrl": "https://github.com/owner/repository",
    "branch": "main",
    "intervalSeconds": 3600,
    "maxSizeBytes": 31457280
  }' \
  "$HUB_ORIGIN/api/v1/admin/mirrors/targets" |
  jq
```

保存返回的 `.target.id` 前，确认响应成功且没有错误字段。

### 修改配置

```bash
curl -fsS -X PATCH \
  -H "Authorization: Bearer $HUB_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{
    "branch": "main",
    "intervalSeconds": 21600,
    "maxSizeBytes": 20971520
  }' \
  "$HUB_ORIGIN/api/v1/admin/mirrors/targets/$TARGET_ID" |
  jq
```

### 立即同步、暂停和恢复

```bash
curl -fsS -X POST \
  -H "Authorization: Bearer $HUB_TOKEN" \
  "$HUB_ORIGIN/api/v1/admin/mirrors/targets/$TARGET_ID/sync" | jq

curl -fsS -X POST \
  -H "Authorization: Bearer $HUB_TOKEN" \
  "$HUB_ORIGIN/api/v1/admin/mirrors/targets/$TARGET_ID/pause" | jq

curl -fsS -X POST \
  -H "Authorization: Bearer $HUB_TOKEN" \
  "$HUB_ORIGIN/api/v1/admin/mirrors/targets/$TARGET_ID/resume" | jq
```

## 清理凭据

流程结束、失败或用户取消时都应撤销当前 Hub Session，并清除 Shell 变量：

```bash
curl -fsS -X POST \
  -H "Authorization: Bearer $HUB_TOKEN" \
  "$HUB_ORIGIN/api/v1/auth/logout" >/dev/null || true

unset HUB_TOKEN HUB_ORIGIN TARGET_ID
```

不要把 Token 写入文件、聊天、Git、Shell 历史、URL、日志或 Package 数据目录。
