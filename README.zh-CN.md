# WuxianPi

[English](./README.md)

WuxianPi 是基于 [Pi](https://github.com/badlogic/pi-mono) 的移动优先个人助手工作台。
Pi 始终作为未修改的上游运行时：WuxianPi 在不修改 Pi SDK、Pi 源码和原生 JSONL
会话格式的前提下，增加主助手、Workspace、能力选择、TTS、MCP、权限、Package
以及沙箱 HTML WebUI 扩展。

产品边界见 [`docs/PRODUCT.md`](./docs/PRODUCT.md)，运行时结构见
[`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)。

## 快速开始

```bash
npm install
npm run dev
```

启动后打开 [http://localhost:30141](http://localhost:30141)。

```bash
wuxianpi --port 8080
wuxianpi --hostname 127.0.0.1
wuxianpi -p 8080 -H 127.0.0.1
PORT=8080 wuxianpi
```

Runtime 的 Profile 状态库使用 `node:sqlite`，开发和生产环境需要 Node.js
`>=22.19.0`。

## 核心模型

- **主助手**：面向用户的 Profile 等价物，拥有身份、长期记忆、默认配置、权限和能力绑定。
- **Workspace**：独立登记的执行根目录，拥有自己的指令和记忆。`assistantId` 与
  `workspaceId`、`cwd` 相互独立。
- **Session**：对话正文继续由 Pi 按原生 JSONL 保存；WuxianPi 只在
  `state.sqlite` 中保存它属于哪个助手和 Workspace。
- **功能助手**：具有独立存储的 Skill 组合。Package 只安装一份，运行数据按
  `isolated`、`shared` 或 `hybrid` 模式访问。

界面继续使用“助手”和“Workspace”，不会再向用户增加一个平行的 Profile 概念。

## 主要能力

- **助手优先的移动聊天**：助手切换、虚拟消息列表、批量流式渲染、按需代码高亮和折叠工具结果。
- **显式会话归属**：两个助手可以进入同一个 Workspace，同时保持身份、记忆和能力绑定隔离。
- **Workspace 注册表**：保存真实 `rootCwd`、`INSTRUCTIONS.md` 和 `MEMORY.md`；
  助手目录内的 `WORKSPACES.md` 不再是权威数据源。
- **全局能力中心**：统一管理模型、工具、Skills、MCP、TTS、WebUI 扩展、权限和可选 Ubuntu Worker。
- **有状态功能助手**：同一 Package 和依赖不复制，可绑定给一个或多个主助手。
- **保持 Pi 兼容**：原生 JSONL、Fork、会话内分支、SSE 重连、压缩、模型配置和 Skills 继续可用。

## 数据布局

```text
~/.pi/agent/
├── assistants/<assistant-id>/
│   ├── assistant.json
│   ├── AGENTS.md
│   ├── MEMORY.md
│   └── knowledge/
├── sessions/<编码后的-cwd>/<时间戳>_<uuid>.jsonl
└── wuxianpi/
    ├── USER.md
    ├── state.sqlite
    ├── workspaces/<workspace-id>/
    │   ├── INSTRUCTIONS.md
    │   └── MEMORY.md
    └── package-manager/functional-assistants/<function-id>/
        ├── shared/
        └── profiles/<assistant-id>/
```

由 Pi 直接创建的会话可能没有 WuxianPi 归属。它们仍会显示为
`ownershipState: "unbound"`；WuxianPi 不会再根据 `cwd` 猜测所属助手。

可通过 `PI_CODING_AGENT_DIR` 指定其他 Pi agent 数据目录。

## 开发验证

```bash
npm install
npm run runtime:test
npm run web:test
npm run product:check
npm run runtime:build
npm run web:build
```

## 项目结构

```text
apps/web/                     # 生产使用的移动 Web UI
runtime/wuxianpi-node/        # Runtime、Pi 适配、会话、Profile、Workspace
packages/contracts/           # HTTP、Package、Hub 和 Host 稳定合同
packages/sdk/                 # 扩展与集成 SDK
apps/hub/                     # WuxianPi Hub 市场与治理服务
docs/                         # 产品、架构、部署和 Package 文档
```

根目录旧 Next.js 路径不是生产 Profile/Workspace 实现。
