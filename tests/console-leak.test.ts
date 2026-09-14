/**
 * Console-leak regression tests.
 *
 * Host-page console noise (e.g. a UI library logging on mount) shares
 * globalThis.console with the container on the main thread. The Layer C
 * global-console capture must forward only container-originated calls into
 * the process streams and leave host-page calls untouched — regardless of
 * how aggressively the host bundle is minified (the original fix matched
 * literal package names like 'floating-vue' in stack frames, which vanish
 * in production builds).
 *
 * Container code is identified by the `//# sourceURL=almostnode:<path>`
 * tag appended by src/source-tag.ts at every evaluation site.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { VirtualFS } from '../src/virtual-fs';
import { Runtime } from '../src/runtime';
import { setStreamingCallbacks, clearStreamingCallbacks } from '../src/shims/child_process';
import { tagSource, isContainerSourceStack, SOURCE_TAG_PREFIX, SOURCE_TAG_PRAGMA } from '../src/source-tag';

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

async function waitFor(cond: () => boolean, timeoutMs = 5000, what = 'condition'): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('source-tag', () => {
  it('appends an idempotent sourceURL pragma on its own line', () => {
    const once = tagSource('console.log(1)', '/app/x.js');
    expect(once).toBe(`console.log(1)\n${SOURCE_TAG_PRAGMA}${SOURCE_TAG_PREFIX}/app/x.js`);
    expect(tagSource(once, '/app/x.js')).toBe(once);
  });

  it('classifies stacks by tagged frames, not package names', () => {
    expect(isContainerSourceStack(
      `Error\n    at cb (almostnode:/app/server.js:1:85)\n    at listOnTimeout (node:internal/timers:635:17)`
    )).toBe(true);

    // Minified production host bundle: no readable package names anywhere.
    expect(isContainerSourceStack(
      `Error\n    at Object.Mt (http://localhost:4173/assets/index-BQxUwFnS.js:41:2345)\n    at Mt.n (http://localhost:4173/assets/vendor-Dx2.js:1:99)`
    )).toBe(false);

    // The old blocklist case: dev-mode floating-vue frame, no container tag.
    expect(isContainerSourceStack(
      `Error\n    at mounted (http://localhost:5173/node_modules/floating-vue/dist/floating-vue.mjs:120:11)`
    )).toBe(false);

    expect(isContainerSourceStack(undefined)).toBe(false);
    expect(isContainerSourceStack(null)).toBe(false);
    expect(isContainerSourceStack('')).toBe(false);
  });

  it('produces tagged frames from eval and new Function in this engine', () => {
    const outer = eval(tagSource('(function(){ return () => new Error().stack; })', '/app/evaled.js'));
    expect(outer()()).toContain(`${SOURCE_TAG_PREFIX}/app/evaled.js`);

    const fn = new Function(`return () => new Error().stack;` + `\n${SOURCE_TAG_PRAGMA}${SOURCE_TAG_PREFIX}/app/fn.js`);
    expect(fn()()).toContain(`${SOURCE_TAG_PREFIX}/app/fn.js`);
  });
});

describe('Layer C global-console capture', () => {
  let vfs: VirtualFS;
  let runtime: Runtime;
  let streamed: string[];
  const g = globalThis as Record<string, unknown>;
  const realLog = console.log.bind(console);

  beforeEach(() => {
    vfs = new VirtualFS();
    runtime = new Runtime(vfs, {});
    streamed = [];
    setStreamingCallbacks({ onStdout: (d) => streamed.push(d) });
  });

  afterEach(() => {
    clearStreamingCallbacks();
    console.log = realLog;
    delete g['__almostnode_test_go'];
    delete g['__resolveExec'];
  });

  function runNode(script: string): Promise<{ stdout: string; stderr: string; error: unknown }> {
    vfs.writeFileSync('/app/script.js', script);
    const done = deferred<{ stdout: string; stderr: string; error: unknown }>();
    g['__resolveExec'] = (result: { stdout: string; stderr: string; error: unknown }) => done.resolve(result);
    runtime.execute(`
const { exec } = require('child_process');
exec('node /app/script.js', (error, stdout, stderr) => {
  globalThis.__resolveExec({ stdout: String(stdout), stderr: String(stderr), error: error ? String(error.message) : null });
});
`, '/driver.js');
    return done.promise;
  }

  it('still streams async container output that reaches globalThis.console', async () => {
    const runPromise = runNode(`
const timer = setInterval(() => {
  if (globalThis.__almostnode_test_go) {
    clearInterval(timer);
    globalThis.console.log('async-from-container');
    process.exit(0);
  }
}, 20);
`);
    g['__almostnode_test_go'] = true;
    const { stdout, stderr, error } = await runPromise;

    expect(error).toBeNull();
    expect(stderr).toBe('');
    expect(stdout).toContain('async-from-container');
    expect(streamed.join('')).toContain('async-from-container');
  }, 15000);

  it('does not leak host-page console calls into the stream while a command runs', async () => {
    const spy = vi.fn((...args: unknown[]) => realLog(...args));
    console.log = spy as unknown as typeof console.log;

    const runPromise = runNode(`
const timer = setInterval(() => {
  if (globalThis.__almostnode_test_go) {
    clearInterval(timer);
    globalThis.console.log('async-from-container');
    process.exit(0);
  }
}, 20);
`);

    // Wait until the Layer C wrap is installed (console.log swapped off our spy).
    await waitFor(() => console.log !== (spy as unknown as typeof console.log), 5000, 'Layer C wrap installation');

    // Host-page call while the wrap is live: must reach the original chain,
    // never the process stream.
    console.log('host-noise-should-not-leak');
    expect(spy).toHaveBeenCalledWith('host-noise-should-not-leak');

    // Let the container finish.
    g['__almostnode_test_go'] = true;
    const { stdout, stderr, error } = await runPromise;

    expect(error).toBeNull();
    expect(stderr).toBe('');
    expect(streamed.join('')).not.toContain('host-noise-should-not-leak');
    expect(stdout).not.toContain('host-noise-should-not-leak');
    expect(stdout).toContain('async-from-container');
    expect(streamed.join('')).toContain('async-from-container');
  }, 15000);
});
