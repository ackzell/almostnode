# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.1] - 2026-08-19

### Added
- **Opt-in debug logs**: every noisy runtime/transform/process/shim debug trace (`[runtime] Intercepted rollup`/`esbuild`, `[transform]` esbuild init + top-level-await skip, `[process] cwd()`/`chdir`, `[chokidar]`, `[zlib]`, `[rollup]`, `[fs]` `_generated` traces) is now gated behind `ALMOSTNODE_DEBUG=1` (env) or `globalThis.__ALMOSTNODE_DEBUG__` — silent by default (`src/shims/diag.ts`). The `[almostnode] loaded — version` banner still prints by default but can be silenced with `ALMOSTNODE_NO_VERSION=1`/`globalThis.__ALMOSTNODE_NO_VERSION__`.

### Fixed
- **Static file serving no longer hangs**: `VirtualFS.createReadStream` was a non-functional stub (no-op `pipe`, never emitted `open`/data), so any non-transformed static request — e.g. `fetch('/node_modules/vue/package.json')` from an app's `main.ts` — stalled Vite's `serveStaticMiddleware` (sirv) until the service worker's 30s timeout. It's now a real `Readable` (emits `open`, honors range `start`/`end`, pipes bytes + end), fixing static assets, `/node_modules/*.json`, images, and fonts over the real-Vite/webcontainer path.
- **Vite 7 optimizer knob**: the platform default for dep pre-bundling is now the vite-5.1+ supported `optimizeDeps: { noDiscovery: true }` instead of the removed `optimizeDeps.disabled` — in both `src/vite-hmr-inject.ts` (wrap default) and `RealViteServer`. A caller-provided `optimizeDeps` is still respected, and the vite deprecation warning is gone.
- **sass "default import deprecated" noise gone**: loading `sass` through real Vite's css preprocessor (`await import(file:///node_modules/sass/...)`) no longer prints `` `import sass from 'sass'` is deprecated ``. Three interop fixes in the platform: `createDynamicImport` (`src/runtime.ts`) probes for a default export with `Object.getOwnPropertyDescriptor` instead of `'default' in`, the ESM→CJS default-import interop (`src/frameworks/code-transforms.ts`) never reads accessor-style `.default` getters, and modules mixing `export default` with named exports keep `exports.default` (+`__esModule`) instead of overwriting `module.exports` (which silently dropped named exports). sass's `sass.node.mjs` exports a default object whose every property is a warn-on-access getter; with these fixes the runtime reads the plain named re-exports (like Node's namespace) and never touches the getters. Regression test: `tests/vue-real-vite.test.ts` asserts no deprecation reaches container stderr/console during a `.scss` compile.

### Added
- **Regression tests**: `tests/vite-load.test.ts` serves `/node_modules/vue/package.json` over the SW bridge with a 5s guard (previously hung ~30s then 500'd); `tests/virtual-fs.test.ts` covers `createReadStream` pipe delivery, the `open` event, and range reads.

## [0.4.0] - 2026-08-18

**Vite HMR now works end-to-end in the browser** for the real-Vite / webcontainer path. Preview starts, the bridge socket connects, and edits to a Vue SFC (or any self-accepting module) hot-update in place — no full page reload.

### Fixed
- **Bundled-ws redirect now applies to cached modules**: the `WebSocketServerRaw → require("ws").Server` redirect (`src/vite-ws-redirect.ts`) is re-applied on *every* vite module load, including `if (!code)` cache hits in `Runtime#loadModule`. Previously a long-lived worker whose module cache was seeded before the redirect existed kept the unredirected bundled `ws`, so the HMR bridge never attached.
- **VFS edits reach Vite's module graph**: `viteHmrBridgePlugin` now sets up a recursive `vfs.watch(server.config.root)` (`setupVfsWatcher` in `src/vite-hmr-inject.ts`) and forwards `file-changed`/`rename` events into `server.watcher.emit('change'|'add'|'unlink', path)`, with a `moduleGraph.invalidateModule` fallback. `src/runtime.ts` passes the `vfs` into `wrapViteCreateServer`.

### Added
- **Opt-in HMR diagnostics**: every `[almostnode-hmr]` log (bridge connect, ws relay, watcher forwarding, browser shim) is now gated behind `ALMOSTNODE_HMR_DIAG=1` (env) or `globalThis.__ALMOSTNODE_HMR_DIAG__`/`window.__ALMOSTNODE_HMR_DIAG__` — silent by default (`src/shims/hmr-diag.ts`).
- **Regression test**: `tests/vite-hmr-bridge.test.ts` now drives a full loop — load-time redirect, BroadcastChannel client ack, a self-accepting module thrown into the graph, a VFS write, and the resulting `{"type":"update",...}` payload delivered back over the bridge.

### Known issues
- **HMR on the `vite` CLI walk-through still uses the custom HMR stub**: the `RealViteServer`/`createServer` flow is fully verified; porting the bridge transport to the `vite` CLI / `almostnode/webcontainer` `pnpm run dev` path remains.
- Cold-boot: the browser bridge shim posts `connect` once; a preview opened before the dev server is ready may not attach (re-post/retry is the next fix).

## [0.3.0] - 2026-08-18

This release diverges from the upstream 0.2.x line and makes the **real `vite` CLI run end-to-end in the browser** — `pnpm install` + `pnpm run dev` on a Vue project now boots and serves through `almostnode/webcontainer`.

### Fixed
- **Rollup native binding**: the esbuild shim now externalizes `rollup`/`@rollup/rollup-*`/`esbuild`/`@esbuild/*`/`prettier`, and `process.arch`/`process.report` are provided, so Vite no longer hits `platform "linux" and architecture "undefined"`.
- **`#module-sync-enabled`**: the esbuild shim registers its VFS plugin *last*, letting Vite's `externalize-deps` externalize `vite`/`@vitejs/plugin-vue` during config bundling instead of inlining them.
- **`file://` imports**: `require()`/`resolveModule` percent-decode file URLs (e.g. `%40` → `@`).
- **ESM default-import interop**: `import X from 'y'` unwraps `.default` when the module is ESM-shaped (fixes `vue is not a function` for `@vitejs/plugin-vue`).
- **Dep optimizer**: esbuild shim implements `context()` (build-backed) + `formatMessages()` + `write`-to-VFS emulation, and its VFS `onLoad` serves reads for files resolved by Vite's own plugins (fixes `esbuild context API is not supported` / `not implemented on js`).
- **ESM preservation**: `.mjs` files and dual-package (separate ESM+CJS) entries are no longer CJS-transformed at install time, so Vite's dep optimizer sees their real ESM exports (fixes `birpc.js does not provide an export named 'default'`).

### Known issues
- **HMR/WebSocket**: Vite's HMR client's native WebSocket can't reach the virtual server (service workers can't proxy WebSockets), so live-reload is not yet wired for the `vite` CLI / webcontainer path.

## [0.2.15] - 2026-06-10

### Added
- **Real Vite 7 support**: `require('vite')` succeeds (Vite 7.x), `vite.createServer({ middlewareMode: true })` creates a working dev server
- **`RealViteServer` class** (`src/frameworks/real-vite-server.ts`): Wraps real Vite `createServer()` + http shim into a SW-registered server
- **Top-level await support**: `runFileAsync`/`executeAsync` await top-level await (the vite bin pattern); `require()` of a TLA module throws a clear error instead of a syntax error
- **`crypto.hash()`**: Node 21+ API added to crypto shim
- **`fs.promises.rm()`**: Added to fs shim
- **`req.connection` getter**: Added to http shim IncomingMessage
- **fs callback-style methods**: `writeFile`/`mkdir`/`unlink`/`rmdir`/`rm`/`rename`/`copyFile` callbacks added alongside their sync forms

### Changed
- **vite@8 is blocked**: `require('vite')` and package installs of vite@8+ now fail fast with a clear error pointing at vite@^7.0.0. Prevents cryptic bootstrap errors.
- **Two-phase dependency resolution**: direct/top-level dependencies pin their version before peer/transitive ranges (e.g. `vite: ^7.0.0` wins over `@vitejs/plugin-vue`'s `^5 || ^6 || ^7 || ^8` peer)
- **Streaming package-manager output**: `npm`/`pnpm` `run`/`install`/`ls` progress now streams to the terminal panel with CRLF line endings
- **`process.version`**: bumped to v24 to match modern tooling expectations

### Removed
- **Rolldown pure-JS shim** (`src/shims/rolldown.ts`): vite@8-only native Rust stub, no longer needed.
- **Real Vite 8 demo page** (`examples/real-vite-demo.html` + `src/real-vite-demo.ts`).

### Fixed
- **`createRequire is not a function`**: the esbuild shim now externalizes node builtins when bundling for a Node target (`platform: 'node'`) instead of stubbing them to `{}`, so vite's config-file bundling keeps `require("node:module").createRequire` working
- **Resolver semver `=` prefix**: Handles `=0.133.0` ranges from `@oxc-project/types`
- **`RealViteServer` factory pattern**: Uses `getVite()`/`getHttp()` factory functions instead of `runtime.require()` to avoid exposing internal API

## [0.2.14] - 2026-02-14

### Added
- **Agent Workbench demo**: AI coding agent that builds Next.js pages live with file editing, bash execution, and HMR preview. Added to homepage demos grid.
- **Vercel AI SDK demo**: Streaming AI chatbot with Next.js, OpenAI, and real-time token streaming via Pages Router API route
- **Express demo E2E tests**: New Playwright tests for the Express server demo
- **`vfs-require` module** (`src/frameworks/vfs-require.ts`): Shared require system extracted for reuse across entry points
- **`npm-serve` module** (`src/frameworks/npm-serve.ts`): Shared `/_npm/` package bundling endpoint with nested exports support
- **CI E2E pipeline**: GitHub Actions now runs Playwright E2E tests after unit tests with Chromium
- **CLAUDE.md**: Project instructions file for AI-assisted development

### Fixed
- **Route group client-side navigation**: Pages inside route groups (e.g. `(marketing)/about`) now render correctly during client-side navigation. Replaced local path construction with server-based `resolveRoute()` using extended `/_next/route-info` endpoint that returns actual `page` and `layouts` paths.
- **`convertToModelMessages` import**: Vercel AI SDK demo now imports from `ai` package instead of non-existent `@ai-sdk/ui-utils`
- **npm-serve nested exports**: Packages with nested `exports` field entries (e.g. `ai/react`, `@ai-sdk/openai`) now resolve correctly
- **TypeScript type errors**: Fixed duplicate `setEnv` method, `executeApiHandler` return type, `cpExec` callback types

### Changed
- **Agent Workbench guardrails removed**: AI agent can now modify any project file including root page (`/app/page.tsx`), `package.json`, and `tsconfig.json`. Only `/pages/api/chat.ts` remains protected.
- **E2E tests hardened**: Removed try/catch fallbacks across all E2E tests for strict assertions; collect page errors for better debugging
- **Convex and Vite demos refactored**: Use platform's `vfs-require` and `npm-serve` modules instead of inline implementations

## [0.2.13] - 2026-02-12

### Added
- **Centralized CDN configuration** (`src/config/cdn.ts`): Single source of truth for esm.sh, unpkg, and other CDN URLs used across the codebase
- **esm.sh version resolution**: `redirectNpmImports` now reads `package.json` dependencies and includes the major version in esm.sh URLs (e.g. `ai@4/react`), fixing 404s on subpath imports
- **Setup overlay dialogs**: Convex and Vercel AI SDK demos now show an API key setup dialog on load with privacy notice ("your key stays in your browser")
- **New tests**: `tests/cdn-config.test.ts` (12 tests) and `tests/code-transforms.test.ts` (11 tests)

### Changed
- Renamed AI chatbot demo files: `demo-ai-chatbot.html` → `demo-vercel-ai-sdk.html`, `ai-chatbot-demo.ts` → `vercel-ai-sdk-demo.ts`
- Replaced hardcoded CDN URLs throughout codebase with imports from `src/config/cdn.ts`

### Removed
- **`sentry` shim** (`src/shims/sentry.ts`): Was a no-op stub for a non-existent Node.js built-in
- **Custom `convex` command** in `child_process.ts`: Convex now runs through the generic bin stub system like any other CLI tool
- **Convex-specific path remaps** in `fs.ts`: `path.resolve()` with correct `cwd` handles this generically
- **`vfs:` prefix stripping** in `fs.ts`: Moved to esbuild shim where the artifact originates

## [0.2.12] - 2026-02-12

### Added

- **Generic bin stubs:** `npm install` now reads each package's `bin` field and creates executable scripts in `/node_modules/.bin/`. CLI tools like `vitest`, `eslint`, `tsc`, etc. work automatically via the `node` command — no custom commands needed.
- **Streaming `container.run()` API:** Long-running commands support `onStdout`/`onStderr` callbacks and `AbortController` signal for cancellation.
- **`container.sendInput()`:** Send stdin data to running processes (emits both `data` and `keypress` events for readline compatibility).
- **Vitest demo with xterm.js:** New `examples/vitest-demo.html` showcasing real vitest execution in the browser with watch mode, syntax-highlighted terminal output, and file editing.
- **E2E tests for vitest demo:** 5 Playwright tests covering install, test execution, tab switching, failure detection, and watch mode restart.
- **`rollup` shim:** Stub module so vitest's dependency chain resolves without errors.
- **`fs.realpathSync.native`:** Added as alias for `realpathSync` (used by vitest internals).
- **`fs.createReadStream` / `fs.createWriteStream`:** Basic implementations using VirtualFS.
- **`path.delimiter` and `path.win32`:** Added missing path module properties.
- **`process.getuid()`, `process.getgid()`, `process.umask()`:** Added missing process methods used by npm packages.
- **`util.deprecate()`:** Returns the original function with a no-op deprecation warning.

### Changed

- **`Object.defineProperty` patch on `globalThis`:** Forces `configurable: true` for properties defined on `globalThis`, so libraries that define non-configurable globals (like vitest's `__vitest_index__`) can be re-run without errors.
- **VFS adapter executable mode:** Files in `/node_modules/.bin/` now return `0o755` mode so just-bash treats them as executable.
- **`Runtime.clearCache()` clears in-place:** Previously created a new empty object, leaving closures referencing the stale cache. Now deletes keys in-place.
- **Watch mode uses restart pattern:** Vitest caches modules internally (Vite's ModuleRunner), so file changes require a full vitest restart (abort + re-launch) rather than stdin-triggered re-runs.

### Removed

- **Custom vitest command:** Deleted `src/shims/vitest-command.ts` and removed vitest-specific handling from `child_process.ts`. Vitest now runs through the generic bin stub + `node` command like any other CLI tool.

## [0.2.11] - 2026-02-09

### Fixed

- **Firefox blank preview:** Fixed Vite dev server injecting `<script type="module">` (React Refresh preamble) before `<script type="importmap">` in served HTML. Firefox strictly requires import maps to appear before any module scripts. The preamble is now injected after the last import map when one is present. ([#3](https://github.com/macaly/almostnode/issues/3))

## [0.2.10] - 2026-02-09

### Changed

- **Next.js dev server refactoring:** Extracted route resolution and API handler logic into standalone modules, reducing `next-dev-server.ts` from ~2240 to ~1360 lines (39% reduction):
  - `next-route-resolver.ts` (~600 lines) — App Router/Pages Router route resolution, dynamic routes, route groups, catch-all segments
  - `next-api-handler.ts` (~350 lines) — mock request/response objects, cookie parsing, API handler execution, streaming support
- **115 new unit tests** for the extracted modules (63 route resolver + 52 API handler)

## [0.2.9] - 2026-02-08

### Added

- **`browser` field support in module resolution:** npm packages with a `browser` field in package.json now resolve to their browser-specific entry point. Supports both string form (`"browser": "lib/browser/index.js"`) and object form (`"browser": {"./lib/node.js": "./lib/browser.js"}`). This fixes compatibility with packages like `depd`, `debug`, and others that provide browser-optimized versions.

### Fixed

- **Safari Express crash:** Fixed `callSite.getFileName is not a function` error when running Express in Safari. The `depd` package (an Express dependency) uses V8-specific `Error.captureStackTrace` APIs that don't exist in WebKit. By respecting depd's `"browser"` field, the no-op browser version is now loaded instead.
- **`Error.captureStackTrace` polyfill improvements:** Added `Error.stackTraceLimit` default, `.stack` getter interception on `Error.prototype` for lazy `prepareStackTrace` evaluation, re-entrancy protection, and error logging instead of silent fallback.

## [0.2.8] - 2026-02-07

### Added

- **Convex CLI deployment:** Full in-browser Convex deployment via the CLI bundle with 4 runtime patches (Sentry stub, crash capture, size check skip, site URL derivation)
- **Next.js dev server refactoring:** Extracted ~1700 lines into standalone modules:
  - `next-shims.ts` — shim string constants (~1050 lines)
  - `next-html-generator.ts` — HTML template generation (~600 lines)
  - `next-config-parser.ts` — AST-based config parsing with regex fallback (~140 lines)
  - `binary-encoding.ts` — base64/uint8 encoding utilities
- **HTTP shim improvements:** `IncomingMessage` now supports readable stream interface (`on('data')`, `on('end')`), chunked transfer encoding, proper content-length tracking
- **WebSocket shim:** Real WebSocket connectivity for Convex real-time sync (connect to `wss://` endpoints, binary frame support, ping/pong handling)
- **Stream shim:** Added `PassThrough` stream implementation
- **Crypto shim:** Added `timingSafeEqual` implementation
- **Convex E2E tests:** 6 Playwright tests including HTTP API verification that proves modified mutations deploy and run on the Convex backend

### Fixed

- **`path.resolve()` must use `process.cwd()`:** Was prepending `/` for relative paths instead of the actual working directory — caused Convex CLI to resolve `'convex'` → `/convex` instead of `/project/convex`
- **esbuild `absWorkingDir` must use `process.cwd()`:** Was defaulting to `/`, causing metafile paths to be relative to root instead of the project directory, resulting in doubled paths like `/project/project/...`
- **Convex `_generated` directory:** No longer deletes `/convex/_generated/` during deployment — the live Next.js app imports from it while the CLI only needs `/project/convex/_generated/`
- **`path.join()` debug logging removed:** Cleaned up leftover `console.log` calls for `_generated` path joins

## [0.2.7] - 2026-02-05

### Added

- **AST-based code transforms:** Replaced fragile regex-based transforms with proper AST parsing using `acorn` and `css-tree`
  - CSS Modules: `css-tree` AST for reliable class extraction and scoping (handles pseudo-selectors, nested rules, media queries)
  - ESM→CJS: `acorn` AST for precise import/export conversion (handles class exports, re-exports, `export *`, namespace imports)
  - React Refresh: `acorn` AST component detection — no longer false-detects `const API_URL = "..."` as a component
  - npm import redirect: `acorn` AST targets import/export source strings precisely, avoiding false matches in comments/strings
  - All transforms gracefully fall back to regex if AST parsing fails
- **Shared code-transforms module:** Extracted ~350 lines of transform logic into `src/frameworks/code-transforms.ts`, deduplicating `addReactRefresh()` between NextDevServer and ViteDevServer
- **New features:** CSS Modules, App Router API Routes, `useParams`, Route Groups, `basePath`, `loading.tsx`/`error.tsx`/`not-found.tsx` convention files, `next/font/local`
- **E2E test harness:** Added `examples/next-features-test.html` and `e2e/next-features.spec.ts` with 25 Playwright tests covering all new features

### Fixed

- **App Router API query params:** Fixed query string not being passed to App Router route handlers (`handleAppRouteHandler` now receives `urlObj.search`)
- **E2E import paths:** Fixed `examples/vite-demo.html` and `examples/sandbox-next-demo.html` using wrong relative import path (`./src/` → `../src/`)
- **E2E test assertions:** Fixed dynamic route test checking for `[id].jsx` string that never appears in generated HTML; fixed vite-error-overlay blocking clicks in navigation tests
- **Convex demo logging:** Added key file path logging so e2e tests can verify project files

### Dependencies

- Added `acorn` (8.15.0), `acorn-jsx` (5.3.2), `css-tree` (3.1.0)

## [0.2.6] - 2026-02-02

### Added

- **Asset prefix support:** NextDevServer now supports `assetPrefix` option for serving static assets with URL prefixes (e.g., `/marketing/images/...` → `/public/images/...`)
- **Auto-detection:** Automatically detects `assetPrefix` from `next.config.ts/js/mjs` files
- **Binary file support:** Macaly demo now supports base64-encoded binary files (images, fonts, etc.) in the virtual file system
- **File extraction script:** Added `scripts/extract-macaly-files.ts` to load real-world Next.js projects including binary assets

### Fixed

- **Virtual server asset routing:** Service worker now forwards ALL requests from virtual contexts (images, scripts, CSS) to the virtual server, not just navigation requests. This fixes 404 errors for assets using absolute URLs.
- **Double-slash URLs:** Handle URLs like `/marketing//images/foo.png` that result from concatenating assetPrefix with paths

## [0.2.5] - 2025-02-01

### Added

- **Transform caching:** Dev servers now cache transformed JSX/TS files with content-based invalidation, improving reload performance
- **Module resolution caching:** Runtime caches resolved module paths for faster repeated imports
- **Package.json parsing cache:** Parsed package.json files are cached to avoid repeated file reads
- **Processed code caching:** ESM-to-CJS transformed code is cached across module cache clears

### Fixed

- **Service Worker navigation:** Plain `<a href="/path">` links within virtual server context now correctly redirect to include the virtual prefix
- **Virtual FS mtime:** File system nodes now track actual modification times instead of returning current time
- **Flaky zlib test:** Fixed non-deterministic test that used random bytes

## [0.2.4] - 2025-01-31

### Fixed

- **App Router navigation:** Extended client-side navigation fix to also support App Router (`/app` directory). Both Pages Router and App Router now use dynamic imports for smooth navigation.

## [0.2.3] - 2025-01-31

### Fixed

- **Next.js Link navigation:** Fixed clicking `<Link>` components causing full iframe reload instead of smooth client-side navigation. Now uses dynamic page imports for proper SPA-like navigation.

## [0.2.2] - 2025-01-31

### Fixed

- **Critical:** Fixed browser bundle importing Node.js `url` module, which broke the library completely in browsers. The `sandbox-helpers.ts` now uses dynamic requires that only run in Node.js.

## [0.2.1] - 2025-01-31

### Fixed

- CI now builds library before running tests (fixes failing tests for service worker helpers)

### Changed

- Added security warning to Quick Start section in README
- Clarified that `createContainer()` should not be used with untrusted code
- Added "Running Untrusted Code Securely" example using `createRuntime()` with sandbox
- Updated repository URLs to point to macaly/almostnode

## [0.2.0] - 2025-01-31

### Added

- **Vite plugin** (`almostnode/vite`) - Automatically serves the service worker file during development
  ```typescript
  import { almostnodePlugin } from 'almostnode/vite';
  export default defineConfig({ plugins: [almostnodePlugin()] });
  ```

- **Next.js helpers** (`almostnode/next`) - Utilities for serving the service worker in Next.js apps
  - `getServiceWorkerContent()` - Returns service worker file content
  - `getServiceWorkerPath()` - Returns path to service worker file

- **Configurable service worker URL** - `initServiceWorker()` now accepts options
  ```typescript
  await bridge.initServiceWorker({ swUrl: '/custom/__sw__.js' });
  ```

- **Service worker included in sandbox files** - `generateSandboxFiles()` now generates `__sw__.js` along with `index.html` and `vercel.json`, making cross-origin sandbox deployment self-contained

### Changed

- Updated README with comprehensive Service Worker Setup documentation covering all deployment options

## [0.1.0] - 2025-01-30

### Added

- Initial release
- Virtual file system with Node.js-compatible API
- 40+ shimmed Node.js modules
- npm package installation support
- Vite and Next.js dev servers
- Hot Module Replacement with React Refresh
- Cross-origin sandbox support for secure code execution
- Web Worker runtime option
