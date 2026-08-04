# WuxianPi

[中文文档](./README.zh-CN.md)

WuxianPi is a mobile-first personal assistant workspace powered by
[Pi](https://github.com/badlogic/pi-mono). Pi remains an unmodified upstream
runtime: WuxianPi adds assistant profiles, Workspace orchestration, capability
selection, TTS, MCP, permissions, Packages, and sandboxed HTML WebUI extensions
without changing Pi's SDK, source, or native JSONL session format.

See [`docs/PRODUCT.md`](./docs/PRODUCT.md) for the product boundary and
[`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for the runtime model.

![Pi Web shows the same Pi session with structured Markdown, tool calls, and project navigation beside the CLI](./docs/screenshot2.png)

## Quick Start

```bash
npm install
npm run dev
```

Open [http://localhost:30141](http://localhost:30141). The CLI attempts to open
the browser after the server is ready.

```bash
wuxianpi --port 8080
wuxianpi --hostname 127.0.0.1
wuxianpi -p 8080 -H 127.0.0.1
PORT=8080 wuxianpi
```

The Runtime Profile store uses `node:sqlite`; production and development
require Node.js `>=22.19.0`.

## Core Model

- **Main Assistant**: the user-facing equivalent of a Profile. It owns identity,
  long-term memory, defaults, permissions, and capability bindings.
- **Workspace**: a registered execution root with independent instructions and
  memory. `assistantId` is independent from `workspaceId` and `cwd`.
- **Session**: Pi owns the native JSONL conversation. WuxianPi stores only its
  Assistant/Workspace ownership in `state.sqlite`.
- **Functional assistant**: a stateful Skill bundle. A Package is installed once,
  while its mutable state is stored separately using `isolated`, `shared`, or
  `hybrid` access.

The Web UI uses the terms Assistant and Workspace; it does not expose a second
"Profile" product concept.

## Features

- **Assistant-first chat** with mobile navigation, virtualized messages, batched
  streaming, lazy code highlighting, and collapsed tool results.
- **Explicit session ownership** so two Assistants can use the same Workspace
  without sharing identity, memory, or capability bindings.
- **Workspace registry** with a real `rootCwd`, `INSTRUCTIONS.md`, and
  `MEMORY.md`; `WORKSPACES.md` inside an Assistant is not authoritative.
- **Global capability center** for models, tools, Skills, MCP, TTS, WebUI
  extensions, permissions, and the optional Ubuntu worker.
- **Stateful functional assistants** installed once and bound to one or more Main
  Assistants without copying Package code or dependencies.
- **Pi compatibility** for existing JSONL sessions, forks, in-session branches,
  SSE reconnect, compaction, model configuration, Skills, and file preview.

## Data Layout

```text
~/.pi/agent/
├── assistants/<assistant-id>/
│   ├── assistant.json
│   ├── AGENTS.md
│   ├── MEMORY.md
│   └── knowledge/
├── sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl
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

Sessions created directly by Pi may have no WuxianPi binding. They remain
visible as `ownershipState: "unbound"`; WuxianPi does not infer ownership from
their `cwd`.

Set `PI_CODING_AGENT_DIR` to use another Pi agent directory.

## Development

```bash
npm install
npm run runtime:test
npm run web:test
npm run product:check
npm run runtime:build
npm run web:build
```

## Project Structure

```text
apps/web/                     # production mobile Web UI
runtime/wuxianpi-node/        # Runtime, Pi adapter, sessions, Profiles, Workspaces
packages/contracts/           # stable HTTP, Package, Hub, and host contracts
packages/sdk/                 # extension and integration SDKs
apps/hub/                     # WuxianPi Hub catalog and governance service
docs/                         # product, architecture, deployment, and Package docs
```

The root-level legacy Next.js paths are not the production Profile/Workspace
implementation.
