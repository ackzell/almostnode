/**
 * Real Vite 7 serving `.vue` via @vitejs/plugin-vue through RealViteServer.
 * Replicates the stack used by the amoxtli-vue-2 `vue` template:
 *   vite@^7 + @vitejs/plugin-vue@^6 + vue@3.5.35 + script setup + scoped styles.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { VirtualFS } from '../src/virtual-fs';
import { Runtime } from '../src/runtime';
import { PackageManager } from '../src/npm';
import { RealViteServer } from '../src/frameworks/real-vite-server';
import { Buffer } from '../src/shims/stream';

describe('Real Vite serving .vue', () => {
  let vfs: VirtualFS;
  let runtime: Runtime;
  let npm: PackageManager;
  let captured: string[];

  beforeAll(async () => {
    captured = [];
    vfs = new VirtualFS();
    runtime = new Runtime(vfs, {
      cwd: '/',
      env: { NODE_ENV: 'development' },
      onStdout: (data) => {
        process.stdout.write('[vue:out] ' + data);
        captured.push(String(data));
      },
      onStderr: (data) => {
        process.stderr.write('[vue:err] ' + data);
        captured.push(String(data));
      },
      onConsole: (method, args) => {
        captured.push(method + ': ' + args.map(String).join(' '));
      },
    });
    npm = new PackageManager(vfs, { cwd: '/' });

    vfs.writeFileSync('/package.json', JSON.stringify({
      name: 'vue-real-vite-test',
      version: '1.0.0',
      type: 'module',
      dependencies: { vue: '3.5.35' },
      devDependencies: { vite: '^7.0.0', '@vitejs/plugin-vue': '^6.0.0', sass: '^1.77.0' },
    }));

    const result = await npm.installFromPackageJson({
      includeDev: true,
      onProgress: (msg: string) => console.log('  ' + msg),
    });
    console.log(`Installed ${result.added.length} packages`);

    // Project files (mirrors templates/vue/)
    vfs.writeFileSync('/index.html', `<!DOCTYPE html>
<html lang="en">
  <head><meta charset="UTF-8" /><title>Vue Tutorial</title></head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>`);

    vfs.mkdirSync('/src', { recursive: true });
    vfs.writeFileSync('/src/main.ts', `
import { createApp } from 'vue'
import App from './App.vue'
createApp(App).mount('#app')
`);

    vfs.writeFileSync('/src/App.vue', `
<script setup>
import { ref } from 'vue'
const count = ref(0)
</script>

<template>
  <div class="wrap">
    <h1>Vue 3 Playground</h1>
    <button @click="count++">Count: {{ count }}</button>
  </div>
</template>

<style scoped>
button { background: #42b983; }
</style>
`);
  }, 180000);

  it('require("@vitejs/plugin-vue") loads through the runtime', async () => {
    vfs.writeFileSync('/load-plugin.js', 'module.exports = require("@vitejs/plugin-vue");');
    const mod = runtime.runFile('/load-plugin.js').exports as any;
    const factory = mod.default || mod;
    expect(typeof factory).toBe('function');
    const plugin = factory();
    expect(plugin.name).toBe('vite:vue');
  }, 30000);

  it('transformRequest compiles a .vue SFC through the plugin', async () => {
    vfs.writeFileSync('/get-vite.js', 'module.exports = require("vite");');
    vfs.writeFileSync('/get-http.js', 'module.exports = require("http");');
    const vite = runtime.runFile('/get-vite.js').exports as any;
    const http = runtime.runFile('/get-http.js').exports as any;
    const pluginMod = runtime.runFile('/load-plugin.js').exports as any;
    const vuePlugin = (pluginMod.default || pluginMod)();

    const server = new RealViteServer(
      () => vite,
      () => http,
      { root: '/', port: 3100, vfs, plugins: [vuePlugin], esbuild: false },
    );

    await server.start();
    try {
      const serverInfo = (http as any).getServer(3100);
      expect(serverInfo).toBeTruthy();

      const resp = await serverInfo.handleRequest('GET', '/src/App.vue', { 'accept': 'application/javascript' });
      const body = resp.body instanceof Buffer
        ? resp.body.toString('utf8')
        : new TextDecoder().decode(resp.body);

      expect(resp.statusCode).toBe(200);
      // @vitejs/plugin-vue output: compiled template render fn + scoped style id
      expect(body).toContain('render');
      expect(body).toContain('data-v-');
      // Re-exports the SFC default
      expect(body).toContain('_sfc_main');
    } finally {
      await server.close();
    }
  }, 60000);

  it('serves index.html that wires the Vue entry through Vite', async () => {
    vfs.writeFileSync('/get-vite.js', 'module.exports = require("vite");');
    vfs.writeFileSync('/get-http.js', 'module.exports = require("http");');
    const vite = runtime.runFile('/get-vite.js').exports as any;
    const http = runtime.runFile('/get-http.js').exports as any;
    const pluginMod = runtime.runFile('/load-plugin.js').exports as any;
    const vuePlugin = (pluginMod.default || pluginMod)();

    const server = new RealViteServer(
      () => vite,
      () => http,
      { root: '/', port: 3101, vfs, plugins: [vuePlugin], esbuild: false },
    );

    await server.start();
    try {
      const serverInfo = (http as any).getServer(3101);
      const htmlResp = await serverInfo.handleRequest('GET', '/index.html', { 'accept': 'text/html' });
      const html = htmlResp.body instanceof Buffer
        ? htmlResp.body.toString('utf8')
        : new TextDecoder().decode(htmlResp.body);
      expect(htmlResp.statusCode).toBe(200);
      expect(html).toContain('<script type="module" src="/@vite/client"></script>');
      expect(html).toContain('/src/main.ts');
    } finally {
      await server.close();
    }
  }, 60000);

  it('compiles .scss through Vite\'s sass preprocessor', async () => {
    vfs.mkdirSync('/src', { recursive: true });
    vfs.writeFileSync('/src/style.scss', `
$primary: #42b983;
.wrap {
  color: $primary;
  .inner {
    font-size: 14px;
    &:hover { opacity: 0.8; }
  }
}
`);

    vfs.writeFileSync('/get-vite.js', 'module.exports = require("vite");');
    vfs.writeFileSync('/get-http.js', 'module.exports = require("http");');
    const vite = runtime.runFile('/get-vite.js').exports as any;
    const http = runtime.runFile('/get-http.js').exports as any;

    const server = new RealViteServer(
      () => vite,
      () => http,
      { root: '/', port: 3102, vfs, esbuild: false },
    );

    await server.start();
    try {
      const serverInfo = (http as any).getServer(3102);
      const resp = await serverInfo.handleRequest('GET', '/src/style.scss', { 'accept': 'text/css' });
      const css = resp.body instanceof Buffer
        ? resp.body.toString('utf8')
        : new TextDecoder().decode(resp.body);
      expect(resp.statusCode).toBe(200);
      // sass compiled: variables resolved + nesting flattened
      expect(css).toContain('#42b983');
      expect(css).toContain('.wrap .inner');
    } finally {
      await server.close();
    }
  }, 60000);

  it('loads sass via its resolved file:// path without triggering sass default-import deprecation', async () => {
    // Vite's scss worker does `await import(sassPath)` then uses the namespace.
    // The runtime's dynamic-import interop must not probe `.default` (sass's
    // warn-on-access getter would emit: "import sass from 'sass' is deprecated").
    vfs.mkdirSync('/src', { recursive: true });
    vfs.writeFileSync('/src/style.scss', '$c: red; .x { color: $c; }\n');

    vfs.writeFileSync('/get-vite.js', 'module.exports = require("vite");');
    vfs.writeFileSync('/get-http.js', 'module.exports = require("http");');
    const vite = runtime.runFile('/get-vite.js').exports as any;
    const http = runtime.runFile('/get-http.js').exports as any;

    const server = new RealViteServer(
      () => vite,
      () => http,
      { root: '/', port: 3103, vfs, esbuild: false },
    );

    await server.start();
    try {
      const serverInfo = (http as any).getServer(3103);
      const resp = await serverInfo.handleRequest('GET', '/src/style.scss', { 'accept': 'text/css' });
      const css = resp.body instanceof Buffer
        ? resp.body.toString('utf8')
        : new TextDecoder().decode(resp.body);
      expect(resp.statusCode).toBe(200);
      expect(css).toContain('red');
    } finally {
      await server.close();
    }

    expect(captured.join('\n')).not.toMatch(/import sass from 'sass'/);
  }, 60000);
});
