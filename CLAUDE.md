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

Goal: run **real Vite** inside the browser via `vite.createServer()`, replacing the custom `ViteDevServer`.

Status (Jan 2026 as of last verification):
- `require('vite')` succeeds (Vite 7/8 from npm); `vite.createServer({ middlewareMode: true })` returns a working server.
- `RealViteServer` (`src/frameworks/real-vite-server.ts`) serves HTML/JS/TS through real Vite middleware via the SW bridge; custom `@vite/client` HMR stub (`HMR_CLIENT_CODE`).
- Exercised by `tests/vite-load.test.ts` (load, createServer, TS transform, serve via bridge, HMR client) and `examples/real-vite-demo.html` + `src/real-vite-demo.ts` (`npm run dev` → `/examples/real-vite-demo.html`).

Heads-up: committed HEAD pins `vite@8`; the working tree currently downgrades the test + demo to `vite@7` for diagnostics. Reconcile before merging (Vite 8 needs more rolldown/lightningcss stubs).

## Release Process

Always bump `version` in `package.json` and update `CHANGELOG.md` before pushing. Follow [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) format, Semantic Versioning. `prepublishOnly` runs `test:run` + `build:publish`.