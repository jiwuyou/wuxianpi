# WuxianPi Product Direction

WuxianPi is a mobile-first, local personal-assistant workspace powered by the
unmodified Pi runtime. Its primary navigation concept is the Assistant, not a
coding directory and not a separately exposed Profile object.

## Product model

- **Main Assistant**: who is helping the user. This is the Profile-equivalent
  identity and memory boundary.
- **Workspace**: where the Assistant is working. It provides a real execution
  root plus project-specific instructions and memory.
- **Session**: one Pi conversation. It keeps its Assistant and Workspace
  ownership for its full lifetime.
- **Functional assistant**: a reusable, stateful Skill bundle attached to one
  or more Main Assistants.

This separation lets an English coach and a coding Assistant use different
memories while both can enter the same files, or lets one Assistant move among
several projects without becoming a different identity.

## Product boundaries

- Pi remains an upstream dependency and is not forked or patched.
- Pi owns native JSONL conversations, branches, tool calls, and compaction.
- WuxianPi owns Assistant identity, Workspace registration, session ownership,
  capability selection, Packages, TTS, MCP adapters, permissions, and WebUI.
- `assistantId` is independent from `workspaceId` and `cwd`.
- A Workspace is registered data, not prose parsed from `WORKSPACES.md`.
- Provider credentials, Package installations, Termux, Ubuntu, and
  service-manager are shared infrastructure; Assistants hold references and
  permissions rather than private copies.
- Native Termux is the default host. Ubuntu/proot is an optional tool worker.

## Assistant data

```text
~/.pi/agent/assistants/<assistant-id>/
├── assistant.json
├── AGENTS.md
├── MEMORY.md
└── knowledge/
```

`assistant.json` stores display metadata and references to models, tools, MCP,
TTS, Packages, and functional assistants. `AGENTS.md` defines identity and
behavior. `MEMORY.md` stores Assistant-specific long-term memory.

The Assistant directory may be the default `cwd` for a chat without an explicit
Workspace, but path equality never establishes ownership.

## Workspace data

The Runtime stores the Workspace registry and session bindings in
`~/.pi/agent/wuxianpi/state.sqlite`. Workspace text is stored under:

```text
~/.pi/agent/wuxianpi/workspaces/<workspace-id>/
├── INSTRUCTIONS.md
└── MEMORY.md
```

The Web UI creates and edits Workspaces through the Runtime API. It selects an
Assistant and optional Workspace when starting a conversation, displays both in
the chat shell, and uses explicit ownership fields when showing history.

Sessions created outside WuxianPi remain visible as unbound Pi sessions. They
are not silently assigned to an Assistant based on their directory.

## Functional assistants

Functional assistants provide the open-and-use convenience of a role Package
without creating another independent Agent. Their Package definition may bring
Skills, context, tools, and UI, while mutable progress and experience live in a
separate function-first data directory.

One installed definition can be bound to several Main Assistants. Per binding,
the user chooses:

- `isolated` for Assistant-specific state;
- `shared` for one shared state;
- `hybrid` for private-first reads with private writes by default.

Package updates replace validated Package code and mainstream content without
overwriting functional-assistant state. Removing a binding or ordinarily
uninstalling a Package also retains state; deletion requires an explicit purge.

## Capability layering

```text
global defaults -> Assistant defaults -> conversation overrides
```

Global configuration owns credentials and available providers. Assistants
select capability references. Conversation overrides are temporary.

Existing Pi extensions remain the primary Agent extension mechanism. WuxianPi
maps abstract UI requests to mobile Web components, while rich HTML surfaces
run in sandboxed iframes behind permission-checked bridges.

## Implemented scope

- [x] Assistant discovery, CRUD, copy, archive, import, and export
- [x] Explicit Assistant/Workspace/cwd session ownership
- [x] SQLite Workspace registry and persistent session bindings
- [x] Workspace context files and HTTP CRUD API
- [x] Profile context assembly without Pi patches
- [x] Unbound Pi session visibility without cwd inference
- [x] Stateful functional assistants with three sharing modes
- [x] Package update and state-retention behavior
- [x] Assistant-first responsive mobile shell and Runtime API client
- [x] Global capability selection and per-Assistant overrides
- [x] TTS, MCP, Pi extension UI, and sandbox WebUI adapters
- [x] Granular permission broker and secret masking
- [x] Optional Ubuntu JSON-RPC tool worker
- [x] Linux and native Termux automated/build/runtime smoke verification
