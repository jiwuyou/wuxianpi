# WuxianPi AI Web UI upstream

This directory was imported from the Android Host repository's `ai-web-ui`
source tree. It is now the independent WuxianPi Web package and is intentionally
kept separate from the legacy Next.js application at the repository root.

The pending backend change that seeds the built-in `wuxianpi` assistant is
represented here by the stable `DEFAULT_ASSISTANT_ID = "wuxianpi"` client
contract and its default-first selection behavior. Its server implementation
and backend-only tests belong to `runtime/wuxianpi-node`, not this browser-only
package.

Excluded from the import: `.git`, `node_modules`, `.next`, `dist`,
`tsconfig.tsbuildinfo`, `bun.lock`, server-only Next.js routes, and release
artifacts. This package is a Vite SPA and must not depend on a Next.js server.
