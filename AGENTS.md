# AGENTS.md

Guidance for AI agents (Claude Code, opencode, etc.) working in this repository.

## What This Is

almostnode is a **real competitor to WebContainers (StackBlitz)**. It runs Node.js natively in the browser — virtual filesystem, npm package installation, dev servers, the works. Published to npm as `almostnode` (`src/index.ts` is the public entry point).

## Core Principle

**Never write library-specific shim code. Fix the platform instead.**

When a package doesn't work, the fix goes into the generic shims (`fs`, `path`, `crypto`, etc.) or the generic module resolution in `src/runtime.ts`, not into a package-specific adapter. Every demo should use real npm packages installed via `PackageManager`, served via `/_npm/` bundling, and running through the standard runtime. No CDN shortcuts, no manual protocol reimplementations, no fake adapters.

Exceptions that exist today (keep them minimal and generic):
- `rollup` / `esbuild` / `prettier` are intercepted in `runtime.ts` and replaced with pure-JS shims because their real builds have native binaries.
- `node_modules` paths resolving to those packages are intercepted too (`src/runtime.ts:880-902`).

## Architecture

- **Runtime** (`src/runtime.ts`, ~1500 lines) — JS execution engine with `require()`, ESM-to-CJS transforms, 50+ built-in module shims, module resolution (node_modules walk, package.json `exports`/`browser`/`module`/`main`, `#imports`), module cache. Intercepts `rollup`/`esbuild`/`prettier` and blocks `vite@8+`.
- **VirtualFS** (`src/virtual-fs.ts`, ~900 lines) — In-memory POSIX filesystem with sync + promises + watch APIs, exposed as `require('fs')`. Snapshot/restore for worker/sandbox transfer.
- **PackageManager** (`src/npm/`) — Real npm packages downloaded from the registry, resolved, extracted from tarballs, ESM-to-CJS transformed via esbuild-wasm (`src/transform.ts`), and bin stubs created in `/node_modules/.bin/`.
- **Service Worker** (`public/__sw__.js`) — Network interception for HTTP servers. Requests to `/__virtual__/{port}/*` are routed to virtual servers. Version comment at top; bump it when changing.
- **ServerBridge** (`src/server-bridge.ts`) — Main-thread ↔ SW ↔ virtual-server plumbing. `getServerBridge()` is a singleton.
- **Dev Servers**:
  - `NextDevServer` (`src/frameworks/next-dev-server.ts` + `next-route-resolver.ts`, `next-api-handler.ts`, `next-html-generator.ts`, `next-shims.ts`, `next-config-parser.ts`) — Pages + App Router, API routes, CSS Modules, route groups, HMR.
  - `ViteDevServer` (`src/frameworks/vite-dev-server.ts`) — **custom** Vite-like dev server (React + HMR). Being phased out.
  - `RealViteServer` (`src/frameworks/real-vite-server.ts`) — wraps real `vite.createServer()` middleware through the SW bridge. Experimental/in-progress (see below).
- **Code Transforms** (`src/frameworks/code-transforms.ts`) — CSS Modules (css-tree AST), ESM→CJS (acorn AST), React Refresh, npm import redirect.
- **just-bash** — POSIX shell emulator in WASM, used by `container.run()` via the `child_process` shim.
- **Runtimes** — main-thread (`Runtime`), Web Worker (`WorkerRuntime`), cross-origin sandbox iframe (`SandboxRuntime`). `createRuntime()` picks by options; `createContainer()` is the main-thread convenience factory.

## Commands

```bash
npm run dev             # Vite dev server (port 5173) — the app + demos
npm run test:run        # Unit tests (vitest). Verified: 69 files, 2263 passed / 25 skipped, ~10s
npm run test:e2e        # Playwright E2E (~105 tests)
npx playwright test e2e/<file>.spec.ts   # Single E2E file
npm run type-check      # tsc --noEmit — must pass before handing off
npm run build           # Build site
npm run build:publish   # build:lib + build:types (library build for npm publish)
npm run sandbox         # Serve sandbox on port 3002 (for cross-origin demo dev)
```

Run `npm run type-check` and `npm run test:run` after any change before considering a task complete.

## Testing

- **Unit tests**: `tests/`, run with `npm run test:run`. `tests/node-compat/` holds the ~967 Node.js API compatibility tests.
- **E2E tests**: `e2e/`, Playwright. Run against the dev server on 5173 (`playwright.config.ts`). `examples/` HTML files + `src/*-demo.ts` set up the VFS per demo. Read the matching example + spec before touching a demo.
- **Diagnostics**: `tests/vite-load.test.ts` exercises real Vite load + serve. Untracked `tests/check-*.test.ts` and `tests/live-preview-diag*.test.ts` are ad-hoc diagnostic suites — treat as scratch; fold useful assertions into proper tests.

## Key Technical Details

