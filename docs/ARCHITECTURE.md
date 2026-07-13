# WuxianPi Architecture

WuxianPi is a mobile-first assistant workspace built around the unmodified Pi
runtime. Product concepts such as assistants, capability selection, speech,
MCP, WebUI extensions, permissions, and optional Ubuntu execution belong to
WuxianPi rather than Pi.

## Runtime layers

```text
Android WebView or browser
        |
        v
Next.js mobile UI
        |
        v
WuxianPi APIs and orchestration
  |        |          |          |
  |        |          |          +-- sandbox HTML extension host
  |        |          +------------- TTS providers
  |        +------------------------ MCP and optional Ubuntu bridge
  +--------------------------------- assistant/config/permission stores
        |
        v
@earendil-works/pi-coding-agent (unmodified)
        |
        +-- model providers
        +-- Pi tools and extensions
        +-- existing JSONL sessions
```

The default deployment runs in native Termux. Ubuntu/proot is not a second
WuxianPi installation: it is an optional, on-demand tool worker reached through
the bridge protocol.

## Assistant as a directory

An assistant ID is the validated directory name below the Pi agent directory.
The display name is mutable, but the directory ID is stable.

```text
~/.pi/agent/assistants/<assistant-id>/
├── assistant.json
├── AGENTS.md
├── MEMORY.md
├── WORKSPACES.md
├── knowledge/
└── .pi/
    ├── skills/
    └── extensions/
```

The assistant directory is passed to Pi as `cwd`. External workspaces are
described in `WORKSPACES.md`; WuxianPi does not create a parallel workspace
database. Existing sessions whose cwd is not an assistant remain visible as
legacy sessions and are never rewritten.

## Configuration resolution

Runtime configuration is resolved once before the first prompt:

```text
global defaults -> assistant manifest -> conversation overrides
```

Global configuration owns MCP/TTS connection details and secret references.
Assistants select IDs and store no plaintext secrets. Conversation overrides
are temporary and do not mutate assistant defaults.

## Capability model

The catalog combines Pi built-ins, Pi extensions, Skills, MCP tools, TTS
profiles, HTML WebUI extensions, and optional Ubuntu tools. Every capability has
a stable ID, source, availability status, diagnostics, and risk classification.

High-risk operations are checked before execution. A decision may allow one
call, persist for one assistant, or deny the call. Persisted grants never grant
access to secret values themselves.

## Session compatibility

The old `{ cwd, toolNames, provider, modelId, thinkingLevel }` creation request
remains supported. New assistant sessions use `{ assistantId, overrides }` and
resolve to the same Pi `createAgentSession` API. WuxianPi does not modify Pi's
session header or JSONL entry formats.

Disabling all tools must not clear the system prompt. Role context loaded from
the assistant directory remains active in chat-only sessions.

## Mobile performance

- Stream updates are committed in batches rather than once per token.
- Long conversations use dynamic-height virtualization.
- Tool results are collapsed by default.
- Minimap and file browsing are absent from the initial mobile render.
- Heavy Markdown renderers and document viewers are loaded on demand.
- Only a small bounded set of non-streaming AgentSession instances stays live.

