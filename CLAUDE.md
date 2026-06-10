# almostnode

## What This Is

almostnode is a **real competitor to WebContainers (StackBlitz)**. It runs Node.js natively in the browser — virtual filesystem, npm package installation, dev servers, the works.

## Core Principle

**Never write library-specific shim code. Fix the platform instead.**

When a package doesn't work, the fix goes into the generic shims (fs, path, crypto, etc.), not into a package-specific adapter. Every demo should use real npm packages installed via `PackageManager`, served via `/_npm/` bundling, and running through the standard runtime. No CDN shortcuts, no manual protocol reimplementations, no fake adapters.

## Architecture

- **Runtime** (`src/runtime.ts`) — JS execution engine with `require()`, ESM-to-CJS transforms, 43 built-in module shims
- **VirtualFS** (`src/virtual-fs.ts`) — In-memory filesystem, exposed as `require('fs')`
- **PackageManager** (`src/npm/`) — Real npm packages downloaded, extracted, ESM-to-CJS transformed via esbuild-wasm
- **Service Worker** — Network interception for HTTP servers (`/__virtual__/{port}/`)
- **Dev Servers** — `NextDevServer` (Pages + App Router), `ViteDevServer` (React + HMR)
- **just-bash** — Bash emulator with custom commands (`node`, `npm`, `convex`)
- **Code Transforms** (`src/frameworks/code-transforms.ts`) — CSS Modules (css-tree AST), ESM-to-CJS (acorn AST), React Refresh, npm import redirect

### Next.js Dev Server (split across files)

- `src/frameworks/next-dev-server.ts` — Orchestrator (~1360 lines)
- `src/frameworks/next-route-resolver.ts` — Route resolution (~600 lines)
- `src/frameworks/next-api-handler.ts` — API route handlers (~350 lines)
- `src/frameworks/next-shims.ts` — Shim string constants (~1040 lines)
- `src/frameworks/next-html-generator.ts` — HTML page generation (~560 lines)
- `src/frameworks/next-config-parser.ts` — next.config.js parsing (AST + regex fallback)

## Commands

```bash
npm run dev          # Vite dev server (port 5173)
npm run test:run     # Unit tests (vitest, ~2250 tests, ~10s)
npm run test:e2e     # E2E tests (playwright, ~105 tests)
npm run build        # Build for production
```

## Testing

- Unit tests: `tests/` directory, run with `npm run test:run`
- E2E tests: `e2e/` directory, run with `npx playwright test e2e/`
- Run a single E2E file: `npx playwright test e2e/vite-demo.spec.ts`
- Test harnesses live in `examples/` (HTML files with VFS setup)

## Key Technical Details

- **`/_npm/` endpoint**: Bundles npm packages from VFS as ESM for browser consumption via esbuild
- **`/_next/route-info`**: Server endpoint returning resolved route info (page, layouts, params) — used by client-side navigation
- **Virtual prefix**: `/__virtual__/{port}/` — all imports go through this for service worker interception
- **`isBrowser` flag**: In test env (jsdom), `isBrowser=false` — transforms run differently
- **ESM-to-CJS**: Happens both at install time (esbuild-wasm) and at runtime (in `loadModule()`)
- **Route groups**: `(groupName)` directories are transparent in URLs, resolved server-side

## Where to Find More Context

- **`README.md`** — Public API docs, usage examples, comparison with WebContainers, sandbox setup
- **`CHANGELOG.md`** — Version history and what changed
- **`examples/`** — Working demo HTML files (next-demo, vite-demo, express-demo, etc.) — read these to understand how the platform is used end-to-end
- **`e2e/`** — Playwright E2E tests that exercise each demo — read these to understand what each demo should do
- **`tests/vite-load.test.ts`** — Diagnostic test suite for real Vite 8 loading and createServer

When working on a specific demo or feature, read the corresponding example HTML and E2E test first.

## Real Vite 8 Support (In Progress)

### Goal
Make real Vite 8 runnable inside the browser runtime — replacing the custom `ViteDevServer` with actual `vite.createServer()`.

### Current Status (June 2026)
- `require('vite')` succeeds — returns full Vite 8.0.16 API surface (createServer, defineConfig, build, parseAst, etc.)
- `vite.createServer({ server: { middlewareMode: true }, appType: 'custom' })` succeeds — returns a server with resolved config, middleware, SSR loader, and transform pipeline
- **Not yet wired** through the Service Worker (browser requests don't reach Vite yet)

### Shim Changes Made
1. **`src/npm/resolver.ts`** — Fixed semver `=` prefix handling (e.g., `=0.133.0` from `@oxc-project/types`)
2. **`src/shims/rolldown.ts`** (NEW) — Pure-JS shim for rolldown's 60+ native Rust exports. Intercepts all rolldown/* and @rolldown/* requires. Uses acorn for parse/parseAst, identity stubs for transform/minify, stub classes for TsconfigCache/Visitor/BuiltinPlugin, stub plugins for all vite*Plugin constructors
3. **`src/runtime.ts`** — Added rolldown import, builtinModules entry, and intercept logic (both id-based and resolved-path-based)
4. **`src/shims/crypto.ts`** — Added `crypto.hash()` (Node 21+ API)
5. **`src/shims/fs.ts`** — Added `fs.promises.rm()` to FsPromises interface and promises object

### Known Gaps
- Rolldown stubs are minimal — `rolldown()` bundler, `dev()` engine, and `scan()` are no-ops
- Lightningcss has native bindings not yet shimmed (used by Vite's CSS pipeline)
- No Service Worker bridge yet for browser-side request handling
- HMR via BroadcastChannel not wired
- Custom `ViteDevServer` still active as fallback

### Next Steps
1. Wire real Vite middleware through Service Worker bridge
2. Test actual file serving (HTML, JS, CSS transforms)
3. Add minimal rolldown stubs for features Vite needs at runtime (transformSync for CSS, etc.)
4. Gradually deprecate custom ViteDevServer

## Release Process

Always bump version in `package.json` and update `CHANGELOG.md` before pushing. Follow [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) format, Semantic Versioning.
