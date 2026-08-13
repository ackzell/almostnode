/**
 * WebContainers-compatible API (`@webcontainer/api`) backed by almostnode.
 *
 * Drop-in surface for the subset of @webcontainer/api used by browser
 * playgrounds: `WebContainer.boot()`, `fs`, `mount()`, `spawn()`, `on()`.
 *
 * ```ts
 * import { WebContainer } from 'almostnode/webcontainer';
 * const wc = await WebContainer.boot();
 * await wc.mount({ 'package.json': { file: { contents: '...' } } });
 * const install = await wc.spawn('pnpm', ['install']);
 * await install.exit;
 * wc.on('server-ready', (port, url) => { /* point an iframe at url *\/ });
 * const dev = await wc.spawn('pnpm', ['run', 'dev']);
 * ```
 */

import { VirtualFS } from './virtual-fs';
import { Runtime } from './runtime';
import { PackageManager } from './npm';
import { getServerBridge, ServerBridge } from './server-bridge';
import { spawnProcess, SpawnProcessHandle } from './shims/child_process';
import { EventEmitter } from './shims/events';
import * as path from './shims/path';

// ── Types mirroring @webcontainer/api ─────────────────────────────────────

export interface FileNode {
  file: {
    contents: string | Uint8Array;
  };
}

export interface SymlinkNode {
  file: {
    symlink: string;
  };
}

export interface DirectoryNode {
  directory: FileSystemTree;
}

export type FileSystemTree = Record<string, FileNode | SymlinkNode | DirectoryNode>;

export interface BootOptions {
  coep?: 'require-corp' | 'credentialless' | 'none';
  workdirName?: string;
  forwardPreviewErrors?: boolean | 'exceptions-only';
}

export interface SpawnOptions {
  cwd?: string;
  env?: Record<string, string | number | boolean>;
  output?: boolean;
  terminal?: { cols: number; rows: number };
}

export class DirEnt {
  constructor(
    public name: string,
    private _isDirectory: boolean,
  ) {}

  isDirectory(): boolean {
    return this._isDirectory;
  }

  isFile(): boolean {
    return !this._isDirectory;
  }
}

export interface WebContainerProcess {
  exit: Promise<number>;
  input: WritableStream<string>;
  output: ReadableStream<string>;
  kill(): void;
  resize(dimensions: { cols: number; rows: number }): void;
}

export interface FileSystemAPI {
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  readdir(path: string, options?: { withFileTypes?: boolean }): Promise<string[] | DirEnt[]>;
  readFile(path: string, encoding?: 'utf8' | 'utf-8' | null): Promise<Uint8Array | string>;
  rename(oldPath: string, newPath: string): Promise<void>;
  rm(path: string, options?: { force?: boolean; recursive?: boolean }): Promise<void>;
  writeFile(path: string, data: string | Uint8Array, encoding?: 'utf8' | 'utf-8'): Promise<void>;
  watch(path: string, listener: (event: 'rename' | 'change', filename: string | Buffer) => void): { close(): void };
  watch(path: string, options: { recursive?: boolean }, listener: (event: 'rename' | 'change', filename: string | Buffer) => void): { close(): void };
}

type ServerReadyListener = (port: number, url: string) => void;
type ErrorListener = (error: { message: string }) => void;

// ── Facade ────────────────────────────────────────────────────────────────

const DEFAULT_PATH = '/usr/local/bin:/usr/bin:/bin:/node_modules/.bin';

function normalizeFsPath(workdir: string, p: string): string {
  if (p === '' || p === '.') return workdir;
  if (p.startsWith('/')) return path.normalize(p);
  return path.normalize(path.join(workdir, p));
}

export class WebContainer {
  private vfs: VirtualFS;
  private runtime: Runtime;
  private npm: PackageManager;
  private bridge: ServerBridge;
  private emitter = new EventEmitter();
  private workdir: string;
  private activeProcesses = new Set<{ kill: () => void }>();
  private _teardown: boolean;
  readonly path: string = DEFAULT_PATH;

  private constructor(options: BootOptions = {}) {
    this.vfs = new VirtualFS();
    this.runtime = new Runtime(this.vfs, { cwd: '/' });
    this.npm = new PackageManager(this.vfs, { cwd: '/' });
    this.bridge = getServerBridge();
    this.workdir = options.workdirName ? `/${options.workdirName}` : '/';
    this._teardown = false;

    this.bridge.on('server-ready', (port: unknown, url: unknown) => {
      if (this._teardown) return;
      const p = Number(port);
      const u = String(url);
      this.emitter.emit('server-ready', p, u);
      this.emitter.emit('port', p, 'open', u);
    });
  }

  /**
   * Boot a WebContainer instance. In the browser this also registers the
   * almostnode service worker (best-effort) so `/__virtual__/{port}/`
   * preview URLs are reachable.
   */
  static async boot(options: BootOptions = {}): Promise<WebContainer> {
    const instance = new WebContainer(options);
    await instance.initServiceWorker().catch(() => {});
    return instance;
  }

