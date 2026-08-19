export interface RealViteServerOptions {
  root: string;
  port: number;
  vfs?: any;
  plugins?: any[];
  esbuild?: false;
}

const HMR_CLIENT_CODE = `
const hotModules = new Map();
const pendingUpdates = new Map();
const styleTags = new Map();

export function updateStyle(id, css) {
  let style = styleTags.get(id);
  if (style && !(style instanceof HTMLStyleElement)) {
    removeStyle(id);
    style = undefined;
  }
  if (!style) {
    style = document.createElement('style');
    style.setAttribute('type', 'text/css');
    style.setAttribute('data-vite-dev-id', id);
    document.head.appendChild(style);
    styleTags.set(id, style);
  }
  style.textContent = css;
}

export function removeStyle(id) {
  const style = styleTags.get(id);
  if (style && style.parentNode) {
    style.parentNode.removeChild(style);
  }
  styleTags.delete(id);
}

export function createHotContext(ownerPath) {
  if (hotModules.has(ownerPath)) {
    return hotModules.get(ownerPath);
  }
  const hot = {
    data: {},
    accept(callback) { hot._acceptCallback = callback; },
    dispose(callback) { hot._disposeCallback = callback; },
    invalidate() { location.reload(); },
    prune(callback) { hot._pruneCallback = callback; },
    on(event, cb) {},
    off(event, cb) {},
    send(event, data) {},
    _acceptCallback: null,
    _disposeCallback: null,
    _pruneCallback: null,
  };
  hotModules.set(ownerPath, hot);
  return hot;
}

window.__vite_hot_context__ = createHotContext;

window.addEventListener('message', async (event) => {
  if (!event.data || event.data.channel !== 'vite-hmr') return;
  const { type, path, timestamp } = event.data;

  if (type === 'update') {
    if (path.endsWith('.css')) {
      const links = document.querySelectorAll('link[rel="stylesheet"]');
      links.forEach(link => {
        const href = link.getAttribute('href');
        if (href && href.includes(path.replace(/^\\//, ''))) {
          link.href = href.split('?')[0] + '?t=' + timestamp;
        }
      });
      const styles = document.querySelectorAll('style[data-vite-dev-id]');
      styles.forEach(style => {
        const id = style.getAttribute('data-vite-dev-id');
        if (id && id.includes(path.replace(/^\\//, ''))) {
          import(path + '?t=' + timestamp).catch(() => {});
        }
      });
    } else if (path.match(/\\.(jsx?|tsx?)$/)) {
      const normalizedPath = path.startsWith('/') ? path : '/' + path;
      const hot = hotModules.get(normalizedPath);
      try {
        if (hot && hot._disposeCallback) hot._disposeCallback(hot.data);
        if (window.$RefreshRuntime$) {
          pendingUpdates.set(normalizedPath, timestamp);
          if (pendingUpdates.size === 1) {
            setTimeout(async () => {
              try {
                for (const [modulePath, ts] of pendingUpdates) {
                  await import('.' + modulePath + '?t=' + ts);
                }
                window.$RefreshRuntime$.performReactRefresh();
                pendingUpdates.clear();
              } catch (error) {
                console.error('[HMR] Update failed:', error);
                pendingUpdates.clear();
                location.reload();
              }
            }, 30);
          }
        } else {
          location.reload();
        }
      } catch (error) {
        console.error('[HMR] Error:', error);
        location.reload();
      }
    }
  } else if (type === 'full-reload') {
    location.reload();
  }
});
`;

export class RealViteServer {
  private getVite: () => any;
  private getHttp: () => any;
  private options: RealViteServerOptions;
  private viteServer: any = null;
  private httpServer: any = null;
  private _closed = false;
  private _hmrTarget: Window | null = null;
  private _watcherCleanup: (() => void) | null = null;

  constructor(
    getVite: () => any,
    getHttp: () => any,
    options: RealViteServerOptions,
  ) {
    this.getVite = getVite;
    this.getHttp = getHttp;
    this.options = options;
  }

  setHMRTarget(targetWindow: Window | null): void {
    this._hmrTarget = targetWindow;
  }

