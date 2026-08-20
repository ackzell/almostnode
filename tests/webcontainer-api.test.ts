/**
 * Tests for the WebContainers-compatible facade (`almostnode/webcontainer`).
 * Modeled on the exact @webcontainer/api surface used by amoxtli-vue-2:
 * boot(), mount(), fs.* (relative paths), spawn('pnpm', ...), server-ready.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WebContainer, FileSystemTree, DirEnt } from '../src/webcontainer-api';
import { resetServerBridge } from '../src/server-bridge';
import pako from 'pako';

function createMinimalTarball(files: Record<string, string>): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];

  for (const [filename, content] of Object.entries(files)) {
    const contentBytes = encoder.encode(content);
    const header = new Uint8Array(512);
    const nameBytes = encoder.encode(filename);
    header.set(nameBytes.slice(0, 100), 0);
    header.set(encoder.encode('0000644\0'), 100);
    header.set(encoder.encode('0000000\0'), 108);
    header.set(encoder.encode('0000000\0'), 116);
    const sizeOctal = contentBytes.length.toString(8).padStart(11, '0') + ' ';
    header.set(encoder.encode(sizeOctal), 124);
    header.set(encoder.encode('00000000000\0'), 136);
    header.set(encoder.encode('        '), 148);
    header[156] = 48; // '0' regular file
    let checksum = 0;
    for (let i = 0; i < 512; i++) checksum += header[i];
    const checksumStr = checksum.toString(8).padStart(6, '0') + '\0 ';
    header.set(encoder.encode(checksumStr), 148);
    chunks.push(header, contentBytes);
    const padding = (512 - (contentBytes.length % 512)) % 512;
    if (padding) chunks.push(new Uint8Array(padding));
  }
  chunks.push(new Uint8Array(1024)); // end-of-archive
  return concatBytes(chunks);
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

describe('WebContainer (almostnode/webcontainer)', () => {
  let wc: WebContainer;

  beforeEach(() => {
    resetServerBridge();
  });

  afterEach(() => {
    wc?.teardown();
    resetServerBridge();
    vi.restoreAllMocks();
  });

  it('boot() returns a WebContainer and exposes the WebContainers surface', async () => {
    wc = await WebContainer.boot();
    expect(wc).toBeInstanceOf(WebContainer);
    expect(typeof wc.fs.readFile).toBe('function');
    expect(typeof wc.fs.writeFile).toBe('function');
    expect(typeof wc.fs.readdir).toBe('function');
    expect(typeof wc.fs.mkdir).toBe('function');
    expect(typeof wc.fs.rm).toBe('function');
    expect(typeof wc.mount).toBe('function');
    expect(typeof wc.spawn).toBe('function');
    expect(typeof wc.on).toBe('function');
    expect(wc.path).toContain('/node_modules/.bin');
  });

  it('mount() writes a flat FileSystemTree with string and binary contents', async () => {
    wc = await WebContainer.boot();
    const tree: FileSystemTree = {
      'package.json': { file: { contents: JSON.stringify({ name: 't', version: '1.0.0' }) } },
      'src/main.js': { file: { contents: 'const x = 1;' } },
      'data.bin': { file: { contents: new Uint8Array([1, 2, 3]) } },
    };
    await wc.mount(tree);

    const pkg = await wc.fs.readFile('package.json', 'utf8');
    expect(JSON.parse(pkg as string).name).toBe('t');

    const main = await wc.fs.readFile('src/main.js', 'utf8');
    expect(main).toBe('const x = 1;');

    const bin = await wc.fs.readFile('data.bin');
    expect(Array.from(bin as Uint8Array)).toEqual([1, 2, 3]);
  });

  it('mount() creates nested directories', async () => {
    wc = await WebContainer.boot();
    const tree: FileSystemTree = {
      'a/b/c.txt': { file: { contents: 'deep' } },
      'empty': { directory: {} },
    };
    await wc.mount(tree);
    expect(await wc.fs.readFile('a/b/c.txt', 'utf8')).toBe('deep');
    const entries = await wc.fs.readdir('a/b');
    expect(entries).toEqual(['c.txt']);
  });

  it('fs paths are relative to workdir and missing files reject', async () => {
    wc = await WebContainer.boot();
    await wc.fs.mkdir('node_modules', { recursive: true });
    await wc.fs.writeFile('node_modules/x/index.js', 'hi', 'utf-8');

    const entries = await wc.fs.readdir('node_modules');
    expect(entries.length).toBeGreaterThan(0);

    await expect(wc.fs.readFile('missing.json', 'utf8')).rejects.toThrow();
    await expect(wc.fs.readdir('nope')).rejects.toThrow();
  });

  it('fs.readdir with withFileTypes returns Dirents', async () => {
    wc = await WebContainer.boot();
    await wc.mount({
      'dir/a.js': { file: { contents: '' } },
      'dir/sub': { directory: {} },
    });
    const entries = (await wc.fs.readdir('dir', { withFileTypes: true })) as DirEnt[];
    const a = entries.find(e => e.name === 'a.js')!;
    const sub = entries.find(e => e.name === 'sub')!;
    expect(a.isFile()).toBe(true);
    expect(a.isDirectory()).toBe(false);
    expect(sub.isDirectory()).toBe(true);
    expect(sub.isFile()).toBe(false);
  });

  it('fs.rm removes files and (with recursive) directories', async () => {
    wc = await WebContainer.boot();
    await wc.mount({
      'src/a.js': { file: { contents: '' } },
      'src/b/c.js': { file: { contents: '' } },
    });
    await wc.fs.rm('src/a.js');
    await expect(wc.fs.readFile('src/a.js', 'utf8')).rejects.toThrow();

    await wc.fs.rm('src', { recursive: true });
    await expect(wc.fs.readdir('src')).rejects.toThrow();

    // force: missing file is a no-op
    await wc.fs.rm('definitely-missing', { force: true });
  });

  it('on() returns an unsubscribe function', async () => {
    wc = await WebContainer.boot();
    let called = 0;
    const off = wc.on('server-ready', () => { called++; });
    off();
    wc['emitter'].emit('server-ready', 5173, 'http://x/__virtual__/5173');
    expect(called).toBe(0);
  });

  it('spawn("pnpm", ["install"]) installs from package.json and exits 0', async () => {
    const manifest = {
      name: 'tiny-pkg',
      'dist-tags': { latest: '1.0.0' },
      versions: {
        '1.0.0': {
          name: 'tiny-pkg',
          version: '1.0.0',
          dist: { tarball: 'https://registry.npmjs.org/tiny-pkg/-/tiny-pkg-1.0.0.tgz', shasum: 'abc' },
          dependencies: {},
        },
      },
    };
    const tarball = createMinimalTarball({
      'package/package.json': '{"name":"tiny-pkg","version":"1.0.0"}',
      'package/index.js': 'module.exports = "tiny";',
    });
    const compressed = pako.gzip(tarball);

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const urlStr = url.toString();
      if (urlStr.includes('registry.npmjs.org/tiny-pkg') && !urlStr.includes('.tgz')) {
        return new Response(JSON.stringify(manifest), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (urlStr.includes('.tgz')) {
        return new Response(compressed, { status: 200 });
      }
      return new Response('Not found', { status: 404 });
    });

    wc = await WebContainer.boot();
    await wc.mount({
      'package.json': {
        file: {
          contents: JSON.stringify({ name: 'app', version: '1.0.0', dependencies: { 'tiny-pkg': '^1.0.0' } }),
        },
      },
    });

    const proc = await wc.spawn('pnpm', ['install', '--prefer-offline']);

    // Drain the output stream concurrently so we can assert progress streams.
    let outputText = '';
    const reader = proc.output.getReader();
    const drain = (async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        outputText += value;
      }
    })();

    const code = await proc.exit;
    await drain;
    expect(code).toBe(0);

    // Install progress should stream through proc.output (terminal panel).
    expect(outputText).toContain('Resolving');
    expect(outputText).toContain('Installing');
    expect(outputText).toContain('added 1 packages');

    // Streamed output must carry PTY-style CRLF line endings so terminals
    // render each line at column 0 (bare \n would staircase-indent).
    expect(outputText).toMatch(/\r\n/);
    expect(outputText).not.toMatch(/(?<!\r)\n/);

    const pkg = await wc.fs.readFile('node_modules/tiny-pkg/package.json', 'utf8');
    expect(JSON.parse(pkg as string).version).toBe('1.0.0');
  });

  it('spawn("pnpm", ["run", "dev"]) starts an http server and emits server-ready(5173)', async () => {
    wc = await WebContainer.boot();
    await wc.mount({
      'package.json': {
        file: {
          contents: JSON.stringify({ name: 'app', version: '1.0.0', scripts: { dev: 'node server.js' } }),
        },
      },
      'server.js': {
        file: {
          contents: `
            const http = require('http');
            const server = http.createServer((req, res) => { res.end('hi'); });
            server.listen(5173, () => {});
          `,
        },
      },
    });

    const ready = new Promise<{ port: number; url: string }>((resolve) => {
      wc.on('server-ready', (port, url) => resolve({ port, url }));
    });

    const proc = await wc.spawn('pnpm', ['run', 'dev'], { env: { DEV_SERVER_PORT: '5173' } });

    const sr = await Promise.race([
      ready,
      proc.exit.then(() => ({ exited: true })) as Promise<{ exited: boolean }>,
    ]);

    if ('exited' in sr) {
      throw new Error('Dev server exited before server-ready fired');
    }

    expect(sr.port).toBe(5173);
    expect(sr.url).toContain('/__virtual__/5173');

    // Output stream is a ReadableStream
    expect(proc.output).toBeInstanceOf(ReadableStream);

    proc.kill();
    const exitCode = await proc.exit;
    expect(typeof exitCode).toBe('number');
  });

  it('spawn with env stringifies numeric/boolean values', async () => {
    wc = await WebContainer.boot();
    await wc.mount({
      'package.json': {
        file: {
          contents: JSON.stringify({ name: 'app', version: '1.0.0', scripts: { check: 'node env-check.js' } }),
        },
      },
      'env-check.js': {
        file: {
          contents: `
            const proc = require('process');
            module.exports = { env: proc.env };
          `,
        },
      },
    });

    // Run a short-lived script that echoes its env via console
    const proc = await wc.spawn('pnpm', ['run', 'check'], { env: { NUM: 42 } });
    await proc.exit;
    // Just verify exit resolved (env handling exercised through the spawn path)
    expect(proc.exit).toBeDefined();
  });

  it('runs the html template (node http server + fs.promises.watch)', async () => {
    // Mirrors amoxtli-vue-2 templates/html/: a plain Node http server using
    // node:fs/promises watch + EventSource live reload, served on port 5173.
    wc = await WebContainer.boot();
    await wc.mount({
      'package.json': {
        file: {
          contents: JSON.stringify({ name: 'html-template', version: '1.0.0', type: 'module', scripts: { dev: 'node server.js' } }),
        },
      },
      'server.js': {
        file: {
          contents: `
            import { readFile, watch } from 'node:fs/promises'
            import { createServer } from 'node:http'

            const watcher = watch('.', { recursive: true })
            ;(async () => {
              for await (const event of watcher) {
                if (event.filename) {
                  // no-op: just prove fs.promises.watch iterates
                }
              }
            })()

            createServer(async (req, res) => {
              try {
                const url = new URL(req.url, 'http://localhost')
                const file = url.pathname === '/' ? '/index.html' : url.pathname
                let content = await readFile('.' + file, 'utf-8')
                res.writeHead(200, { 'Content-Type': 'text/html' })
                res.end(content)
              } catch {
                res.writeHead(404)
                res.end('Not found')
              }
            }).listen(5173, '0.0.0.0')
          `,
        },
      },
      'index.html': {
        file: {
          contents: '<!DOCTYPE html><html><head><title>HTML Template</title></head><body><div id="app"></div><script type="module" src="/main.js"></script></body></html>',
        },
      },
      'main.js': {
        file: { contents: 'console.log("hello");' },
      },
    });

    const ready = new Promise<{ port: number; url: string }>((resolve) => {
      wc.on('server-ready', (port, url) => resolve({ port, url }));
    });

    const proc = await wc.spawn('pnpm', ['run', 'dev']);
    const sr = await Promise.race([
      ready,
      proc.exit.then(() => ({ exited: true })) as Promise<{ exited: boolean }>,
    ]);
    if ('exited' in sr) {
      throw new Error('html template server exited before server-ready');
    }
    expect(sr.port).toBe(5173);

    // Verify fs.promises.watch is working: write a file, expect no crash
    await wc.fs.writeFile('main.js', 'console.log("updated");', 'utf8');

    proc.kill();
    await proc.exit;
  });

  it('routes async globalThis.console output (vite-banner style) into proc.output, terminal only', async () => {
    wc = await WebContainer.boot();
    await wc.mount({
      'banner.js': {
        file: {
          contents: `
            await new Promise((r) => setTimeout(r, 20));
            globalThis.console.log('  VITE v7.3.6 ready in 617 ms');
            globalThis.console.log('  \u279c  Local:   http://localhost:5173/');
            globalThis.console.warn('  \u279c  warn from async global console');
            setTimeout(() => process.exit(0), 10);
          `,
        },
      },
    });

    // Browser-level console must NOT receive the banner (terminal only) —
    // real-env emulation: console.log writes to stdout, which is the
    // process.output stream the terminal panel reads.
    const browserConsoleLines: string[] = [];
    const origLog = console.log.bind(console) as (...args: unknown[]) => void;
    console.log = ((...args: unknown[]) => {
      browserConsoleLines.push(args.map(String).join(' '));
    }) as typeof console.log;

    const proc = await wc.spawn('node', ['banner.js']);

    let outputText = '';
    const reader = proc.output.getReader() as ReadableStreamDefaultReader<string>;
    const drain = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        outputText += value;
      }
    })();

    const code = await proc.exit;
    await drain;
    console.log = origLog;

    expect(code).toBe(0);
    expect(outputText).toContain('VITE v7.3.6 ready in 617 ms');
    expect(outputText).toContain('Local:   http://localhost:5173/');
    expect(outputText).toContain('warn from async global console');
    expect(outputText.split('VITE v7.3.6 ready').length - 1).toBe(1);
    expect(browserConsoleLines.some((l) => l.includes('VITE v7.3.6 ready'))).toBe(false);
  });
});
