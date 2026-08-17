import { defineConfig } from 'vite';
import { resolve } from 'path';
import { readFileSync } from 'fs';
import { execSync } from 'child_process';
import wasm from 'vite-plugin-wasm';

const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8'));
let git = '';
try { git = execSync('git rev-parse --short HEAD').toString().trim(); } catch {}
try { if (execSync('git status --porcelain').toString().trim()) git += '-dirty'; } catch {}
const version = `${pkg.version}+${git}@${new Date().toISOString()}`;

export default defineConfig({
  plugins: [
    wasm(),
    {
      name: 'browser-shims',
      enforce: 'pre',
      resolveId(source) {
        if (source === 'node:zlib' || source === 'zlib') {
          return resolve(__dirname, 'src/shims/zlib.ts');
        }
        if (source === 'brotli-wasm/pkg.web/brotli_wasm.js') {
          return resolve(__dirname, 'node_modules/brotli-wasm/pkg.web/brotli_wasm.js');
        }
        if (source === 'brotli-wasm/pkg.web/brotli_wasm_bg.wasm?url') {
          return {
            id: resolve(__dirname, 'node_modules/brotli-wasm/pkg.web/brotli_wasm_bg.wasm') + '?url',
            external: false,
          };
        }
        return null;
      },
    },
  ],
  define: {
    '__ALMOSTNODE_VERSION__': JSON.stringify(version),
    'process.env': {},
    global: 'globalThis',
  },
  resolve: {
    alias: {
      'node:zlib': resolve(__dirname, 'src/shims/zlib.ts'),
      'zlib': resolve(__dirname, 'src/shims/zlib.ts'),
      'buffer': 'buffer',
      'process': 'process/browser',
    },
  },
  worker: {
    format: 'es',
    plugins: () => [
      wasm(),
    ],
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
  build: {
    lib: {
      entry: {
        index: resolve(__dirname, 'src/index.ts'),
        'vite-plugin': resolve(__dirname, 'src/vite-plugin.ts'),
        'next-plugin': resolve(__dirname, 'src/next-plugin.ts'),
        'webcontainer-api': resolve(__dirname, 'src/webcontainer-api.ts'),
      },
      name: 'JustNode',
      formats: ['es', 'cjs'],
      fileName: (format, entryName) => `${entryName}.${format === 'es' ? 'mjs' : 'cjs'}`,
    },
    rollupOptions: {
      external: [
        'brotli-wasm',
        'pako',
        'comlink',
        'just-bash',
        'resolve.exports',
        'brotli',
        // Node.js built-ins for vite-plugin
        'fs',
        'path',
        'url',
        'vite',
      ],
      output: {
        globals: {
          'brotli-wasm': 'brotliWasm',
          'pako': 'pako',
          'comlink': 'Comlink',
          'just-bash': 'justBash',
          'resolve.exports': 'resolveExports',
        },
      },
    },
    sourcemap: true,
    minify: false,
  },
  assetsInclude: ['**/*.wasm'],
});
