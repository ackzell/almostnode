/**
 * Auto-injection of the almostnode Vite HMR bridge into real Vite servers.
 *
 * almostnode runs the real `vite` package (CLI, `createServer`, etc.). Its
 * HMR client (`@vite/client`) opens a native WebSocket to the dev server's
 * port, but service workers can't proxy WebSockets to virtual servers inside
 * the container. To make HMR work, we:
 *
 *   1. wrap `vite.createServer` so every server appends `viteHmrBridgePlugin`,
 *   2. the plugin prepends the browser-side `WebSocket` shim
 *      (`VITE_HMR_BRIDGE_CLIENT`) to every `/@vite/client` response,
 *   3. the shim tunnels `vite-hmr` sockets over a BroadcastChannel to the
 *      container's `ws` WebSocketServer (the real HMR server), where Vite's
 *      unmodified HMR pipeline delivers updates,
 *   4. the plugin feeds VFS file events into `server.watcher` so edits written
 *      through the virtual filesystem reach Vite's module graph and HMR fires.
 *
 * The wrap is applied at the runtime's single module-load choke point (see
 * `src/runtime.ts`), so both `require('vite')` and the CLI's dynamic import of
 * `dist/node/chunks/dep-*.js` pick it up.
 */
import { VITE_HMR_BRIDGE_CLIENT } from './shims/vite-hmr-bridge-client';
import { hmrDiagEnabled } from './shims/hmr-diag';

const wrappedCreateServer = new WeakMap<(...args: any[]) => any, (...args: any[]) => any>();
const proxiedExports = new WeakMap<object, object>();

function hmrDebug(...args: unknown[]): void {
  if (!hmrDiagEnabled()) return;
  try {
    console.log('[almostnode-hmr]', ...args);
  } catch {
    // Logging must never break the wrap path.
  }
}

/**
 * Terser renames colliding functions (e.g. `createServer$2`) across vite's
 * chunks. Normalize back to the canonical name so we can match createServer
 * under every minified shape.
 */
function normalizeExportName(name: string): string {
  return name.replace(/\$\d+$/, '');
}

type CreateServer = (...args: any[]) => any;

/**
 * Find the real `vite.createServer` function on a module's exports. Vite 7
 * exports it under several shapes depending on the entry:
 *
 *   - `dist/node/index.js` / `dist/node/chunks/server.js` — thin ESM re-export
 *     wrappers exposing `exports.createServer` directly
 *   - `dist/node/chunks/config.js` — the real implementation exported under a
 *     minified key (`ot` in 7.3.6) whose function `.name` is `createServer$2`;
 *     the minified `c` export there is `sortUserPlugins`, NOT createServer.
 *   - older `dist/node/chunks/dep-*.js` layouts — `createServer` nested on an
 *     exported `index` object (exported as `F`).
 *
 * Matching is name-based (not blind-key) so a minified collision like `c`
 * can't make us wrap the wrong function.
 */
function findCreateServer(exports: any): CreateServer | null {
  const visited = new Set<object>();
  const search = (obj: any): CreateServer | null => {
    if (!obj || (typeof obj !== 'object' && typeof obj !== 'function')) return null;
    if (visited.has(obj)) return null;
    visited.add(obj);

    const isFn = (v: any): v is CreateServer => typeof v === 'function';

    if (isFn(obj['createServer'])) return obj['createServer'];

    for (const key of Object.keys(obj)) {
      const value = obj[key];
      if (isFn(value) && normalizeExportName(key) === 'createServer') return value;
    }

    for (const key of Object.keys(obj)) {
      const value = obj[key];
      if (isFn(value) && normalizeExportName(value.name) === 'createServer') return value;
    }

    for (const key of Object.keys(obj)) {
      const value = obj[key];
      if (value && typeof value === 'object') {
        const inner = search(value);
        if (inner) return inner;
      }
    }

    if (isFn(obj['_createServer'])) return obj['_createServer'];

    return null;
  };
  return search(exports);
}

/**
 * Force-replace an export property even when it is getter-only or
 * non-writable (some ESM→CJS transforms expose live bound exports).
 */
function safeSetExport(target: any, key: string, value: any): void {
  try {
    Object.defineProperty(target, key, {
      value,
      writable: true,
      configurable: true,
      enumerable: true,
    });
  } catch {
    try {
      target[key] = value;
    } catch {
      // Non-configurable export — best effort only.
    }
  }
}

/**
 * Assign the wrapper back to every export location that referenced the
 * original function (recursively), so all import shapes (direct, minified,
 * nested `index`) hand consumers a wrapped `createServer`.
 */