  async start(): Promise<void> {
    const vite = this.getVite();

    this.viteServer = await vite.createServer({
      root: this.options.root,
      server: {
        middlewareMode: true,
        hmr: false,
      },
      appType: 'spa',
      logLevel: 'silent',
      optimizeDeps: { noDiscovery: true },
      esbuild: this.options.esbuild,
      plugins: this.options.plugins || [],
    });

    const http = this.getHttp();

    const listener = (req: any, res: any) => {
      if (!this.viteServer) {
        res.statusCode = 503;
        res.end('Server not ready');
        return;
      }

      // Intercept /@vite/client with our custom HMR module
      if (req.url === '/@vite/client') {
        res.setHeader('Content-Type', 'application/javascript');
        res.end(HMR_CLIENT_CODE);
        return;
      }

      const origEnd = res.end.bind(res);
      res.end = function (...args: any[]) {
        console.log(`[RealViteServer] ${req.method} ${req.url} → ${res.statusCode} (body: ${String(args[0] || '').slice(0, 60)})`);
        return origEnd(...args);
      };

      // Wrap next to catch errors
      const wrappedNext = (err?: any) => {
        if (err) {
          console.log(`[RealViteServer] ${req.method} ${req.url} → VITE_MIDDLEWARE_ERROR: ${err.message || err} (code: ${err.code})`);
        } else {
          console.log(`[RealViteServer] ${req.method} ${req.url} → FALLTHROUGH`);
        }
        res.statusCode = 404;
        res.end('Not found');
      };

      this.viteServer.middlewares(req, res, wrappedNext);
    };

    this.httpServer = http.createServer(listener);

    // Set up VFS watcher for HMR
    this._setupWatcher();

    return new Promise((resolve, reject) => {
      this.httpServer.listen(this.options.port, () => {
        resolve();
      });
    });
  }

  private _setupWatcher(): void {
    const vfs = this.options.vfs;
    if (!vfs) return;

    const watchDir = this.options.root === '/' ? '/src' : `${this.options.root}/src`;

    try {
      const watcher = vfs.watch(watchDir, { recursive: true }, (eventType: string, filename: string) => {
        if (eventType === 'change' && filename) {
          const fullPath = filename.startsWith('/') ? filename : `${watchDir}/${filename}`;
          this._handleFileChange(fullPath);
        }
      });
      this._watcherCleanup = () => watcher.close();
    } catch {
    }

    // Also watch CSS in root
    try {
      const rootWatcher = vfs.watch(this.options.root, { recursive: false }, (eventType: string, filename: string) => {
        if (eventType === 'change' && filename) {
          this._handleFileChange(`${this.options.root}/${filename}`);
        }
      });
      const prevCleanup = this._watcherCleanup;
      this._watcherCleanup = () => {
        prevCleanup?.();
        rootWatcher.close();
      };
    } catch {
    }
  }

  private _handleFileChange(path: string): void {
    const isCSS = path.endsWith('.css');
    const isJS = /\.(jsx?|tsx?)$/.test(path);
    const updateType = (isCSS || isJS) ? 'update' : 'full-reload';

    // Invalidate Vite's internal module graph so it re-reads from VFS.
    // The most reliable way is to feed a 'change' event through Vite's own
    // watcher (chokidar shim), which Vite's invalidation pipeline listens to.
    try {
      const server = this.viteServer as any;
      if (server?.watcher?.emit) {
        server.watcher.emit('change', path);
      }
    } catch {
    }
    try {
      const server = this.viteServer as any;
      const mod = server?.moduleGraph?.getModuleById(path);
      if (mod) {
        server.moduleGraph.invalidateModule(mod);
      }
    } catch {
    }

    const update = {
      type: updateType,
      path,
      timestamp: Date.now(),
    };

    if (this._hmrTarget) {
      try {
        this._hmrTarget.postMessage({ ...update, channel: 'vite-hmr' }, '*');
      } catch {
      }
    }
  }

  async close(): Promise<void> {
    if (this._closed) return;
    this._closed = true;

    if (this._watcherCleanup) {
      this._watcherCleanup();
      this._watcherCleanup = null;
    }

    this._hmrTarget = null;

    if (this.viteServer) {
      try {
        await this.viteServer.close();
      } catch {
      }
      this.viteServer = null;
    }

    if (this.httpServer) {
      await new Promise((resolve) => {
        this.httpServer.close(resolve);
      });
      this.httpServer = null;
    }
  }

  getViteServer(): any {
    return this.viteServer;
  }

  getPort(): number {
    return this.options.port;
  }

  getHttpServer(): any {
    return this.httpServer;
  }
}
