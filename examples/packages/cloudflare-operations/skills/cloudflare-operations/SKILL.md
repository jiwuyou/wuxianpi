---
name: cloudflare-operations
description: Operates Cloudflare DNS, Workers, Pages, and account resources through MCP. Use when inspecting, changing, or diagnosing Cloudflare configuration.
---

# Cloudflare Operations

Use the Cloudflare MCP contribution for account discovery and changes. Read the
current object before mutating it, present the intended change to the user, and
confirm the resulting state after the tool call.

For long operations, report the operation identifier and poll the Cloudflare
API through MCP instead of assuming that submission means completion.
