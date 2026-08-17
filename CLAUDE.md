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
- `require('vite')` succeeds (Vite 7 from npm); `vite.createServer({ middlewareMode: true })` returns a working server. vite@8+ fails fast with a clear error.
- `RealViteServer` (`src/frameworks/real-vite-server.ts`) serves HTML/JS/TS through real Vite middleware via the SW bridge; custom `@vite/client` HMR stub (`HMR_CLIENT_CODE`).
- Exercised by `tests/vite-load.test.ts` (load, createServer, TS transform, serve via bridge, HMR client) and `examples/vue-real-vite-demo.html` + `src/vue-real-vite-demo.ts` (`npm run dev` → `/examples/vue-real-vite-demo.html`).

vite@8 is unsupported: `require('vite')` and installs of vite@8+ fail fast with a clear error (`src/vite-version.ts`). Pin `vite@^7.0.0`.

Config loading (`createRequire is not a function`) was fixed by externalizing node builtins for Node-target bundles in the esbuild shim (`src/shims/esbuild.ts`): Vite's `bundleConfigFile` runs with `platform: 'node'`, so the runtime's `require("node:module")` now provides `createRequire`. The remaining blocker is real Rollup's native binding (`native Rollup build … architecture undefined … use "@rollup/wasm-node"`) failing during `resolveConfig` — the `rollup` shim isn't catching that path yet.

## Release Process

Always bump `version` in `package.json` and update `CHANGELOG.md` before pushing. Follow [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) format, Semantic Versioning. `prepublishOnly` runs `test:run` + `build:publish`.