  get fs(): FileSystemAPI {
    return this.createFsApi();
  }

  get workdirPath(): string {
    return this.workdir;
  }

  /**
   * Listen to WebContainer events: 'server-ready', 'port', 'error',
   * 'preview-message'. Returns an unsubscribe function.
   */
  on(event: 'server-ready', listener: ServerReadyListener): () => void;
  on(event: 'port', listener: (port: number, type: 'open' | 'close', url: string) => void): () => void;
  on(event: 'error', listener: ErrorListener): () => void;
  on(event: string, listener: (...args: any[]) => void): () => void;
  on(event: string, listener: (...args: any[]) => void): () => void {
    const wrapped = (...args: unknown[]) => {
      try {
        (listener as (...a: unknown[]) => void)(...args);
      } catch {
        // Listener errors shouldn't break the emitter
      }
    };
    this.emitter.on(event, wrapped as never);
    return () => {
      this.emitter.off(event, wrapped as never);
    };
  }

  /**
   * Mount a FileSystemTree into the virtual filesystem at `workdir`
   * (or the given mountPoint, relative to workdir).
   */
  async mount(tree: FileSystemTree | Uint8Array | ArrayBuffer, options: { mountPoint?: string } = {}): Promise<void> {
    if (this._teardown) throw new Error('WebContainer has been torn down');

    if (!tree || typeof tree === 'string') {
      throw new Error('mount: expected a FileSystemTree');
    }
    if (tree instanceof Uint8Array || tree instanceof ArrayBuffer) {
      throw new Error('mount: binary snapshots are not supported yet — pass a FileSystemTree');
    }

    const mountPoint = options.mountPoint
      ? normalizeFsPath(this.workdir, options.mountPoint)
      : this.workdir;

    this.mountTree(tree, mountPoint);
  }

  private mountTree(tree: FileSystemTree, base: string): void {
    for (const [name, node] of Object.entries(tree)) {
      const target = path.join(base, name);
      if ('directory' in node && node.directory) {
        this.vfs.mkdirSync(target, { recursive: true });
        this.mountTree(node.directory, target);
      } else if ('file' in node) {
        const fileNode = node as FileNode;
        const { contents } = fileNode.file;
        if (contents == null) {
          this.vfs.writeFileSync(target, '');
        } else if (typeof contents === 'string') {
          this.vfs.writeFileSync(target, contents);
        } else {
          this.vfs.writeFileSync(target, new Uint8Array(contents));
        }
      }
      // SymlinkNode ({ file: { symlink } }) — not supported by VirtualFS; skipped
    }
  }

