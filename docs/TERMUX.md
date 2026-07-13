# WuxianPi on Termux

WuxianPi is designed to run primarily in native Termux. This keeps startup,
Android integration, paths, and memory use simpler than a permanently running
proot environment.

## Native responsibilities

- Next.js and the WuxianPi server
- Pi AgentSession runtime
- assistant directories and JSONL sessions
- model configuration and authentication
- Pi tools and compatible Node MCP servers
- Android TTS, notifications, clipboard, and sharing bridges

## Optional Ubuntu worker

Ubuntu/proot is only started for explicitly selected capabilities that cannot run
natively, such as a glibc-only executable, heavyweight Python stack, or browser
automation package.

The bridge uses JSON-RPC 2.0 over stdio. It supports health, tool discovery,
calls, cancellation, and shutdown. Protocol output is isolated from stderr logs.
The worker is started on demand and stopped after an idle timeout.

Termux and Ubuntu keep separate `node_modules`; native packages compiled for
Android Bionic must never be loaded by Ubuntu glibc Node, or vice versa.

Requests pass `assistantId` and relative paths rather than unrestricted absolute
paths. WuxianPi resolves those paths against fixed assistant roots and applies
the same permission checks used by native tools.

Ubuntu unavailability is a capability diagnostic, not a chat startup failure.
