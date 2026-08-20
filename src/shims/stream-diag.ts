/**
 * Opt-in flag for `[almostnode-stream]` diagnostics.
 *
 * The console→`process.output` streaming path (Runtime console wrapper →
 * node-command forwarding → `spawnProcess` enqueue) surfaces one line per
 * event so the whole chain can be audited against a consumer's terminal
 * logs. It's noisy, so everything is gated behind this flag and disabled
 * by default.
 *
 * Enable with either:
 *
 *   - `process.env.ALMOSTNODE_STREAM_DIAG=1` set in the container's env, or
 *   - `globalThis.__ALMOSTNODE_STREAM_DIAG__ = true` before the runtime loads
 *     (the branch-local `process.env` comes from the spawn env, so passing
 *     `env: { ALMOSTNODE_STREAM_DIAG: '1' }` to `wc.spawn()` also works).
 */
export function streamDiagEnabled(): boolean {
  try {
    const g = globalThis as { __ALMOSTNODE_STREAM_DIAG__?: unknown };
    if (g.__ALMOSTNODE_STREAM_DIAG__) return true;
  } catch {
    // Ignore — the flag must never break the load path.
  }
  try {
    if (typeof process !== 'undefined' && process.env?.ALMOSTNODE_STREAM_DIAG === '1') return true;
  } catch {
    // Ignore.
  }
  return false;
}

let _eventSeq = 0;

// Capture the native console at module scope. Never dispatch diagnostics
// through the live `globalThis.console` — the Global-console capture (Layer C)
// wraps it while a node command runs, and routing through it would make
// streamDiag recursively log itself.
const _nativeConsole = (globalThis as { console?: { log: (...a: unknown[]) => void } }).console;
const _nativeLog = _nativeConsole?.log?.bind(_nativeConsole) ?? ((..._a: unknown[]) => {});

/**
 * Emit a `[almostnode-stream]` diagnostic line. Prefixes with a global
 * monotonic counter so events can be interleaved against the consumer's
 * terminal reader logs.
 */
export function streamDiag(tag: string, ...rest: unknown[]): void {
  try {
    const labels = rest.map((r) => {
      if (typeof r === 'string') return r;
      if (typeof r === 'number' || typeof r === 'boolean') return String(r);
      try {
        return JSON.stringify(r);
      } catch {
        return String(r);
      }
    });
    _nativeLog(`[almostnode-stream] ${++_eventSeq} ${tag}${labels.length ? ' | ' + labels.join(' | ') : ''}`);
  } catch {
    // Diagnostics must never break the streaming path.
  }
}

/**
 * Short, safe preview of a chunk for diagnostics (no unprintable/escape
 * sequences, capped so huge chunks don't flood the console).
 */
export function previewChunk(data: string, max = 24): string {
  const cleaned = data.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '<ESC>');
  const out = cleaned.replace(/\r?\n/g, '\\n').replace(/[^\x20-\x7E]/g, '.');
  return out.length > max ? out.slice(0, max) + '…' : out;
}