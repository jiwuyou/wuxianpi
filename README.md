# WuxianPi

[中文文档](./README.zh-CN.md)

WuxianPi is a mobile-first personal assistant workspace powered by [Pi](https://github.com/badlogic/pi-mono). It keeps Pi runtime and JSONL session compatibility while adding assistant directories, role definitions, a global capability center, TTS, MCP, permissions, and sandboxed HTML WebUI extensions.

See [`docs/PRODUCT.md`](./docs/PRODUCT.md) for the product boundary and implementation direction. Pi remains an unmodified upstream runtime.

![Pi Web shows the same pi session with structured Markdown, tool calls, and project navigation beside the CLI](./docs/screenshot2.png)

The project is derived from `jiwuyou/pi-web`; Pi remains an unmodified upstream dependency.

## Quick Start

Run from source:

```bash
npm install
npm run dev
```

Then open [http://localhost:30141](http://localhost:30141). The CLI will try to open the browser automatically after the server is ready.

**Options:**

```bash
wuxianpi --port 8080              # custom port
wuxianpi --hostname 127.0.0.1     # local access only
wuxianpi -p 8080 -H 127.0.0.1     # combine options

PORT=8080 wuxianpi                # environment variable is also supported
```

## Features

- **One directory per assistant**: keep role, memory, workspace notes, knowledge, and assistant-local Pi resources together; create, copy, archive, import, and export them.
- **Mobile-first chat**: assistant cards, bottom navigation, virtualized messages, batched streaming, lazy code highlighting, and collapsed tool results.
- **Global capability center**: configure models, tools, Skills, MCP, TTS, WebUI extensions, permissions, and the optional Ubuntu worker once, then select or override them per assistant.
- **Role/capability separation**: disabling every tool does not remove `AGENTS.md`, memory, or workspace context.
- **Speech output**: browser speech, Termux Android TTS, and OpenAI-compatible/HTTP providers with preview, auto-speak, and cancellation.
- **Extension compatibility**: Pi Extension UI mapping plus rich sandboxed iframe contributions protected by CSP, nonces, and granular bridge permissions.
- **Pi compatibility**: existing JSONL sessions, forks, in-session branches, SSE reconnect, compaction, model configuration, Skills, and file preview remain available.

## Notes

- **Data directory**: WuxianPi reads `~/.pi/agent/sessions` by default. Set `PI_CODING_AGENT_DIR` to point at another pi agent directory.
- **Assistant directory**: assistants live at `~/.pi/agent/assistants/<assistant-id>` by default.
- **Session files**: files are stored as `~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl`.
- **Model config**: the Models panel reads and writes `models.json` in the pi agent directory. Model lists and defaults come from pi's config.
- **File access**: file browsing and preview are scoped to the selected project directory and working directories that appear in sessions.
- **Forks vs in-session branches**: Fork creates a new `.jsonl` file. "Edit from here" creates another branch inside the same session file.

## Development

```bash
npm install
npm run dev
```

The local dev server runs at [http://localhost:30141](http://localhost:30141).

Common checks:

```bash
node_modules/.bin/tsc --noEmit
npm run lint
```

Avoid running `next build` / `npm run build` during local development. It writes to `.next/` and can interfere with the dev server; leave builds for release work.

## Project Structure

```text
app/
  api/
    agent/          # creates/drives AgentSession and exposes SSE events
    auth/           # OAuth and API key management
    cwd/validate/   # custom working directory validation
    default-cwd/    # pi default working directory lookup
    files/          # file listing, reading, preview, and watching
    home/           # current user home directory
    models/         # available models, default model, thinking levels
    models-config/  # read/write models.json and test models
    sessions/       # session reads, rename, delete, context, HTML export
    skills/         # skill listing, search, install, enable/disable
components/
  AppShell.tsx        # main layout, URL state, top panels, file tabs
  SessionSidebar.tsx  # project selector, session tree, Explorer
  ChatWindow.tsx      # messages, SSE, image drag/drop, minimap
  ChatInput.tsx       # input bar, model/tools/thinking/compact/slash controls
  MessageView.tsx     # message, thinking, tool call/result rendering
  ModelsConfig.tsx    # model and auth configuration panel
  SkillsConfig.tsx    # skill management panel
  FileExplorer.tsx    # file tree
  FileViewer.tsx      # source, diff, image, audio, PDF, DOCX preview
lib/
  rpc-manager.ts      # AgentSessionWrapper lifecycle and global registry
  session-reader.ts   # parses .jsonl session files and branch contexts
  normalize.ts        # normalizes toolCall field names
  file-access.ts      # file read safety boundary
  file-paths.ts       # path encoding and relative path helpers
  markdown.ts         # Markdown/Mermaid/KaTeX plugin configuration
  pi-types.ts         # pi-related types
hooks/
  useAgentSession.ts  # session loading, command sending, SSE state machine
  useAudio.ts         # completion sound
  useDragDrop.ts      # image drag/drop
  useTheme.ts         # theme switching
bin/
  wuxianpi.js         # npm CLI entrypoint
```
