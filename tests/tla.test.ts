/**
 * Top-level await support.
 *
 * The runtime's ESM→CJS transform leaves top-level `await` untouched, which is
 * a syntax error inside its plain-function wrapper. These tests lock in that:
 * - `runFileAsync`/`executeAsync` await top-level await.
 * - the sync `execute`/`runFile` still parses code that only has `await` in a
 *   dead branch (the vite bin pattern).
 * - `require()` of a module with top-level await throws a clear error.
 */
import { describe, it, expect } from 'vitest';
import { VirtualFS } from '../src/virtual-fs';
import { Runtime } from '../src/runtime';

describe('top-level await', () => {
  it('executes a script with top-level await via runFileAsync', async () => {
    const vfs = new VirtualFS();
    const runtime = new Runtime(vfs);

    vfs.writeFileSync('/tla.js', `
      const value = await Promise.resolve(42);
      module.exports = { value };
    `);

    const result = await runtime.runFileAsync('/tla.js');
    expect((result.exports as { value: number }).value).toBe(42);
  });

  it('executes a script with top-level await in a dead branch via sync runFile', () => {
    const vfs = new VirtualFS();
    const runtime = new Runtime(vfs);

    vfs.writeFileSync('/dead-tla.js', `
      if (false) {
        const unused = await Promise.resolve(1);
      }
      module.exports = { ok: true };
    `);

    const result = runtime.runFile('/dead-tla.js');
    expect((result.exports as { ok: boolean }).ok).toBe(true);
  });

  it('does not treat await inside a function as top-level await', async () => {
    const vfs = new VirtualFS();
    const runtime = new Runtime(vfs);

    vfs.writeFileSync('/fn.js', `
      async function foo() { return await Promise.resolve(7); }
      module.exports = { foo };
    `);

    const result = await runtime.runFileAsync('/fn.js');
    const { foo } = result.exports as { foo: () => Promise<number> };
    expect(typeof foo).toBe('function');
    expect(await foo()).toBe(7);
  });

  it('throws a clear error when requiring a module with top-level await', () => {
    const vfs = new VirtualFS();
    const runtime = new Runtime(vfs);

    vfs.writeFileSync('/tla-module.js', 'module.exports = await Promise.resolve(1);');
    vfs.writeFileSync('/req.js', 'module.exports = require("./tla-module.js");');

    expect(() => runtime.runFile('/req.js')).toThrow(/top-level await/);
  });
});
