# CLAUDE.md

**This file is kept in sync with `AGENTS.md` — read `AGENTS.md` first; it is the canonical agent guidance for this repo.** Everything below is supplementary detail.

## What This Is

almostnode is a **real competitor to WebContainers (StackBlitz)**. It runs Node.js natively in the browser — virtual filesystem, npm package installation, dev servers, the works. Published to npm as `almostnode` (`src/index.ts` is the public entry point).

## Core Principle

**Never write library-specific shim code. Fix the platform instead.**

## Next.js Dev Server (split across files)

- `src/frameworks/next-dev-server.ts` — Orchestrator (~1690 lines)
- `src/frameworks/next-route-resolver.ts` — App/Pages route resolution, dynamic routes, route groups, catch-all segments
- `src/frameworks/next-api-handler.ts` — Mock request/response, cookie parsing, API handler execution, streaming
- `src/frameworks/next-shims.ts` — Shim string constants
- `src/frameworks/next-html-generator.ts` — HTML page generation (includes Tailwind config loading via `tailwind-config-loader.ts`)
- `src/frameworks/next-config-parser.ts` — next.config parsing (AST + regex fallback)

## Real Vite Work (In Progress)

Goal: run **real Vite** inside the browser via `vite.createServer()`, replacing the custom `ViteDevServer`, and expose a **drop-in `@webcontainer/api` facade**.

Status (Aug 2026 as of last verification):
- `require('vite')` succeeds (Vite 7 from npm); `vite.createServer({ middlewareMode: true })` returns a working server. vite@8+ fails fast with a clear error (`src/vite-version.ts`). Pin `vite@^7.0.0`.
- **Live HMR works in the browser through the real-Vite `createServer` flow**: the wrapped `vite` bundle's bundled `ws` is redirected to the almostnode `ws` shim at every module load (cache hits included, `src/vite-ws-redirect.ts` + `src/runtime.ts`); a browser `window.WebSocket` shim tunnels `@vite/client` sockets over a `BroadcastChannel` to `WebSocketServer._setupHmrBridge` (`src/shims/ws.ts`, `src/shims/vite-hmr-bridge-client.ts`); and VFS edits are forwarded into Vite's graph via `setupVfsWatcher` (`src/vite-hmr-inject.ts`). Exercised end-to-end by `tests/vite-hmr-bridge.test.ts` and `e2e/vue-real-vite-demo.spec.ts`.
- All `[almostnode-hmr]` logs are opt-in via `ALMOSTNODE_HMR_DIAG=1` / `globalThis.__ALMOSTNODE_HMR_DIAG__` (`src/shims/hmr-diag.ts`); silent by default.
- Bridging the transport to the `vite` CLI / `almostnode/webcontainer` `pnpm run dev` path (beyond the createServer flow) and deprecating custom `ViteDevServer` are the next steps.

Key platform fixes that made real Vite work: `.mjs`/dual-package ESM preserved at install time; esbuild shim externalizes node builtins + native-binary packages, implements `context()`/`formatMessages()`/write-to-VFS; `process.arch`/`process.report` added; ESM→CJS default-import interop. Details in `AGENTS.md`.

## Release Process

Always bump `version` in `package.json` and update `CHANGELOG.md` before pushing. Follow [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) format, Semantic Versioning. `prepublishOnly` runs `test:run` + `build:publish`.