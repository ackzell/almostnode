/**
 * Opt-in flag for generic `[runtime]` / `[transform]` / `[process]` / shim
 * debug logs.
 *
 * The runtime, transformer, process shim, and several other shims print
 * per-call debug traces (esbuild init, rollup interception, `cwd()` calls,
 * chokidar events, `_generated` fs access, etc.). They're noisy, so every
 * one of them is gated behind this flag and disabled by default.
 *
 * Enable with either:
 *
 *   - `process.env.ALMOSTNODE_DEBUG=1` set in the container's env, or
 *   - `globalThis.__ALMOSTNODE_DEBUG__ = true` before the runtime loads
 *     (the injected browser shim checks `window.__ALMOSTNODE_DEBUG__`).
 */
export function debugEnabled(): boolean {
  try {
    const g = globalThis as { __ALMOSTNODE_DEBUG__?: unknown };
    if (g.__ALMOSTNODE_DEBUG__) return true;
  } catch {
    // Ignore — the flag must never break the load path.
  }
  try {
    if (typeof process !== 'undefined' && process.env?.ALMOSTNODE_DEBUG === '1') return true;
  } catch {
    // Ignore.
  }
  return false;
}

/**
 * Library "loaded — version" banner. Printed by default, but can be silenced
 * via the same opt-out in either form:
 *
 *   - `process.env.ALMOSTNODE_NO_VERSION=1` set in the container's env, or
 *   - `globalThis.__ALMOSTNODE_NO_VERSION__ = true` before the runtime loads.
 */
export function versionBannerEnabled(): boolean {
  try {
    const g = globalThis as { __ALMOSTNODE_NO_VERSION__?: unknown };
    if (g.__ALMOSTNODE_NO_VERSION__) return false;
  } catch {
    // Ignore.
  }
  try {
    if (typeof process !== 'undefined' && process.env?.ALMOSTNODE_NO_VERSION === '1') return false;
  } catch {
    // Ignore.
  }
  return true;
}
