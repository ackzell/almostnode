/**
 * Opt-in flag for `[almostnode-hmr]` diagnostics.
 *
 * The HMR bridge surfaces what's happening across the browser shim, the
 * BroadcastChannel relay, and the container's `ws` server via `[almostnode-hmr]`
 * console logs. They're noisy, so every one of them (including pre-existing
 * boot logs like `bridge connect` and `wrapped vite.createServer`) is gated
 * behind this flag and disabled by default.
 *
 * Enable with either:
 *
 *   - `process.env.ALMOSTNODE_HMR_DIAG=1` set in the container's env, or
 *   - `globalThis.__ALMOSTNODE_HMR_DIAG__ = true` before the runtime loads
 *     (the injected browser shim checks `window.__ALMOSTNODE_HMR_DIAG__`).
 */
export function hmrDiagEnabled(): boolean {
  try {
    const g = globalThis as { __ALMOSTNODE_HMR_DIAG__?: unknown };
    if (g.__ALMOSTNODE_HMR_DIAG__) return true;
  } catch {
    // Ignore — the flag must never break the load path.
  }
  try {
    if (typeof process !== 'undefined' && process.env?.ALMOSTNODE_HMR_DIAG === '1') return true;
  } catch {
    // Ignore.
  }
  return false;
}