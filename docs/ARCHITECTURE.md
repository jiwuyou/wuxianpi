# WuxianPi Architecture

WuxianPi is a mobile-first assistant workspace built around the unmodified Pi
runtime. The user-facing Main Assistant is WuxianPi's Profile equivalent, but
the product continues to call it an Assistant.

Pi does not know about Profiles or Workspaces. WuxianPi resolves those concepts
before it creates or opens a Pi `AgentSession`.

## Runtime layers

```text
Android WebView or browser
        |
        v
apps/web mobile UI
        |
        v
runtime/wuxianpi-node
  |-- Assistant and Workspace orchestration
  |-- state.sqlite ownership registry
  |-- Package and functional-assistant resolution
  |-- MCP, TTS, permissions, Browser Host, WebUI extensions
  `-- Pi SDK adapter
        |
        v
@earendil-works/pi-coding-agent (unmodified)
  |-- AgentSession and model providers
  |-- Pi tools, Skills, and extensions
  `-- native JSONL sessions
```

Native Termux is the default deployment environment. Ubuntu/proot is an
optional tool worker, not a second WuxianPi installation.

The Runtime Profile store uses `node:sqlite`, so the Runtime requires Node.js
`>=22.19.0`.

## Assistant, Workspace, and Session

The three identifiers have separate responsibilities:

| Field | Meaning | Owner |
| --- | --- | --- |
| `assistantId` | identity, long-term memory, defaults, permissions, bindings | WuxianPi |
| `workspaceId` | registered project/environment and its context | WuxianPi |
| `cwd` | actual directory used by Pi tools and native session grouping | Pi session |
| `sessionId` | one native conversation and branch tree | Pi |

A Main Assistant can enter several Workspaces. Several Main Assistants can use
the same Workspace without sharing Assistant memory or Package bindings.

New Web sessions require an explicit `assistantId`. A `workspaceId` is optional.
When supplied, the session `cwd` must equal the Workspace `rootCwd` or be inside
it. When no Workspace and no explicit `cwd` are supplied, the Assistant
directory is only the default execution directory; it is not the ownership key.

Session ownership is immutable. Fork, new-session, import, and rebind flows
inherit the original binding before Profile resources are loaded. A live
Runtime slot cannot switch to a session with a different Assistant, Workspace,
or `cwd`.

## Storage

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
    └── package-manager/
        └── functional-assistants/<function-id>/
            ├── shared/
            └── profiles/<assistant-id>/
```

Pi continues to own the complete conversation, tool calls, branches, and
compaction entries in its native JSONL files. WuxianPi does not add fields to
those files or duplicate their contents in SQLite.

`wuxianpi/state.sqlite` stores:

- the Workspace registry (`id`, `name`, `rootCwd`, archive state and timestamps);
- immutable `sessionId -> assistantId/workspaceId/cwd` bindings;
- the source session ID for inherited bindings.

Workspace text is stored beside the registry in `INSTRUCTIONS.md` and
`MEMORY.md`. An Assistant's old `WORKSPACES.md` file is not an authoritative
registry and is not used to infer ownership.

## Unbound Pi sessions

Sessions created directly by Pi or older tools may have no row in
`state.sqlite`. They remain listable and openable with:

```json
{
  "assistantId": null,
  "workspaceId": null,
  "ownershipState": "unbound"
}
```

WuxianPi deliberately does not infer an Assistant from `cwd`, even when the
directory happens to match an Assistant path.

## Profile context assembly

For a bound session, WuxianPi assembles additional context in this fixed order:

1. shared `~/.pi/agent/wuxianpi/USER.md`;
2. Assistant `AGENTS.md`;
3. Assistant `MEMORY.md`;
4. Workspace `INSTRUCTIONS.md`;
5. Workspace `MEMORY.md`;
6. Package context contributions, sorted by contribution ID;
7. functional-assistant context contributions, sorted by function ID.

Empty files are omitted. The assembler records each included resource's source,
order, SHA-256 digest, and byte count. The result is supplied through Pi's
existing prompt/resource APIs; Pi source and SDK remain unchanged.

Package Skills, extensions, prompt templates, themes, MCP servers, and custom
tools are resolved by explicit `assistantId`, never by `cwd`.

## Stateful functional assistants

A functional assistant is a `wuxianpi.assistantTemplate` contribution with
`kind: "functional"`. It is a stateful Skill bundle, not another AgentSession.

Binding one expands its `defaultBindings` recursively and deduplicates the
resolved contributions. Package source and dependencies remain installed once.
Mutable data is stored outside the active Package revision:

```text
functional-assistants/<function-id>/
├── shared/
└── profiles/<assistant-id>/
```

Sharing modes are:

- `isolated`: read and write only the Main Assistant's `profiles/<assistantId>` data;
- `shared`: read and write only `shared` data;
- `hybrid`: read private data before shared data, and write to private data by default.

The `functional_assistant_state` Pi tool exposes bounded `list`, `read`, and
`write` operations only for functional assistants bound to the current Main
Assistant. Disabling a binding stops resource and tool access. Package update,
ordinary uninstall, and rebinding do not delete functional state; explicit
purge is required to remove it.

## Web UI boundary

The Web UI selects an Assistant, optionally selects a Workspace, and sends the
explicit IDs when creating a session. It displays session ownership returned by
the Runtime and groups history by `assistantId`; it does not derive ownership by
comparing paths.

The UI may use the Assistant directory as the default `cwd` for an ordinary
chat without a Workspace. Workspace management goes through the Runtime API;
the browser does not edit `state.sqlite` or treat `WORKSPACES.md` as a registry.

## Configuration resolution

Runtime settings are resolved before the first prompt:

```text
global defaults -> Assistant defaults -> conversation overrides
```

Global configuration owns provider credentials and connection details.
Assistants store references and bindings rather than plaintext secret copies.
Conversation overrides do not mutate Assistant defaults.

## Session compatibility

- Pi's `SessionManager`, SDK, source, and JSONL schema are unchanged.
- Fork still creates a new JSONL file; an in-session branch remains in the same file.
- WuxianPi-created Web sessions are bound explicitly.
- Pi-native sessions remain available as unbound sessions.
- Disabling all tools does not remove identity, memory, or Workspace context.
