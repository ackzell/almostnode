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

interface FakeBuildHandlers {
  onResolve: ((args: { path: string; importer: string }) => unknown) | null;
  onLoad: Array<{ options: { namespace?: string }; cb: (args: { path: string }) => unknown }>;
}

function captureHandlers(plugins?: Array<{ setup: (b: unknown) => void }>): FakeBuildHandlers {
  const handlers: FakeBuildHandlers = { onResolve: null, onLoad: [] };
  const facade = {
    onResolve: (_options: unknown, cb: FakeBuildHandlers['onResolve']) => { handlers.onResolve = cb; },
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
