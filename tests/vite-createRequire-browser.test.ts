// @vitest-environment jsdom
/**
 * Reproduction rung 3: the browser-specific path (isBrowser=true).
 *
 * If this passes, `require("node:module").createRequire` works identically
 * under a DOM environment, and the browser failure is in the host's
 * optimizeDeps re-bundle rather than the runtime.
 */
import { describe, it, expect } from 'vitest';
import { VirtualFS } from '../src/virtual-fs';
import { Runtime } from '../src/runtime';

describe('vite createRequire (browser path)', () => {
  it('rung 3a: require("node:module").createRequire works under a DOM env', () => {
    const vfs = new VirtualFS();
    const runtime = new Runtime(vfs);

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
});
