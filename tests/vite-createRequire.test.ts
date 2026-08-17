/**
 * Reproduction for the browser-only "createRequire is not a function" error
 * when running real Vite 7 through the container (`pnpm run dev` → `vite`).
 *
 * Vite 7.3.6's `dist/node/chunks/chunk.js` starts with:
 *   import { createRequire } from "node:module";
 *   var __require = createRequire(import.meta.url);
 *
 * almostnode's install-time transform rewrites that to:
 *   var import_node_module = require("node:module");
 *   var __require = (0, import_node_module.createRequire)(import_meta.url);
 *
 * So `require("node:module").createRequire` must be a working function.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as esbuild from 'esbuild';
import { VirtualFS } from '../src/virtual-fs';
import { Runtime } from '../src/runtime';

async function transformCode(code: string): Promise<string> {
  const result = await esbuild.transform(code, {
    loader: 'js',
    format: 'cjs',
    target: 'esnext',
    platform: 'neutral',
    define: {
      'import.meta.url': 'import_meta.url',
      'import.meta.dirname': 'import_meta.dirname',
      'import.meta.filename': 'import_meta.filename',
      'import.meta': 'import_meta',
    },
  });
  return result.code;
}

// Transform eagerly at module load, before any Runtime execution clobbers
// `globalThis.process` (which breaks native esbuild's binary resolution).
const CHUNK_CJS = await transformCode(
  'import { createRequire } from "node:module";\n' +
  'var __require = createRequire(import.meta.url);\n' +
  'exports.__require = __require;\n',
);

describe('vite createRequire reproduction', () => {
  let vfs: VirtualFS;
  let runtime: Runtime;

  beforeEach(() => {
    vfs = new VirtualFS();
    runtime = new Runtime(vfs);
  });

  it('rung 1: require("node:module").createRequire is a working function', () => {
    vfs.writeFileSync('/probe.js', `
      const m = require('node:module');
      const req = m.createRequire('/node_modules/vite/dist/node/chunks/chunk.js');
      module.exports = {
        createRequireType: typeof m.createRequire,
        reqType: typeof req,
        resolvesPath: typeof req('node:path'),
      };
    `);
    const { exports } = runtime.runFile('/probe.js');
    const r = exports as { createRequireType: string; reqType: string; resolvesPath: string };

    expect(r.createRequireType).toBe('function');
    expect(r.reqType).toBe('function');
    expect(r.resolvesPath).toBe('object');
  });

  it('rung 2: the exact transformed vite chunk snippet executes', () => {
    vfs.writeFileSync('/chunk.js', CHUNK_CJS);
    const { exports } = runtime.runFile('/chunk.js');
    const r = exports as { __require: (id: string) => unknown };

    expect(typeof r.__require).toBe('function');
    expect(typeof r.__require('node:path')).toBe('object');
  });
});
