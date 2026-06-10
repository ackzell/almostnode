import { describe, it, expect, beforeAll } from 'vitest';
import { VirtualFS } from '../src/virtual-fs';
import { Runtime } from '../src/runtime';
import { PackageManager } from '../src/npm';
import { RealViteServer } from '../src/frameworks/real-vite-server';

const VITE_VERSION = '8';

describe('Real Vite loading', () => {
  let vfs: VirtualFS;
  let runtime: Runtime;
  let npm: PackageManager;

  beforeAll(async () => {
    vfs = new VirtualFS();
    runtime = new Runtime(vfs, {
      cwd: '/',
      env: { NODE_ENV: 'development' },
      onStdout: (data) => process.stdout.write('[vite:out] ' + data),
      onStderr: (data) => process.stderr.write('[vite:err] ' + data),
    });
    npm = new PackageManager(vfs, { cwd: '/' });

    vfs.writeFileSync('/package.json', JSON.stringify({
      name: 'vite-load-test',
      version: '1.0.0',
      type: 'module',
    }));
  });

  it('should resolve vite@8 from npm registry', async () => {
    const { Registry } = await import('../src/npm/registry');
    const registry = new Registry();
    const manifest = await registry.getPackageManifest('vite');
    const latest = manifest['dist-tags'].latest;
    console.log(`Vite latest version: ${latest}`);
    expect(latest).toBeTruthy();
    expect(latest.startsWith('8.')).toBe(true);
  }, 30000);

  it('should install vite@latest (8.x)', async () => {
    const result = await npm.install(`vite@${VITE_VERSION}`, {
      onProgress: (msg: string) => console.log('  ' + msg),
    });
    console.log(`Installed ${result.added.length} packages`);
    expect(result.installed.has('vite')).toBe(true);

    const vitePkgPath = '/node_modules/vite/package.json';
    expect(vfs.existsSync(vitePkgPath)).toBe(true);
    const pkgJson = JSON.parse(vfs.readFileSync(vitePkgPath, 'utf8'));
    console.log(`Vite version: ${pkgJson.version}`);
    console.log(`Vite main export:`, JSON.stringify(pkgJson.exports?.['.'], null, 2));
  }, 120000);

  it('should require("vite") successfully', async () => {
    const code = `
      try {
        const vite = require('vite');
        const keys = Object.keys(vite).sort();
        console.log('Vite exports:', keys.join(', '));
        module.exports = {
          loaded: true,
          keys,
          hasCreateServer: typeof vite.createServer === 'function',
          hasDefineConfig: typeof vite.defineConfig === 'function',
          hasBuild: typeof vite.build === 'function',
          rolldownVersion: vite.rolldownVersion,
          error: null,
        };
      } catch (e) {
        console.error('Failed to require vite:', e.message);
        console.error(e.stack);
        module.exports = {
          loaded: false,
          keys: [],
          error: e.message,
          stack: e.stack,
        };
      }
    `;

    vfs.writeFileSync('/test-vite-load.js', code);
    const { exports } = runtime.runFile('/test-vite-load.js');
    const result = exports as any;

    if (result.error) {
      console.error('Require failed:', result.error);
    }

    expect(result.loaded).toBe(true);
    expect(result.keys).toContain('createServer');
    expect(result.keys).toContain('defineConfig');
  }, 60000);

  it('should create a Vite dev server with config (no actual HTTP)', async () => {
    // Set up a minimal project
    vfs.writeFileSync('/index.html', `<html><body><div id="root"></div></body></html>`);

    const code = `
      const path = require('path');
      const vite = require('vite');
      
      async function main() {
        try {
          const server = await vite.createServer({
            root: '/',
            server: { middlewareMode: true },
            logLevel: 'silent',
            appType: 'custom',
          });
          const hasMiddleware = typeof server.middlewares === 'function';
          const hasConfig = !!server.config;
          const ssrLoadModule = typeof server.ssrLoadModule === 'function';
          const transformRequest = typeof server.transformRequest === 'function';
          
          // Clean up
          await server.close();
          
          return {
            success: true,
            hasMiddleware,
            hasConfig,
            ssrLoadModule,
            transformRequest,
            configKeys: server.config ? Object.keys(server.config).slice(0, 20) : [],
            error: null,
          };
        } catch (e) {
          return {
            success: false,
            error: e.message,
            stack: e.stack,
          };
        }
      }
      
      module.exports = main();
    `;

    vfs.writeFileSync('/test-create-server.js', code);
    const { exports: promise } = runtime.runFile('/test-create-server.js');
    const result = await promise;
    console.log('createServer result:', JSON.stringify(result, null, 2));

    expect(result.success).toBe(true);
    expect(result.hasConfig).toBe(true);
  }, 60000);

  it('should serve files through RealViteServer via SW bridge', async () => {
    vfs.writeFileSync('/index.html', `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Real Vite</title></head>
<body>
  <div id="root"></div>
  <script type="module" src="/src/app.js"></script>
</body>
</html>`);

    vfs.mkdirSync('/src', { recursive: true });
    vfs.writeFileSync('/src/app.js', `
      const el = document.createElement('h1');
      el.textContent = 'Hello from Vite 8!';
      document.getElementById('root').appendChild(el);
    `);

    // Get vite and http modules from the Runtime
    vfs.writeFileSync('/get-vite.js', 'module.exports = require("vite");');
    vfs.writeFileSync('/get-http.js', 'module.exports = require("http");');
    const viteModule = runtime.runFile('/get-vite.js').exports;
    const httpModule = runtime.runFile('/get-http.js').exports;

    const server = new RealViteServer(
      () => viteModule,
      () => httpModule,
      { root: '/', port: 3001 },
    );

    await server.start();
    try {
      const serverInfo = (httpModule as any).getServer(3001);
      expect(serverInfo).toBeTruthy();
      expect(serverInfo.listening).toBe(true);

      const response = await serverInfo.handleRequest(
        'GET',
        '/index.html',
        { 'accept': 'text/html' },
      );

      const bodyStr = response.body instanceof Buffer
        ? response.body.toString('utf8')
        : new TextDecoder().decode(response.body);

      expect(response.statusCode).toBe(200);
      expect(bodyStr).toContain('<!DOCTYPE html>');
      expect(bodyStr).toContain('<script type="module" src="/@vite/client"></script>');
      expect(bodyStr).toContain('/src/app.js');

      // Also test serving the JS file through Vite
      const jsResponse = await serverInfo.handleRequest(
        'GET',
        '/src/app.js',
        { 'accept': 'application/javascript' },
      );
      const jsBody = jsResponse.body instanceof Buffer
        ? jsResponse.body.toString('utf8')
        : new TextDecoder().decode(jsResponse.body);
      expect(jsResponse.statusCode).toBe(200);
      expect(jsBody).toContain('Hello from Vite 8!');
    } finally {
      await server.close();
    }
  }, 30000);
});