  /**
   * Spawn a process. Supports the WebContainers process API:
   * `output` (merged stdout+stderr ReadableStream), `input` (WritableStream),
   * `exit` (Promise<number>), `kill()`.
   */
  async spawn(command: string, args?: string[] | SpawnOptions, options?: SpawnOptions): Promise<WebContainerProcess> {
    if (this._teardown) throw new Error('WebContainer has been torn down');

    let spawnArgs: string[] = [];
    let spawnOptions: SpawnOptions = {};
    if (Array.isArray(args)) {
      spawnArgs = args;
      spawnOptions = options || {};
    } else if (args) {
      spawnOptions = args;
    }

    const cwd = spawnOptions.cwd
      ? normalizeFsPath(this.workdir, spawnOptions.cwd)
      : this.workdir;

    let handle: SpawnProcessHandle;
    try {
      handle = spawnProcess(command, spawnArgs, {
        cwd,
        env: spawnOptions.env,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emitter.emit('error', { message });
      throw error;
    }

    const tracked = { kill: () => handle.kill() };
    this.activeProcesses.add(tracked);

    handle.exit.finally(() => {
      this.activeProcesses.delete(tracked);
    });

    return {
      output: spawnOptions.output === false ? new ReadableStream() : handle.output,
      input: handle.input,
      exit: handle.exit,
      kill: () => handle.kill(),
      resize: () => {},
    };
  }

  /**
   * Export the filesystem (or a subtree) as a FileSystemTree (json format).
   * Binary/zip formats are not supported yet.
   */
  async export(
    exportPath = '.',
    options: { format?: 'json' | 'binary' | 'zip' } = {},
  ): Promise<Uint8Array | FileSystemTree> {
    const format = options.format || 'json';
    if (format !== 'json') {
      throw new Error(`export: format "${format}" is not supported yet — use "json"`);
    }
    const root = normalizeFsPath(this.workdir, exportPath);
    const tree: FileSystemTree = {};
    this.walkToTree(root, tree);
    return tree;
  }

  private walkToTree(dir: string, out: FileSystemTree): void {
    for (const name of this.vfs.readdirSync(dir)) {
      const full = path.join(dir, name);
      let isDir: boolean;
      try {
        isDir = this.vfs.statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        const child: FileSystemTree = {};
        this.walkToTree(full, child);
        out[name] = { directory: child };
      } else {
        const data = this.vfs.readFileSync(full);
        out[name] = { file: { contents: data } };
      }
    }
  }

  /**
   * Register the almostnode service worker so `/__virtual__/{port}/`
   * URLs are intercepted and routed to virtual dev servers.
   */
  async initServiceWorker(options: { swUrl?: string } = {}): Promise<void> {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
      throw new Error('Service Workers not supported');
    }
    await this.bridge.initServiceWorker({ swUrl: options.swUrl });
  }

  /**
   * No-op placeholder (StackBlitz-only). Kept so imports compile unchanged.
   */
  async setPreviewScript(): Promise<void> {}

  /**
   * Destroy this instance: kill active processes and clear module caches.
   */
  teardown(): void {
    if (this._teardown) return;
    this._teardown = true;
    for (const proc of this.activeProcesses) {
      try {
        proc.kill();
      } catch {
        // ignore
      }
    }
    this.activeProcesses.clear();
    try {
      this.runtime.clearCache();
    } catch {
      // ignore
    }
  }

  // ── fs facade ────────────────────────────────────────────────────────────

  private createFsApi(): FileSystemAPI {
    const workdir = this.workdir;
    const vfs = this.vfs;
    const resolve = (p: string) => normalizeFsPath(workdir, p);

    return {
      async mkdir(p: string, opts?: { recursive?: boolean }): Promise<void> {
        vfs.mkdirSync(resolve(p), { recursive: opts?.recursive });
      },

      async readdir(p: string, opts?: { withFileTypes?: boolean }): Promise<string[] | DirEnt[]> {
        const names = vfs.readdirSync(resolve(p));
        if (!opts?.withFileTypes) return names;
        return names.map((name) => {
          let isDir = false;
          try {
            isDir = vfs.statSync(path.join(resolve(p), name)).isDirectory();
          } catch {
            isDir = false;
          }
          return new DirEnt(name, isDir);
        });
      },

      async readFile(p: string, encoding?: 'utf8' | 'utf-8' | null): Promise<Uint8Array | string> {
        if (encoding === 'utf8' || encoding === 'utf-8') {
          return vfs.readFileSync(resolve(p), encoding);
        }
        return vfs.readFileSync(resolve(p));
      },

      async rename(oldPath: string, newPath: string): Promise<void> {
        vfs.renameSync(resolve(oldPath), resolve(newPath));
      },

      async rm(p: string, opts?: { force?: boolean; recursive?: boolean }): Promise<void> {
        const target = resolve(p);
        let isDir: boolean;
        try {
          isDir = vfs.statSync(target).isDirectory();
        } catch (error) {
          if (opts?.force) return;
          throw error;
        }
        if (!isDir) {
          vfs.unlinkSync(target);
          return;
        }
        if (!opts?.recursive) {
          const err = new Error(`EISDIR: illegal operation on a directory, unlink '${p}'`) as Error & { code: string };
          err.code = 'EISDIR';
          throw err;
        }
        for (const name of vfs.readdirSync(target)) {
          await this.rm(path.join(p, name), { recursive: true, force: true });
        }
        vfs.rmdirSync(target);
      },

      async writeFile(p: string, data: string | Uint8Array, encoding?: 'utf8' | 'utf-8'): Promise<void> {
        if (typeof data === 'string') {
          vfs.writeFileSync(resolve(p), data);
        } else {
          vfs.writeFileSync(resolve(p), new Uint8Array(data));
        }
      },

      watch(p: string, ...rest: unknown[]): { close(): void } {
        const listener = rest.length >= 2 ? rest[1] : rest[0];
        const options = rest.length >= 2 ? (rest[0] as { recursive?: boolean }) : undefined;
        const watcher = vfs.watch(resolve(p), options, listener as never);
        return {
          close: () => watcher.close(),
        };
      },
    };
  }
}

// ── Standalone helpers mirroring @webcontainer/api ─────────────────────────

/**
 * Reload a preview iframe by messaging it, falling back to resetting its src.
 */
export async function reloadPreview(
  preview: HTMLIFrameElement,
  hardRefreshTimeout: number = 200,
): Promise<void> {
  const frame = preview.contentWindow;
  if (!frame) return;
  frame.postMessage({ type: 'reload-preview' }, '*');
  const timeout = new Promise<void>((resolve) => {
    setTimeout(resolve, hardRefreshTimeout);
  });
  await timeout;
  preview.src = preview.src;
}

/**
 * StackBlitz-only (commercial auth). No-op here.
 */
export function configureAPIKey(): void {
  // Not applicable to almostnode
}

/**
 * StackBlitz-only auth namespace. No-op stub so imports compile unchanged.
 */
export const auth = {
  init(): { status: 'need-auth' | 'authorized' } | { status: 'auth-failed' } {
    return { status: 'authorized' };
  },
  startAuthFlow(): void {},
  loggedIn(): Promise<void> {
    return Promise.resolve();
  },
  logout(): Promise<void> {
    return Promise.resolve();
  },
  on(): () => void {
    return () => {};
  },
};