function assignWrapper(exports: any, real: CreateServer, wrapper: CreateServer): void {
  const visited = new Set<object>();
  const assign = (obj: any): void => {
    if (!obj || typeof obj !== 'object' || visited.has(obj)) return;
    visited.add(obj);
    for (const key of Object.keys(obj)) {
      const value = obj[key];
      if (value === real) {
        safeSetExport(obj, key, wrapper);
      } else if (value && typeof value === 'object') {
        assign(value);
      }
    }
  };
  assign(exports);
}

/**
 * Wrap `module.exports` in a Proxy so every consumer access to `createServer`
 * (under any key, minified or renamed) resolves to the bridged wrapper — even
 * when the underlying export is getter-locked or was copied to a new location.
 * Everything else is forwarded untouched. Idempotent via `proxiedExports`.
 */
function makeExportsProxy(exports: any, real: CreateServer, wrapper: CreateServer): any {
  if (exports === real) return wrapper;
  if (!exports || (typeof exports !== 'object' && typeof exports !== 'function')) return exports;
  if (proxiedExports.has(exports)) return proxiedExports.get(exports);

  const proxy = new Proxy(exports, {
    get(target, prop, receiver) {
      if (typeof prop === 'symbol') return Reflect.get(target, prop, receiver);
      const value = Reflect.get(target, prop, receiver);
      if (value === real) return wrapper;
      if (value && typeof value === 'object') {
        const inner = findCreateServer(value);
        if (inner && inner === real) return makeExportsProxy(value, real, wrapper);
      }
      return value;
    },
    set(target, prop, value, receiver) {
      return Reflect.set(target, prop, value, receiver);
    },
  });

  proxiedExports.set(exports, proxy);
  return proxy;
}

/**
 * Wrap `vite.createServer` on a loaded vite module's exports so every Vite
 * dev server gets the HMR bridge plugin. Idempotent and failure-safe — never
 * break vite loading if injection somehow fails. Returns the (possibly
 * proxied) exports object so `loadModule` can swap it back onto
 * `module.exports`.
 */
export function wrapViteCreateServer(exports: any, sourcePath?: string, vfs?: any): any {
  try {
    const realCreateServer = findCreateServer(exports);
    if (!realCreateServer) {
      if (sourcePath) hmrDebug('no createServer export in', sourcePath);
      return exports;
    }

    const existing = wrappedCreateServer.get(realCreateServer);
    if (existing) {
      return makeExportsProxy(exports, realCreateServer, existing);
    }

    const wrapper = function (this: unknown, inlineConfig: any = {}) {
      const pluginConfig = (inlineConfig && typeof inlineConfig === 'object') ? inlineConfig : {};
      let plugins = pluginConfig.plugins;
      if (typeof plugins === 'function') {
        plugins = plugins.call(pluginConfig);
      }
      if (!Array.isArray(plugins)) plugins = [];
      // Platform default: disable Vite's dependency pre-bundling in the
      // browser. The optimizer runs through the esbuild shim
      // (context() -> full build() over the VFS plugin), which is far too slow
      // on the main thread and stalls first-preview requests past the service
      // worker's 30s timeout. Serve real ESM from node_modules instead (the
      // proven RealViteServer config). An explicit caller-provided
      // `optimizeDeps` is always respected.
      const optimizeDeps = pluginConfig.optimizeDeps ?? { noDiscovery: true };
      if (!pluginConfig.optimizeDeps) {
        hmrDebug('platform optimizeDeps disabled', sourcePath);
      }
      const config = { ...pluginConfig, optimizeDeps, plugins: [viteHmrBridgePlugin(vfs), ...plugins] };
      return realCreateServer.call(this, config);
    } as CreateServer;

    wrappedCreateServer.set(realCreateServer, wrapper);
    assignWrapper(exports, realCreateServer, wrapper);
    if (sourcePath) hmrDebug('wrapped vite.createServer in', sourcePath);
    return makeExportsProxy(exports, realCreateServer, wrapper);
  } catch (error) {
    // Injection must never break loading the real vite package.
    hmrDebug('wrap failed:', error instanceof Error ? error.message : String(error));
    return exports;
  }
}

/**
 * Vite plugin that prepends the browser WebSocket bridge shim to every
 * `/@vite/client` response. The client runs in the browser preview iframe; by
 * the time its module code executes, `window.WebSocket` has been replaced for
 * `vite-hmr` connections.
 */
