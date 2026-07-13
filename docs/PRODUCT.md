# WuxianPi Product Direction

WuxianPi is a mobile-first, local personal-assistant workspace powered by the
unmodified Pi runtime. It starts from the pi-web codebase, but its primary
navigation and product model are assistants rather than coding projects.

## Product boundaries

- Pi remains an upstream dependency and is not forked or patched.
- WuxianPi owns assistant orchestration, mobile UI, capability selection, TTS,
  MCP adapters, and optional HTML-based WebUI extensions.
- One assistant maps to one real working directory. Pi uses that directory as
  the session `cwd` and loads its normal project context and resources.
- The default deployment target is native Termux. An Ubuntu/proot worker is an
  optional, on-demand environment for tools that cannot run natively.

## Assistant directory

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

`assistant.json` stores display metadata and references to globally configured
models, tools, MCP servers, and TTS voices. Role behavior remains readable and
editable in `AGENTS.md`. External workspaces are described in `WORKSPACES.md`.

## Capability layering

Global configuration owns credentials and available providers. Assistants only
select capability references, and a conversation may apply temporary overrides.

```text
global defaults -> assistant defaults -> conversation overrides
```

The global capability center will cover models, Pi tools, MCP servers, Skills,
TTS providers, and WebUI extensions.

## WebUI extensions

Existing Pi extensions remain the primary Agent extension mechanism. WuxianPi
maps Pi's abstract UI requests to mobile Web components. Extensions that need a
rich visual surface may optionally contribute sandboxed HTML/JavaScript/CSS
panels and tool-result renderers through a permission-checked bridge.

## Mobile performance principles

- Keep the core chat shell small and touch-first.
- Load file browsing, Mermaid, KaTeX, document preview, and advanced diagnostics
  only when requested.
- Render streaming text in batches and virtualize long conversations.
- Keep tool results collapsed by default.
- Retain only a small number of live AgentSession runtimes on mobile.

## Implementation status

- [x] WuxianPi branding and independent repository
- [x] Assistant-directory discovery, CRUD, copy, archive, import, and export
- [x] Assistant-first responsive mobile shell
- [x] Global capability selection and per-assistant overrides
- [x] TTS and Pi extension Web UI compatibility
- [x] MCP and sandbox HTML WebUI extension adapters
- [x] Granular permission broker and secret masking
- [x] Optional Ubuntu JSON-RPC tool worker
- [x] Mobile streaming batching, virtualization, and lazy heavy renderers
- [x] Linux and native Termux automated/build/runtime smoke verification
