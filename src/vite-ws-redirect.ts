/**
 * Redirect vite's bundled `ws` WebSocketServer to the almostnode ws shim.
 *
 * vite bundles `ws` directly into its node dist chunks (`dist/node/chunks/*.js`)
 * via rolldown's `__commonJSMin` inline-CJS helper, and `src/node/server/ws.ts`
 * instantiates the HMR server with that bundled class:
 *
 *   const WebSocketServerRaw = process.versions.bun
 *     ? import.meta.require("ws").WebSocketServer
 *     : import_websocket_server.default;
 *   const wss = new WebSocketServerRaw({ noServer: true });
 *
 * The HMR bridge (`src/shims/ws.ts` `_setupHmrBridge` + the browser
 * `window.WebSocket` shim in `src/shims/vite-hmr-bridge-client.ts`) only works
 * if the HMR WebSocketServer is the shim's, which listens on the
 * `vite-hmr-bridge` BroadcastChannel. Service workers can't proxy raw
 * WebSockets, so the browser client must tunnel over BroadcastChannel — which
 * it can only reach if the container's WSS is ours. The bundled ws has no BC
 * wiring, so a browser connect would never be acked (`[vite] failed to connect
 * to websocket.`).
 *
 * This module rewrites the `WebSocketServerRaw` line at module-load time (see
 * `src/runtime.ts`) so every vite-created HMR server uses the shim class.
 * Guarded by anchor presence, idempotent (already-redirected code is left
 * alone), and failure-safe (never breaks vite loading).
 */

import { hmrDiagEnabled } from './shims/hmr-diag';

export function redirectViteBundledWsToShim(code: string, sourcePath?: string): string {
  try {
    // Anchor identifies vite's src/node/server/ws.ts seam. Match subprotocol
    // keyed by the canonical `ws` external; tolerate minified $n suffixes.
    const anchor = /WebSocketServerRaw\s*=\s*process\.versions\.bun/;
    if (!anchor.test(code)) return code;

    if (/import_websocket_server(\$\d+)?\.default/.test(code)) {
      debug('redirecting vite bundled ws to shim in', sourcePath || 'vite chunk');
      return code.replace(/\bimport_websocket_server(\$\d+)?\.default\b/g, 'require("ws").Server');
    }
  } catch (error) {
    debug('ws redirect failed:', error instanceof Error ? error.message : String(error));
  }
  return code;
}

function debug(...args: unknown[]): void {
  if (!hmrDiagEnabled()) return;
  try {
    console.log('[almostnode-hmr]', ...args);
  } catch {
    // Logging must never break the load path.
  }
}