function viteHmrBridgePlugin(vfs?: any): any {
  return {
    name: 'almostnode-vite-hmr-bridge',

    configureServer(server: any) {
      if (!server?.middlewares?.use) return;

      server.middlewares.use((req: any, res: any, next: any) => {
        const pathname = String(req?.url || '').split('?')[0].split('#')[0];
        if (pathname !== '/@vite/client' && !pathname.endsWith('/@vite/client')) {
          return next();
        }

        const origEnd = res.end.bind(res);
        res.end = function (chunk?: any, encoding?: any, callback?: any) {
          let body = '';
          if (chunk != null) {
            if (typeof chunk === 'string') {
              body = chunk;
            } else if (chunk instanceof Uint8Array) {
              body = new TextDecoder().decode(chunk);
            } else if (chunk instanceof ArrayBuffer) {
              body = new TextDecoder().decode(new Uint8Array(chunk));
            } else {
              body = String(chunk);
            }
          }
          try {
            res.removeHeader('Content-Length');
          } catch {
            // Ignore — some mock res objects lack removeHeader
          }
          return origEnd(VITE_HMR_BRIDGE_CLIENT + '\n' + body, encoding, callback);
        };

        next();
      });

      setupVfsWatcher(server, vfs);
      try {
        hmrDebug('bridge plugin server root=', server.config?.root, 'ws clients=', server.ws?.clients?.size ?? -1);
      } catch {
        // Best effort.
      }
    },
  };
}

/**
 * Feed VFS file events into the real Vite server's watcher.
 *
 * Vite's own chokidar watcher can't see the virtual filesystem, so edits
 * written through `require('fs')` / the VFS never invalidate the module graph
 * and HMR never fires. Mirror the VFS `watch()` contract (`'change'` for
 * existing-file writes, `'rename'` for create/delete, paths relative to the
 * watched dir) and forward them onto `server.watcher`, which Vite's
 * invalidation pipeline listens to. Ignore dependency/artefact dirs.
 */
const watchedServers = new WeakSet<object>();

function setupVfsWatcher(server: any, vfs: any): void {
  if (!vfs?.watch || !server?.watcher?.emit) return;

  // Guard: only register one VFS watcher per server instance. configureServer
  // may be called more than once for the same server (e.g. Nuxt's plugin
  // pipeline), which would otherwise create duplicate watchers and fire HMR
  // twice.
  if (watchedServers.has(server)) return;
  watchedServers.add(server);

  const root = (server.config?.root || '/') as string;
  const ignored = (p: string): boolean => /(^|\/)(node_modules|\.git|\.vite|\.nuxt|\.output|dist)(\/|$)/.test(p);

  const watchers: { close(): void }[] = [];
  const cleanup = (): void => {
    for (const watcher of watchers) {
      try {
        watcher.close();
      } catch {
        // Best effort.
      }
    }
  };

  try {
    const watcher = vfs.watch(root, { recursive: true }, (eventType: string, filename: string) => {
      if (!filename) return;
      const fullPath = filename.startsWith('/') ? filename : root === '/' ? `/${filename}` : `${root}/${filename}`;
      if (ignored(fullPath)) return;
      hmrDebug('vfs→watcher', eventType, fullPath);
      forwardVfsChange(server, vfs, fullPath, eventType);
    });
    watchers.push(watcher);
    hmrDebug('vfs watcher on', root);
  } catch (error) {
    hmrDebug('vfs watcher setup failed:', error instanceof Error ? error.message : String(error));
  }

  if (server.httpServer?.on) {
    server.httpServer.on('close', cleanup);
  }
}

function forwardVfsChange(server: any, vfs: any, fullPath: string, eventType: string): void {
  try {
    const watcher = server?.watcher;
    if (!watcher?.emit) return;

    if (eventType === 'rename') {
      if (vfs.existsSync(fullPath)) {
        // New file (or overwritten): make sure vite knows the module exists.
        const inGraph = !!server?.moduleGraph?.getModuleById(fullPath);
        hmrDebug('vfs→watcher', inGraph ? 'change' : 'add', fullPath, 'inGraph=', inGraph);
        watcher.emit(inGraph ? 'change' : 'add', fullPath);
        if (inGraph) {
          try {
            server.moduleGraph.invalidateModule(server.moduleGraph.getModuleById(fullPath));
          } catch {
            // Best effort.
          }
        }
      } else {
        hmrDebug('vfs→watcher', 'unlink', fullPath);
        watcher.emit('unlink', fullPath);
      }
      return;
    }

    const mod = server?.moduleGraph?.getModuleById(fullPath);
    hmrDebug('vfs→watcher', 'change', fullPath, 'inGraph=', !!mod);
    watcher.emit('change', fullPath);
    try {
      if (mod) {
        server.moduleGraph.invalidateModule(mod);
      }
    } catch {
      // Best effort.
    }
  } catch (error) {
    hmrDebug('vfs change forward failed:', error instanceof Error ? error.message : String(error));
  }
}