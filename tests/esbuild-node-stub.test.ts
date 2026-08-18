// @vitest-environment jsdom
/**
 * Regression test for "createRequire is not a function" in real Vite config
 * bundling.
 *
 * Vite's config-file bundling (`bundleConfigFile`) calls the almostnode esbuild
 * shim's `build()` with `platform: 'node'`. The shim's VFS plugin used to stub
 * every node builtin (including `node:module`) as an empty `{}`, so
 * `import { createRequire } from "node:module"` in vite's dist lost its
 * `createRequire`. For Node targets we now externalize builtins so the runtime's
 * own `require("node:module")` (which provides a working `createRequire`)
 * resolves them, matching real esbuild-on-node behavior.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { VirtualFS } from '../src/virtual-fs';

type ResolveCb = (args: { path: string; importer: string }) => unknown;

interface FakeBuildHandlers {
  onResolve: ResolveCb | null;
  onResolveCallbacks: ResolveCb[];
  onLoad: Array<{ options: { namespace?: string }; cb: (args: { path: string }) => unknown }>;
}

function captureHandlers(plugins?: Array<{ setup: (b: unknown) => void }>): FakeBuildHandlers {
  const handlers: FakeBuildHandlers = { onResolve: null, onResolveCallbacks: [], onLoad: [] };
  const facade = {
    onResolve: (_options: unknown, cb: ResolveCb) => {
      handlers.onResolveCallbacks.push(cb);
      handlers.onResolve = cb;
    },
    onLoad: (options: { namespace?: string }, cb: (args: { path: string }) => unknown) => {
      handlers.onLoad.push({ options, cb });
    },
  };
  for (const p of plugins || []) {
    if (p?.setup) p.setup(facade);
  }
  return handlers;
}

describe('esbuild shim node-builtin resolution', () => {
  beforeEach(() => {
    vi.resetModules();
    (window as unknown as { __esbuild?: unknown }).__esbuild = undefined;
  });

  it('externalizes node builtins when bundling for a Node target (vite config)', async () => {
    const { build, setVFS } = await import('../src/shims/esbuild');
    const vfs = new VirtualFS();
    vfs.writeFileSync(
      '/vite.config.ts',
      'import vue from "@vitejs/plugin-vue"; export default { plugins: [vue()] };\n',
    );
    setVFS(vfs);

    let handlers: FakeBuildHandlers | null = null;
    (window as unknown as { __esbuild?: unknown }).__esbuild = {
      async build(opts: { plugins?: Array<{ setup: (b: unknown) => void }> }) {
        handlers = captureHandlers(opts.plugins);
        return { errors: [], warnings: [], outputFiles: [] };
      },
    };

    await build({
      entryPoints: ['/vite.config.ts'],
      bundle: true,
      format: 'esm',
      platform: 'node',
      write: false,
    });

    const resolution = handlers!.onResolve!({ path: 'node:module', importer: '/vite.config.ts' });
    expect(resolution).toEqual({ external: true });
  });

  it('externalizes native-binary packages (rollup/esbuild/prettier) so they resolve through the runtime', async () => {
    const { build, setVFS } = await import('../src/shims/esbuild');
    const vfs = new VirtualFS();
    vfs.writeFileSync('/vite.config.ts', 'export default {};\n');
    setVFS(vfs);

    let handlers: FakeBuildHandlers | null = null;
    (window as unknown as { __esbuild?: unknown }).__esbuild = {
      async build(opts: { plugins?: Array<{ setup: (b: unknown) => void }> }) {
        handlers = captureHandlers(opts.plugins);
        return { errors: [], warnings: [], outputFiles: [] };
      },
    };

    await build({
      entryPoints: ['/vite.config.ts'],
      bundle: true,
      format: 'esm',
      platform: 'node',
      write: false,
    });

    for (const id of ['rollup', 'rollup/parseAst', '@rollup/rollup-linux-x64-gnu', 'esbuild', '@esbuild/linux-x64', 'prettier']) {
      expect(handlers!.onResolve!({ path: id, importer: '/vite.config.ts' })).toEqual({ external: true });
    }
  });

  it('registers the VFS plugin after user plugins so they can externalize deps first', async () => {
    const { build, setVFS } = await import('../src/shims/esbuild');
    const vfs = new VirtualFS();
    vfs.writeFileSync('/vite.config.ts', 'export default {};\n');
    setVFS(vfs);

    let handlers: FakeBuildHandlers | null = null;
    (window as unknown as { __esbuild?: unknown }).__esbuild = {
      async build(opts: { plugins?: Array<{ setup: (b: unknown) => void }> }) {
        handlers = captureHandlers(opts.plugins);
        return { errors: [], warnings: [], outputFiles: [] };
      },
    };

    const userResolve = () => undefined;

    await build({
      entryPoints: ['/vite.config.ts'],
      bundle: true,
      format: 'esm',
      platform: 'node',
      write: false,
      plugins: [
        { name: 'externalize-deps', setup: (b: unknown) => (b as { onResolve: (o: unknown, cb: unknown) => void }).onResolve({ filter: /.*/ }, userResolve) },
      ],
    });

    // User plugins must be registered before the VFS fallback plugin.
    expect(handlers!.onResolveCallbacks.length).toBe(2);
    expect(handlers!.onResolveCallbacks[0]).toBe(userResolve);
    // The VFS plugin (last) still resolves VFS files and externalizes native-binary packages.
    expect(handlers!.onResolveCallbacks[1]!({ path: 'rollup', importer: '/vite.config.ts' })).toEqual({ external: true });
  });

  it('context() exposes rebuild()/dispose()/cancel() backed by build()', async () => {
    const { context, setVFS } = await import('../src/shims/esbuild');
    const vfs = new VirtualFS();
    vfs.writeFileSync('/vite.config.ts', 'export default {};\n');
    setVFS(vfs);

    let buildCalls = 0;
    (window as unknown as { __esbuild?: unknown }).__esbuild = {
      async build() {
        buildCalls++;
        return { errors: [], warnings: [], outputFiles: [] };
      },
    };

    const ctx = (await context({ entryPoints: ['/vite.config.ts'], write: false })) as {
      rebuild: () => Promise<unknown>;
      dispose: () => Promise<void>;
      cancel: () => Promise<void>;
    };

    expect(typeof ctx.rebuild).toBe('function');
    expect(typeof ctx.dispose).toBe('function');
    expect(typeof ctx.cancel).toBe('function');

    await ctx.rebuild();
    expect(buildCalls).toBe(1);
    await ctx.rebuild();
    expect(buildCalls).toBe(2);
  });

  it('emulates write: true by writing outputFiles to the VFS when outdir is set', async () => {
    const { build, setVFS } = await import('../src/shims/esbuild');
    const vfs = new VirtualFS();
    setVFS(vfs);

    (window as unknown as { __esbuild?: unknown }).__esbuild = {
      async build() {
        return {
          errors: [],
          warnings: [],
          outputFiles: [
            { path: '/node_modules/.vite/deps/vue.js', contents: new Uint8Array([1, 2, 3]), text: 'export default {};' },
            { path: '/node_modules/.vite/deps/vue.js.map', contents: new Uint8Array(), text: '{}' },
          ],
        };
      },
    };

    await build({ entryPoints: ['vue'], outdir: '/node_modules/.vite/deps', bundle: true });

    expect(vfs.existsSync('/node_modules/.vite/deps/vue.js')).toBe(true);
    expect(vfs.readFileSync('/node_modules/.vite/deps/vue.js', 'utf8')).toBe('export default {};');
    expect(vfs.existsSync('/node_modules/.vite/deps/vue.js.map')).toBe(true);
  });

  it('does not write outputFiles to the VFS when write: false', async () => {
    const { build, setVFS } = await import('../src/shims/esbuild');
    const vfs = new VirtualFS();
    setVFS(vfs);

    (window as unknown as { __esbuild?: unknown }).__esbuild = {
      async build() {
        return {
          errors: [],
          warnings: [],
          outputFiles: [{ path: '/out/vue.js', contents: new Uint8Array(), text: 'export default {};' }],
        };
      },
    };

    await build({ entryPoints: ['vue'], outdir: '/out', bundle: true, write: false });
    expect(vfs.existsSync('/out/vue.js')).toBe(false);
  });

  it('still stubs node builtins for browser targets (/_npm/ bundling)', async () => {
    const { build, setVFS } = await import('../src/shims/esbuild');
    const vfs = new VirtualFS();
    vfs.writeFileSync('/index.js', 'module.exports = {};\n');
    setVFS(vfs);

    let handlers: FakeBuildHandlers | null = null;
    (window as unknown as { __esbuild?: unknown }).__esbuild = {
      async build(opts: { plugins?: Array<{ setup: (b: unknown) => void }> }) {
        handlers = captureHandlers(opts.plugins);
        return { errors: [], warnings: [], outputFiles: [] };
      },
    };

    await build({
      entryPoints: ['/index.js'],
      bundle: true,
      format: 'esm',
      write: false,
    });

    const resolution = handlers!.onResolve!({ path: 'node:module', importer: '/index.js' });
    expect(resolution).toEqual({ path: '/__node_stub__/module', namespace: 'node-stub' });

    const stubLoader = handlers!.onLoad.find((h) => h.options.namespace === 'node-stub');
    expect(stubLoader).toBeTruthy();
    expect((stubLoader!.cb({ path: '/__node_stub__/module' }) as { contents: string }).contents)
      .toBe('module.exports = {};');
  });
});
