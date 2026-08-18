/**
 * Regression tests for the Vite HMR bridge.
 *
 * Vite bundles `ws` into its node dist chunks; the bridge (browser
 * `window.WebSocket` shim + container `WebSocketServer._setupHmrBridge`) only
 * works if vite's HMR WebSocketServer is the almostnode ws shim. These tests
 * pin the exact vite version that ships the bundled ws and verify the
 * load-time redirect is applied, that a BroadcastChannel client actually
 * gets acked by the running dev server, and that VFS file changes are
 * forwarded into vite's watcher so an HMR update is delivered back over the
 * bridge.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { VirtualFS } from '../src/virtual-fs';
import { Runtime } from '../src/runtime';
import { PackageManager } from '../src/npm';
import { redirectViteBundledWsToShim } from '../src/vite-ws-redirect';

const VITE_VERSION = '7.3.6';
const ANCHOR =
  'const WebSocketServerRaw = process.versions.bun ? import.meta.require("ws").WebSocketServer : import_websocket_server.default;';

describe('vite-hmr-bridge', () => {
  let vfs: VirtualFS;
  let runtime: Runtime;
  let npm: PackageManager;

  beforeAll(async () => {
    vfs = new VirtualFS();
    runtime = new Runtime(vfs, {
      cwd: '/',
      env: { NODE_ENV: 'development' },
    });
    npm = new PackageManager(vfs, { cwd: '/' });

    vfs.writeFileSync('/package.json', JSON.stringify({
      name: 'vite-hmr-bridge-test',
      version: '1.0.0',
      type: 'module',
    }));

    await npm.install(`vite@${VITE_VERSION}`, {});
    expect(vfs.existsSync('/node_modules/vite/package.json')).toBe(true);
  }, 120000);

  it('redirects vite bundled ws to the shim at module load', () => {
    const code = redirectViteBundledWsToShim(ANCHOR, 'test');
    expect(code).toBe(
      'const WebSocketServerRaw = process.versions.bun ? import.meta.require("ws").WebSocketServer : require("ws").Server;'
    );

    // Idempotent: already-redirected code is left untouched.
    const again = redirectViteBundledWsToShim(code, 'test');
    expect(again).toBe(code);

    // Failure-safe: unrelated code is returned unchanged.
    const unrelated = 'const x = 1;';
    expect(redirectViteBundledWsToShim(unrelated, 'test')).toBe(unrelated);
  });

  it('acks a BroadcastChannel HMR client from a running createServer', async () => {
    vfs.writeFileSync('/index.html', `<html><body>hi</body></html>`);

    vfs.writeFileSync('/test-server.js', `
      const vite = require('vite');
      module.exports = vite.createServer({
        root: '/',
        server: { middlewareMode: true },
        logLevel: 'silent',
        appType: 'custom',
        esbuild: false,
      });
    `);

    const server = (await runtime.runFile('/test-server.js').exports) as any;
    expect(server).toBeTruthy();

    const channel = new BroadcastChannel('vite-hmr-bridge');
    try {
      const waitAck = (clientId: string, timeoutMs = 5000): Promise<any> =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`no bridge ack for ${clientId}`)), timeoutMs);
          const handler = (event: MessageEvent) => {
            const data = event.data;
            if (data && data.targetClient === clientId) {
              clearTimeout(timer);
              channel.removeEventListener('message', handler);
              resolve(data);
            }
          };
          channel.addEventListener('message', handler);
        });

      const hmrAck = waitAck('bridge-test-hmr');
      channel.postMessage({
        type: 'connect',
        clientId: 'bridge-test-hmr',
        url: 'ws://localhost:3000/?token=x',
        protocol: 'vite-hmr',
      });
      const hmrReply = await hmrAck;
      expect(hmrReply.type).toBe('connected');

      const pingAck = waitAck('bridge-test-ping');
      channel.postMessage({
        type: 'connect',
        clientId: 'bridge-test-ping',
        url: 'ws://localhost:3000/',
        protocol: 'vite-ping',
      });
      const pingReply = await pingAck;
      expect(pingReply.type).toBe('connected');
    } finally {
      channel.close();
      await server.close();
    }
  }, 60000);

  it('forwards VFS file changes into vite HMR and delivers updates over the bridge', async () => {
    // Use an isolated root so this server's recursive watcher on `/app` can't
    // collide with the shared-root server in the ack test above. The module is
    // made self-accepting (like a Vue SFC) so vite emits an `update` payload
    // instead of a `full-reload` for a boundary-less plain JS module.
    vfs.mkdirSync('/app/src', { recursive: true });
    vfs.writeFileSync('/app/index.html', `<html><body><script type="module" src="/src/main.js"></script></body></html>`);
    vfs.writeFileSync('/app/src/main.js', `document.body.textContent = 'v1';\nimport.meta.hot?.accept();`);

    vfs.writeFileSync('/test-hmr-server.js', `
      const vite = require('vite');
      module.exports = vite.createServer({
        root: '/app',
        server: { middlewareMode: true },
        logLevel: 'silent',
        appType: 'custom',
        esbuild: false,
      });
    `);

    const server = (await runtime.runFile('/test-hmr-server.js').exports) as any;
    expect(server).toBeTruthy();

    // Populate vite's module graph for /app/src/main.js so a change triggers HMR.
    const transformed = await server.transformRequest('/src/main.js');
    expect(transformed).toBeTruthy();
    expect(server.moduleGraph.getModulesByFile('/app/src/main.js')?.size ?? 0).toBeGreaterThan(0);

    const channel = new BroadcastChannel('vite-hmr-bridge');
    try {
      const clientId = 'bridge-test-update';
      const waitFor = (predicate: (data: any) => boolean, timeoutMs = 8000): Promise<any> =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('timed out waiting for HMR update')), timeoutMs);
          const handler = (event: MessageEvent) => {
            const data = event.data;
            if (data && data.targetClient === clientId && predicate(data)) {
              clearTimeout(timer);
              channel.removeEventListener('message', handler);
              resolve(data);
            }
          };
          channel.addEventListener('message', handler);
        });

      // Connect a bridged HMR client.
      const ack = waitFor((d) => d.type === 'connected');
      channel.postMessage({
        type: 'connect',
        clientId,
        url: 'ws://localhost:3000/?token=y',
        protocol: 'vite-hmr',
      });
      await ack;

      // Watch for a vite HMR update payload for the module on the bridge.
      const update = waitFor((d) => d.type === 'message' && String(d.payload).includes('"type":"update"'));
      vfs.writeFileSync('/app/src/main.js', `document.body.textContent = 'v2';\nimport.meta.hot?.accept();`);
      const reply = await update;
      expect(String(reply.payload)).toContain('/src/main.js');
    } finally {
      channel.close();
      await server.close();
    }
  }, 60000);
});
