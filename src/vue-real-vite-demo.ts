/**
 * Vue 3 + Real Vite 7 demo.
 * Runs real vite via @vitejs/plugin-vue inside the browser through RealViteServer.
 */
import { VirtualFS } from './virtual-fs';
import { Runtime } from './runtime';
import { PackageManager } from './npm';
import { RealViteServer } from './frameworks/real-vite-server';
import { getServerBridge } from './server-bridge';

export function createVueProjectFiles(vfs: VirtualFS): void {
  vfs.writeFileSync('/package.json', JSON.stringify({
    name: 'vue-real-vite-demo',
    version: '1.0.0',
    type: 'module',
    dependencies: { vue: '3.5.35' },
    devDependencies: { vite: '^7.0.0', '@vitejs/plugin-vue': '^6.0.0' },
  }, null, 2));

  vfs.writeFileSync('/index.html', `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Vue 3 + Real Vite</title>
</head>
<body>
  <div id="app"></div>
  <script type="module" src="/src/main.js"></script>
</body>
</html>`);

  vfs.mkdirSync('/src', { recursive: true });

  vfs.writeFileSync('/src/main.js', `
import { createApp } from 'vue'
import App from './App.vue'
createApp(App).mount('#app')
`);

  vfs.writeFileSync('/src/App.vue', `
<script setup>
import { ref } from 'vue'

const count = ref(0)
const items = ref(['Vue 3', 'Real Vite 7', '@vitejs/plugin-vue'])
</script>

<template>
  <div class="card">
    <h1>Vue 3 + Real Vite in the browser</h1>
    <p class="subtitle">Served by the actual <code>vite</code> package via almostnode</p>
    <button @click="count++">Count: {{ count }}</button>
    <ul>
      <li v-for="item in items" :key="item">{{ item }}</li>
    </ul>
  </div>
</template>

<style scoped>
.card {
  font-family: system-ui, sans-serif;
  max-width: 480px;
  margin: 40px auto;
  padding: 24px;
  border-radius: 10px;
  background: #161b22;
  border: 1px solid #30363d;
  color: #e6edf3;
  text-align: center;
}
h1 { font-size: 1.4rem; margin: 0 0 8px; }
.subtitle { color: #8b949e; font-size: 0.9rem; margin: 0 0 16px; }
button {
  background: #42b983;
  color: #fff;
  border: none;
  padding: 10px 18px;
  border-radius: 6px;
  font-size: 1rem;
  cursor: pointer;
}
ul { list-style: none; padding: 0; margin-top: 16px; }
li { padding: 6px 0; color: #58a6ff; }
</style>
`);
}

export async function initVueRealViteDemo(
  outputEl: HTMLElement,
): Promise<{ vfs: VirtualFS; runtime: Runtime; npm: PackageManager }> {
  const log = (msg: string) => {
    const line = document.createElement('div');
    line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    outputEl.appendChild(line);
    outputEl.scrollTop = outputEl.scrollHeight;
  };

  log('Creating virtual filesystem...');
  const vfs = new VirtualFS();

  log('Setting up Vue project files...');
  createVueProjectFiles(vfs);

  log('Initializing runtime...');
  const runtime = new Runtime(vfs, {
    cwd: '/',
    env: { NODE_ENV: 'development' },
    onConsole: (method, args) => {
      log(`[${method}] ${args.map(a => String(a)).join(' ')}`);
    },
  });

  const npm = new PackageManager(vfs, { cwd: '/' });

  return { vfs, runtime, npm };
}

export async function installVueDeps(
  npm: PackageManager,
  log: (msg: string) => void,
): Promise<void> {
  log('Installing vue@3.5.35, vite@7, @vitejs/plugin-vue...');
  const result = await npm.installFromPackageJson({
    includeDev: true,
    onProgress: (msg) => {
      if (msg.startsWith('  Resolving') || msg.startsWith('  Installing') || msg.startsWith('    Downloading')) return;
      log(msg);
    },
  });
  log(`Installed ${result.added.length} packages`);
  log('Vue + Vite ready!');
}

export async function startVueRealViteServer(
  vfs: VirtualFS,
  runtime: Runtime,
  npm: PackageManager,
  log: (msg: string) => void,
): Promise<{ server: RealViteServer; url: string }> {
  log('Loading modules from runtime...');
  vfs.writeFileSync('/load-vite.js', 'module.exports = require("vite");');
  vfs.writeFileSync('/load-http.js', 'module.exports = require("http");');
  vfs.writeFileSync('/load-plugin.js', 'module.exports = require("@vitejs/plugin-vue");');

  const viteModule = runtime.runFile('/load-vite.js').exports as any;
  const httpModule = runtime.runFile('/load-http.js').exports as any;
  const pluginMod = runtime.runFile('/load-plugin.js').exports as any;
  const vuePlugin = (pluginMod.default || pluginMod)();

  const port = 3100;
  log('Creating RealViteServer with @vitejs/plugin-vue...');
  const server = new RealViteServer(
    () => viteModule,
    () => httpModule,
    // Vite's esbuild (our browser shim) converts install-time CJS-transformed
    // node_modules (e.g. vue) back to ESM so the browser gets real named exports.
    { root: '/', port, vfs, plugins: [vuePlugin] },
  );

  log('Starting Vite dev server...');
  await server.start();

  const bridge = getServerBridge();
  try {
    await bridge.initServiceWorker();
    log('Service Worker ready');
  } catch {
    log('Service Worker unavailable, using fallback');
  }
  bridge.registerServer(server.getHttpServer(), port);
  log(`Server running at /__virtual__/${port}/`);

  return { server, url: `/__virtual__/${port}/` };
}