- **`/_npm/` endpoint** (`src/frameworks/npm-serve.ts`): Bundles npm packages from VFS as ESM for browser consumption via esbuild. Handles nested `exports` (e.g. `ai/react`).
- **`/_next/route-info`**: Server endpoint returning resolved route info (page, layouts, params) — used by client-side navigation.
- **Virtual prefix**: `/__virtual__/{port}/` — all virtual-server imports go through this for service worker interception. `public/__sw__.js` also resolves plain relative URL requests from clients already inside a virtual context.
- **`isBrowser` flag**: In test env (jsdom), `isBrowser=false` — transforms run differently.
- **ESM-to-CJS**: Happens at install time (esbuild-wasm, `src/transform.ts`) and at runtime (`loadModule()` uses acorn AST with regex fallback, `src/runtime.ts`).
- **Route groups**: `(groupName)` directories are transparent in URLs, resolved server-side.
- **HMR**: VFS `watch()` → postMessage (`channel: 'next-hmr'` / `'vite-hmr'`) → iframe. React Refresh preserves state.
- **Shared require**: `src/frameworks/vfs-require.ts` extracts a require() implementation used across dev-server entry points.

## Current State: Real Vite (In Progress) + WebContainers Compat

Goal: run **real Vite** inside the browser via `vite.createServer()`, replacing the custom `ViteDevServer`, and expose a **drop-in `@webcontainer/api` facade** so WebContainers apps can swap runtimes.

Verified (unit tests green on `vite@7`):
- `require('vite')` succeeds; `createServer({ middlewareMode: true })` returns a working server.
- `RealViteServer` serves HTML/JS/TS/Vue SFCs through real Vite middleware via the SW bridge; custom `@vite/client` HMR stub.
- **`@vitejs/plugin-vue` works** (`.vue` script setup + template + scoped styles) and **sass preprocesses** `.scss` — see `tests/vue-real-vite.test.ts` and `examples/vue-real-vite-demo.html` (+ `e2e/vue-real-vite-demo.spec.ts`).
- **`almostnode/webcontainer`** subpath: `WebContainer.boot()/fs/mount/spawn/on` backed by almostnode — see `src/webcontainer-api.ts` + `tests/webcontainer-api.test.ts`.
- Generic package-manager agent (`npm`/`pnpm`/`yarn`/`bun`) in `child_process.ts` (`pnpm install --prefer-offline`, `pnpm run dev` work).
- `fs.promises.watch()` added; `require()`/`resolveModule` strip `file://` URLs; Vite HMR client stub exports `createHotContext`/`updateStyle`/`removeStyle`; `RealViteServer` invalidates Vite's module graph via `server.watcher.emit('change', path)`.

Platform fixes that made Vue work (keep them generic):
- **`vue`/`@vue/*` keep their ESM builds** at install time (`src/npm/index.ts`): the browser dev server must serve them as ESM; `require()` still works via the runtime's load-time ESM→CJS.
- ESM→CJS handles aliased re-exports (`export { x as y }`).
- **esbuild shim externalizes node builtins for Node-target bundles** (`src/shims/esbuild.ts`): Vite's config-file bundling runs with `platform: 'node'`; stubbing builtins there (e.g. `node:module` → `{}`) would strip APIs like `createRequire`. Externalizing them lets the runtime's own `require("node:module")`/`fs`/`path` resolve at load time.

Known gaps:
- Lightningcss native bindings not shimmed (Vite CSS pipeline).
- **Vite version**: only `vite@7` is supported. `require('vite')` and installs of vite@8+ fail fast with a clear error (see `src/vite-version.ts`) instead of throwing cryptic bootstrap errors. Pin `vite@^7.0.0`.
- Custom `ViteDevServer` still active as fallback.
- **Rollup native binding**: after the `createRequire` fix, the host `pnpm run dev` flow gets past config load but `resolveConfig`/`_createServer` fails loading the *real* `rollup` native bindings (`Your current platform "linux" and architecture "undefined" … native Rollup build … use "@rollup/wasm-node"`). The `rollup` shim isn't catching this path yet — next blocker.

Next steps: fix the rollup-native-binding path during vite config load, deprecate custom `ViteDevServer`, migrate amoxtli-vue-2 onto `almostnode/webcontainer`.

## Conventions

- **Do NOT add code comments** unless the surrounding code style calls for them. Header doc-comments on new modules/serious functions are acceptable and common.
- TypeScript throughout. `src/` source, `tests/` unit, `e2e/` Playwright, `examples/` demo HTML.
- Follow existing patterns; check imports before using a library (deps are in `package.json`).
- Treat `src/config/cdn.ts` as the single source of truth for CDN URLs (esm.sh, unpkg, etc.).

## Release Process

Always bump `version` in `package.json` and update `CHANGELOG.md` before pushing. Follow [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) format, Semantic Versioning. `prepublishOnly` runs `test:run` + `build:publish`.

## Where to Find More Context

- **`CLAUDE.md`** — the original agent guidance this file streamlines; both are kept in sync.
- **`README.md`** — Public API docs, usage examples, comparison with WebContainers, sandbox setup.
- **`CHANGELOG.md`** — Version history and what changed (very detailed; read the current section first).
- **`docs/`** — HTML docs site (Getting Started, Core Concepts, Security, Next.js Guide, Vite Guide, API Reference, tutorials).
- **`examples/`** — Working demo HTML files (next-demo, vite-demo, express-demo, vue-real-vite-demo, etc.).
- **`e2e/`** — Playwright tests that exercise each demo.

When working on a specific demo or feature, read the corresponding example HTML, its E2E spec, and its entry in `vite.config.js` first.