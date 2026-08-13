import { VirtualFS } from './virtual-fs';
import { Runtime } from './runtime';
import { PackageManager } from './npm';
import { RealViteServer } from './frameworks/real-vite-server';
import { getServerBridge } from './server-bridge';

function createProjectFiles(vfs: VirtualFS): void {
  vfs.writeFileSync('/package.json', JSON.stringify({
    name: 'real-vite-demo',
    version: '1.0.0',
    type: 'module',
  }, null, 2));

  vfs.writeFileSync('/index.html', `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Real Vite 8 Demo</title>
  <link rel="stylesheet" href="/src/style.css">
</head>
<body>
  <div id="root">
    <h1>Real Vite 8</h1>
    <p class="subtitle">Running inside the browser via almostnode</p>
    <div class="card">
      <p>Count: <span id="count">0</span></p>
      <button id="inc-btn">+1</button>
    </div>
  </div>
  <script type="module" src="/src/app.ts"></script>
</body>
</html>`);

  vfs.mkdirSync('/src', { recursive: true });

  vfs.writeFileSync('/src/app.ts', `
import { debounce } from 'lodash-es';

const countEl = document.getElementById('count') as HTMLElement;
const btn = document.getElementById('inc-btn') as HTMLElement;
let count = 0;

const updateCount = (): void => {
  count++;
  countEl.textContent = String(count);
};

const debouncedUpdate = debounce(updateCount, 200);
btn.addEventListener('click', debouncedUpdate);

console.log('Real Vite 8 app loaded with TypeScript and lodash!');
`);

  vfs.writeFileSync('/src/style.css', `
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: system-ui, sans-serif; background: #0d1117; color: #e6edf3; display: flex; justify-content: center; align-items: center; min-height: 100vh; }
#root { text-align: center; }
h1 { font-size: 2.5rem; background: linear-gradient(135deg, #646cff, #40c9ff); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
.subtitle { color: #8b949e; margin: 0.5rem 0 2rem; }
.card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 2rem; display: inline-block; }
.card p { font-size: 1.2rem; margin-bottom: 1rem; }
.card span { font-weight: bold; color: #58a6ff; }
button { background: #238636; color: #fff; border: none; padding: 0.5rem 2rem; border-radius: 6px; font-size: 1rem; cursor: pointer; }
button:hover { background: #2ea043; }
`);
}

export async function initRealViteDemo(
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

  log('Setting up project files...');
  createProjectFiles(vfs);

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

export async function installRealVite(
  npm: PackageManager,
  log: (msg: string) => void,
): Promise<void> {
  log('Installing vite@7...');
  const result = await npm.install('vite@7', {
    onProgress: (msg) => {
      if (msg.startsWith('  Resolving') || msg.startsWith('  Installing') || msg.startsWith('    Downloading')) return;
      log(msg);
    },
  });
  log(`Installed ${result.added.length} packages`);
  log('Vite 7 ready!');

  log('Installing lodash-es...');
  const lodashResult = await npm.install('lodash-es', {
    onProgress: (msg) => {
      if (msg.startsWith('  Resolving') || msg.startsWith('  Installing') || msg.startsWith('    Downloading')) return;
      log(msg);
    },
  });
  log(`Installed ${lodashResult.added.length} packages`);
  log('lodash-es ready!');
}

export async function startRealViteServer(
  vfs: VirtualFS,
  runtime: Runtime,
  npm: PackageManager,
  log: (msg: string) => void,
): Promise<{ server: RealViteServer; url: string }> {
  log('Loading modules from runtime...');
  vfs.writeFileSync('/__load-vite.js', 'module.exports = require("vite");');
  vfs.writeFileSync('/__load-http.js', 'module.exports = require("http");');
  const viteModule = runtime.runFile('/__load-vite.js').exports;
  const httpModule = runtime.runFile('/__load-http.js').exports;

  // Create a Vite plugin that handles .ts/.tsx files via esbuild
  vfs.writeFileSync('/__ts-plugin.js', `
    const esbuild = require('esbuild');
    module.exports = {
      name: 'ts-transform',
      async transform(code, id) {
        if (id.endsWith('.ts') || id.endsWith('.tsx') || id.endsWith('.mts')) {
          const result = await esbuild.transform(code, {
            loader: id.endsWith('.tsx') ? 'tsx' : 'ts',
            sourcemap: true,
          });
          return { code: result.code, map: result.map };
        }
        return null;
      },
    };
  `);
  const tsPlugin = runtime.runFile('/__ts-plugin.js').exports;

  const port = 3000;
  log('Creating RealViteServer...');
  const server = new RealViteServer(
    () => viteModule,
    () => httpModule,
    { root: '/', port, vfs, plugins: [tsPlugin] },
  );

  log('Starting Vite dev server...');
  await server.start();

  // Register with the Service Worker bridge for browser routing
  const bridge = getServerBridge();
  try {
    await bridge.initServiceWorker();
    log('Service Worker ready');
  } catch {
    log('Service Worker unavailable, using fallback');
  }
  const httpServer = server.getHttpServer();
  bridge.registerServer(httpServer, port);
  log(`Server running at /__virtual__/${port}/`);

  return { server, url: `/__virtual__/${port}/` };
}
