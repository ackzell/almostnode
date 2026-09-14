/**
 * Node.js child_process module shim
 * Uses just-bash for command execution in browser with VirtualFS adapter
 */

// Polyfill process for just-bash (it expects Node.js environment)
if (typeof globalThis.process === 'undefined') {
  (globalThis as any).process = {
    env: {
      HOME: '/home/user',
      USER: 'user',
      PATH: '/usr/local/bin:/usr/bin:/bin',
      NODE_ENV: 'development',
    },
    cwd: () => '/',
    platform: 'linux',
    version: 'v18.0.0',
    versions: { node: '18.0.0' },
    stdout: { write: () => {} },
    stderr: { write: () => {} },
  };
}

import { Bash, defineCommand } from 'just-bash';
import type { CommandContext, ExecResult as JustBashExecResult } from 'just-bash';
import { EventEmitter } from './events';
import { Readable, Writable, Buffer } from './stream';
import type { VirtualFS } from '../virtual-fs';
import { VirtualFSAdapter } from './vfs-adapter';
import { Runtime } from '../runtime';
import type { PackageJson } from '../types/package-json';
import { streamDiag, streamDiagEnabled, previewChunk } from './stream-diag';
import { isContainerSourceStack } from '../source-tag';

// Singleton bash instance - uses VFS adapter for two-way file sync
let bashInstance: Bash | null = null;
let vfsAdapter: VirtualFSAdapter | null = null;
let currentVfs: VirtualFS | null = null;

// Track active forked child processes so the node command can detect when children exit.
// When the last child exits, the node command uses a shorter idle timeout.
let _activeForkedChildren = 0;
let _onForkedChildExit: (() => void) | null = null;

// Patch Object.defineProperty globally to force configurable: true on globalThis properties.
// In real Node.js, each process has its own globalThis. In our browser environment,
// all forks share globalThis, so libraries like vitest that define non-configurable
// properties (e.g. __vitest_index__) need them to be configurable for re-runs.
const _realDefineProperty = Object.defineProperty;
Object.defineProperty = function(target: object, key: PropertyKey, descriptor: PropertyDescriptor): object {
  if (target === globalThis && descriptor && !descriptor.configurable) {
    descriptor = { ...descriptor, configurable: true };
  }
  return _realDefineProperty.call(Object, target, key, descriptor) as object;
} as typeof Object.defineProperty;

// Module-level streaming callbacks for long-running commands (e.g. vitest watch)
// Set by container.run() before calling exec, cleared after
let _streamStdout: ((data: string) => void) | null = null;
let _streamStderr: ((data: string) => void) | null = null;
let _abortSignal: AbortSignal | null = null;

/**
 * Set streaming callbacks for the next command execution.
 * Used by container.run() to enable streaming output from custom commands.
 */
export function setStreamingCallbacks(opts: {
  onStdout?: (data: string) => void;
  onStderr?: (data: string) => void;
  signal?: AbortSignal;
}): void {
  _streamStdout = opts.onStdout || null;
  _streamStderr = opts.onStderr || null;
  _abortSignal = opts.signal || null;
  if (streamDiagEnabled()) {
    streamDiag('callbacks', 'set', `stdout=${opts.onStdout ? 1 : 0}`, `stderr=${opts.onStderr ? 1 : 0}`, `signal=${opts.signal ? 1 : 0}`);
  }
}

/**
 * Clear streaming callbacks after command execution.
 */
export function clearStreamingCallbacks(): void {
  if (streamDiagEnabled()) {
    streamDiag('callbacks', 'clear', `stdoutWasSet=${_streamStdout ? 1 : 0}`, `stderrWasSet=${_streamStderr ? 1 : 0}`);
  }
  _streamStdout = null;
  _streamStderr = null;
  _abortSignal = null;
}

/**
 * Forward a chunk to the active streaming stdout callback (if any).
 * Package-manager commands call this so their progress reaches the
 * WebContainerProcess output stream (and the terminal panel).
 */
export function forwardStdout(data: string): void {
  if (streamDiagEnabled()) streamDiag('fwd-ext', 'stdout', String(data.length), `sink=${_streamStdout ? 1 : 0}`, previewChunk(data));
  if (_streamStdout) _streamStdout(data);
}

/**
 * Forward a chunk to the active streaming stderr callback (if any).
 */
export function forwardStderr(data: string): void {
  if (streamDiagEnabled()) streamDiag('fwd-ext', 'stderr', String(data.length), `sink=${_streamStderr ? 1 : 0}`, previewChunk(data));
  if (_streamStderr) _streamStderr(data);
}

// ── Global-console capture (Layer C) ──────────────────────────────────
// Temporarily wraps globalThis.console while a `node` command runs so
// output that bypasses the per-module wrapped console (i.e. code reaching
// `globalThis.console` directly — typically async callbacks running after
// the synchronous module-execution wrap window has closed) still lands in
// the process output stream, like a real Node console→stdout/stderr write.
// Calls that arrive via createConsoleWrapper set `__almostnode_in_wrap` and
// are skipped, since the wrapped-console path already forwarded that call.
//
// On the main thread the host page shares globalThis.console with the
// container, so the wrap also sees host-page calls. Forwarding is decided
// by an allowlist, not a package-name blocklist: container code evaluated
// by the runtime carries a `//# sourceURL=almostnode:<path>` tag
// (src/source-tag.ts), which survives any amount of host-bundle
// minification. A call is forwarded only when its stack contains at least
// one tagged frame; anything else is host-page noise and passes through to
// the original console untouched.
//
// Each wrap installs its own wrapper chain (capturing the previous console
// method as `orig`) and routes through `_layerStdout`/`_layerStderr`, the
// current command's append functions. This is robust to nesting (pnpm →
// node) and to a stale wrapper that outlives its command (an orphaned dev
// server after an abort): a new spawn re-wraps and re-targets cleanly, so
// async global-console output reaches the live stream instead of a dead
// command's buffer.

interface ConsoleAppend {
  (data: string, src?: string): void;
}

interface LayerTarget {
  stdout: ConsoleAppend;
  stderr: ConsoleAppend;
  methods: Map<string, (...args: unknown[]) => void>;
}

const _layerStack: LayerTarget[] = [];
let _layerStdout: ConsoleAppend = () => {};
let _layerStderr: ConsoleAppend = () => {};

function formatConsoleArgs(args: unknown[]): string {
  return args.map((a) => String(a)).join(' ') + '\n';
}

function globalConsoleOrigin(): string {
  try {
    const lines = new Error().stack?.split('\n') ?? [];
    for (let i = 1; i < Math.min(lines.length, 12); i++) {
      const line = lines[i].trim().replace(/^at\s+/, '');
      if (!line || line === 'Error' || line.includes('/stream-diag') || line.includes('shims/child_process')) {
        continue;
      }
      return line.slice(0, 160);
    }
    return '<unknown>';
  } catch {
    return '<unknown>';
  }
}

function wrapGlobalConsole(appendStdout: ConsoleAppend, appendStderr: ConsoleAppend): void {
  const g = globalThis as unknown as { console?: Record<string, unknown> };
  const target: LayerTarget = { stdout: appendStdout, stderr: appendStderr, methods: new Map() };
  _layerStack.push(target);
  _layerStdout = appendStdout;
  _layerStderr = appendStderr;
  if (!g.console) return;
  for (const name of ['log', 'warn', 'error', 'info']) {
    const current = g.console[name];
    if (typeof current !== 'function') continue;
    const currentFn = current as unknown as (...args: unknown[]) => void;
    target.methods.set(name, currentFn);
    g.console[name] = (...args: unknown[]) => {
      const gw = globalThis as { __almostnode_in_wrap?: unknown };
      if (gw.__almostnode_in_wrap) return;
      let containerOrigin = false;
      try {
        containerOrigin = isContainerSourceStack(new Error().stack);
      } catch {
        containerOrigin = false;
      }
      if (!containerOrigin) {
        // Host-page call (no tagged frame in the stack): leave it for the
        // original console chain so host devtools keep working.
        currentFn(...args);
        return;
      }
      const msg = formatConsoleArgs(args);
      if (name === 'error' || name === 'warn') {
        _layerStderr(msg, `onConsole:${name}`);
      } else {
        _layerStdout(msg, `onConsole:${name}`);
      }
      if (streamDiagEnabled()) {
        streamDiag('globalc', name, globalConsoleOrigin(), String(msg.length), previewChunk(msg));
        try {
          currentFn(...args);
        } catch {
          // Mirror only for debugging; must never break the stream path.
        }
      }
    };
  }
}

function unwrapGlobalConsole(): void {
  const target = _layerStack.pop();
  const top = _layerStack[_layerStack.length - 1];
  _layerStdout = top?.stdout ?? (() => {});
  _layerStderr = top?.stderr ?? (() => {});
  if (!target) return;
  const g = globalThis as unknown as { console?: Record<string, unknown> };
  if (g.console) {
    for (const [name, prev] of target.methods) {
      g.console[name] = prev;
    }
  }
}

// Reference to the currently running node command's process stdin.
// Used to send stdin input to long-running commands (e.g. vitest watch mode).
let _activeProcessStdin: { emit: (event: string, ...args: unknown[]) => void } | null = null;

/**
 * Send data to the stdin of the currently running node process.
 * Emits both 'data' and 'keypress' events (vitest uses readline keypress events).
 */
export function sendStdin(data: string): void {
  if (_activeProcessStdin) {
    _activeProcessStdin.emit('data', data);
    for (const ch of data) {
      _activeProcessStdin.emit('keypress', ch, {
        sequence: ch,
        name: ch,
        ctrl: false,
        meta: false,
        shift: false,
      });
    }
  }
}

/**
 * Initialize the child_process shim with a VirtualFS instance
 * Creates a single Bash instance with VirtualFSAdapter for efficient file access
 */
export function initChildProcess(vfs: VirtualFS): void {
  currentVfs = vfs;
  vfsAdapter = new VirtualFSAdapter(vfs);

  // Create custom 'node' command that runs JS files using the Runtime
  const nodeCommand = defineCommand('node', async (args, ctx) => {
    if (!currentVfs) {
      return { stdout: '', stderr: 'VFS not initialized\n', exitCode: 1 };
    }

    const scriptPath = args[0];
    if (!scriptPath) {
      return { stdout: '', stderr: 'Usage: node <script.js> [args...]\n', exitCode: 1 };
    }

    // Resolve the script path
    const resolvedPath = scriptPath.startsWith('/')
      ? scriptPath
      : `${ctx.cwd}/${scriptPath}`.replace(/\/+/g, '/');

    if (!currentVfs.existsSync(resolvedPath)) {
      return { stdout: '', stderr: `Error: Cannot find module '${resolvedPath}'\n`, exitCode: 1 };
    }

    let stdout = '';
    let stderr = '';

    // Track whether process.exit() was called
    let exitCalled = false;
    let exitCode = 0;
    let syncExecution = true;
    let exitResolve: ((code: number) => void) | null = null;
    const exitPromise = new Promise<number>((resolve) => { exitResolve = resolve; });

    // Helper to append to stdout, also streaming if configured
    const appendStdout = (data: string, src = 'onStdout') => {
      stdout += data;
      if (streamDiagEnabled()) streamDiag('fwd', src, String(data.length), `sink=${_streamStdout ? 1 : 0}`, previewChunk(data));
      if (_streamStdout) _streamStdout(data);
    };
    const appendStderr = (data: string, src = 'onStderr') => {
      stderr += data;
      if (streamDiagEnabled()) streamDiag('fwd', src, String(data.length), `sink=${_streamStderr ? 1 : 0}`, previewChunk(data));
      if (_streamStderr) _streamStderr(data);
    };

    // Capture output that bypasses the per-module console wrapper (i.e.
    // direct `globalThis.console` usage). See wrapGlobalConsole() above.
    wrapGlobalConsole(appendStdout, appendStderr);

    // Create a runtime with output capture for both console.log AND process.stdout.write
    const runtime = new Runtime(currentVfs, {
      cwd: ctx.cwd,
      env: ctx.env,
      onConsole: (method, consoleArgs) => {
        const msg = formatConsoleArgs(consoleArgs);
        if (method === 'error') {
          appendStderr(msg, `onConsole:${method}`);
        } else {
          appendStdout(msg, `onConsole:${method}`);
        }
      },
      onStdout: (data: string) => {
        appendStdout(data, 'process.stdout.write');
      },
      onStderr: (data: string) => {
        appendStderr(data, 'process.stderr.write');
      },
    });

    // Override process.exit to resolve the completion promise
    const proc = runtime.getProcess();
    proc.exit = ((code = 0) => {
      if (!exitCalled) {
        exitCalled = true;
        exitCode = code;
        proc.emit('exit', code);
        exitResolve!(code);
      }
      // In sync context, throw to stop execution (like real process.exit)
      // In async context, return silently to avoid unhandled rejections
      if (syncExecution) {
        throw new Error(`Process exited with code ${code}`);
      }
    }) as (code?: number) => never;

    // Set up process.argv for the script
    proc.argv = ['node', resolvedPath, ...args.slice(1)];

    // For long-running commands (watch mode), report as TTY so tools like
    // vitest set up interactive features (file watching, stdin commands).
    // Also track stdin so external code can send input via sendStdin().
    if (_abortSignal) {
      proc.stdout.isTTY = true;
      proc.stderr.isTTY = true;
      proc.stdin.isTTY = true;
      proc.stdin.setRawMode = () => proc.stdin;
      _activeProcessStdin = proc.stdin;
    }

    try {
      // Run the script (awaiting any top-level await in the entry point)
      await runtime.runFileAsync(resolvedPath);
    } catch (error) {
      // process.exit() throws to stop execution — this is expected
      if (error instanceof Error && error.message.startsWith('Process exited with code')) {
        unwrapGlobalConsole();
        return { stdout, stderr, exitCode };
      }
      // Real error
      const errorMsg = error instanceof Error
        ? `${error.message}\n${error.stack || ''}`
        : String(error);
      unwrapGlobalConsole();
      // Forward the failure to the streaming stderr so spawnProcess consumers
      // (and the terminal) see why the process died, instead of only the
      // buffered `stderr`. Without this, a throw in runFileAsync surfaces as a
      // bare exit code 1 with an empty output stream.
      const errText = `Error: ${errorMsg}\n`;
      if (_streamStderr) _streamStderr(errText);
      return { stdout, stderr: stderr + errText, exitCode: 1 };
    } finally {
      // After runFile returns, switch to async mode (no more throwing from process.exit)
      syncExecution = false;
    }

    // If process.exit was called synchronously (but didn't throw for some reason), return
    if (exitCalled) {
      unwrapGlobalConsole();
      return { stdout, stderr, exitCode };
    }

    // Script returned without calling process.exit().
    // Heuristic: if we already captured output, the script likely finished synchronously
    // (e.g. a simple "console.log('hello')" script). Return immediately.
    if (stdout.length > 0 || stderr.length > 0) {
      // Brief pause for any trailing microtasks
      await new Promise(r => setTimeout(r, 0));
      unwrapGlobalConsole();
      return { stdout, stderr, exitCode: exitCalled ? exitCode : 0 };
    }

    // No output yet — script likely has async work (e.g. vitest test runner).
    // Wait for process.exit() or until output stabilizes.
    // Also catch unhandled rejections from async code to surface errors.

    // Catch unhandled rejections from the script's async code. Some embedding
    // environments (minimal runtimes, test VMs) have no global event target.
    const rejectionHandler = (event: PromiseRejectionEvent) => {
      const reason = event.reason;
      // Ignore process.exit throws (they're expected)
      if (reason instanceof Error && reason.message.startsWith('Process exited with code')) {
        event.preventDefault();
        return;
      }
      const msg = reason instanceof Error
        ? `Unhandled rejection: ${reason.message}\n${reason.stack || ''}\n`
        : `Unhandled rejection: ${String(reason)}\n`;
      appendStderr(msg);
    };
    if (typeof globalThis.addEventListener === 'function') {
      globalThis.addEventListener('unhandledrejection', rejectionHandler);
    }

    // Listen for forked child exits to shorten the idle timeout.
    // Many CLI tools (vitest, jest, etc.) fork workers and exit shortly after
    // all children complete. We use a shorter timeout once children are done.
    let childrenExited = false;
    const prevChildExitHandler = _onForkedChildExit;
    _onForkedChildExit = () => {
      if (_activeForkedChildren <= 0) childrenExited = true;
      prevChildExitHandler?.();
    };

    try {
      // Poll until process.exit is called, output stabilizes, or we time out
      const MAX_TOTAL_MS = 60000;
      const IDLE_TIMEOUT_MS = 500;
      const POST_CHILD_EXIT_IDLE_MS = 100; // short timeout after children finish
      const CHECK_MS = 50;
      // Real Node exits when the event loop drains. We can't observe handles,
      // but a script that finished executing synchronously, produced no output
      // and forked nothing has nothing left to do — even in long-running mode,
      // give async startups this grace window to produce their first output
      // before concluding the script is a silent one-shot.
      const SILENT_STARTUP_GRACE_MS = 10000;
      const startTime = Date.now();
      let lastOutputLen = stdout.length + stderr.length;
      let idleMs = 0;

      // When an abort signal is present (e.g. watch mode), don't apply idle timeout —
      // only exit when aborted or process.exit is called.
      const isLongRunning = !!_abortSignal;

      while (!exitCalled) {
        // Check abort signal for long-running commands (watch mode)
        if (_abortSignal?.aborted) break;

        // Check if exitPromise resolved (non-blocking)
        const raceResult = await Promise.race([
          exitPromise.then(() => 'exit' as const),
          new Promise<'tick'>(r => setTimeout(() => r('tick'), CHECK_MS)),
        ]);

        if (raceResult === 'exit' || exitCalled) break;
        if (_abortSignal?.aborted) break;

        const currentLen = stdout.length + stderr.length;
        if (currentLen > lastOutputLen) {
          // New output — reset idle timer
          lastOutputLen = currentLen;
          idleMs = 0;
        } else {
          idleMs += CHECK_MS;
        }

        // Use shorter idle timeout once all forked children have exited
        // Skip idle timeout for long-running commands (watch mode)
        if (!isLongRunning) {
          const effectiveIdle = childrenExited ? POST_CHILD_EXIT_IDLE_MS : IDLE_TIMEOUT_MS;
          if (lastOutputLen > 0 && idleMs >= effectiveIdle) break;
        } else if (
          lastOutputLen === 0 &&
          _activeForkedChildren === 0 &&
          Date.now() - startTime >= SILENT_STARTUP_GRACE_MS
        ) {
          // Silent one-shot script under a streaming (killable) spawn: nothing
          // ever printed and no children are running — treat as drained.
          break;
        }

        // Hard timeout (skip for long-running commands)
        if (!isLongRunning && Date.now() - startTime >= MAX_TOTAL_MS) break;
      }

      return { stdout, stderr, exitCode: exitCalled ? exitCode : 0 };
    } finally {
      unwrapGlobalConsole();
      _activeProcessStdin = null;
      _onForkedChildExit = prevChildExitHandler;
      if (typeof globalThis.removeEventListener === 'function') {
        globalThis.removeEventListener('unhandledrejection', rejectionHandler);
      }
    }
  });

  /**
   * Create a package-manager custom command (npm/pnpm/yarn/bun) that runs
   * scripts from package.json and bridges installs to PackageManager.
   * This keeps almostnode framework/package-manager agnostic — the same
   * generic engine powers `npm install`, `pnpm run dev`, etc.
   */
  const createPackageManagerCommand = (pm: string) => defineCommand(pm, async (args, ctx) => {
    if (!currentVfs) {
      return { stdout: '', stderr: 'VFS not initialized\n', exitCode: 1 };
    }

    const subcommand = args[0];

    if (!subcommand || subcommand === 'help' || subcommand === '--help') {
      const usage = `Usage: ${pm} <command>\n\nCommands:\n  run <script>   Run a script from package.json\n  start          Run the start script\n  test           Run the test script\n  install [pkg]  Install packages\n  ls             List installed packages\n`;
      forwardStdout(usage);
      return {
        stdout: usage,
        stderr: '',
        exitCode: 0,
      };
    }

    switch (subcommand) {
      case 'run':
      case 'run-script':
        return handleNpmRun(args.slice(1), ctx, pm);
      case 'start':
        return handleNpmRun(['start'], ctx, pm);
      case 'test':
      case 't':
      case 'tst':
        return handleNpmRun(['test'], ctx, pm);
      case 'install':
      case 'i':
      case 'add':
        return handleNpmInstall(args.slice(1), ctx, pm);
      case 'ls':
      case 'list':
        return handleNpmList(ctx, pm);
      default: {
        const stderr = `${pm} ERR! Unknown command: "${subcommand}"\n`;
        forwardStderr(stderr);
        return {
          stdout: '',
          stderr,
          exitCode: 1,
        };
      }
    }
  });

  const jshCommand = defineCommand('jsh', async (args, ctx) => {
    if (args[0] === '-c') {
      const cmd = args.slice(1).join(' ');
      return ctx.exec?.(cmd, { cwd: ctx.cwd, env: ctx.env })
        || { stdout: '', stderr: '', exitCode: 0 };
    }

    let currentDir = ctx.cwd;
    let lineBuffer = '';
    let lineResolve: ((line: string | null) => void) | null = null;

    const stdin = new EventEmitter();
    _activeProcessStdin = stdin;

    function resolvePath(cwd: string, target: string): string {
      if (target === '' || target === '~') return '/home/user';
      if (target.startsWith('~/')) target = '/home/user' + target.slice(1);
      if (!target.startsWith('/')) target = `${cwd}/${target}`;
      const parts = target.split('/').filter(Boolean);
      const result: string[] = [];
      for (const p of parts) {
        if (p === '..') result.pop();
        else if (p !== '.') result.push(p);
      }
      return '/' + result.join('/');
    }

    stdin.on('data', (data: string) => {
      for (const ch of data) {
        if (ch === '\r' || ch === '\n') {
          _streamStdout?.('\r\n');
          const line = lineBuffer;
          lineBuffer = '';
          lineResolve?.(line);
          lineResolve = null;
        } else if (ch === '\x7f' || ch === '\b') {
          if (lineBuffer.length > 0) {
            lineBuffer = lineBuffer.slice(0, -1);
            _streamStdout?.('\b \b');
          }
        } else if (ch === '\x03') {
          lineBuffer = '';
          _streamStdout?.('^C\r\n$ ');
        } else if (ch >= ' ') {
          lineBuffer += ch;
          _streamStdout?.(ch);
        }
      }
    });

    _streamStdout?.('$ ');

    while (!_abortSignal?.aborted) {
      const line = await new Promise<string | null>((resolve) => {
        lineResolve = resolve;
      });

      if (line === null || _abortSignal?.aborted) break;
      if (line.trim() === '') { _streamStdout?.('$ '); continue; }
      if (line === 'exit' || line === 'quit') break;

      if (line === 'cd' || line.startsWith('cd ')) {
        const target = line === 'cd' ? '~' : line.slice(3).trim();
        currentDir = resolvePath(currentDir, target);
        _streamStdout?.('$ ');
        continue;
      }

      if (line.trim() === 'pwd') {
        _streamStdout?.(currentDir + '\r\n$ ');
        continue;
      }

      try {
        const result = await ctx.exec?.(line, { cwd: currentDir, env: ctx.env });
        if (result?.stdout) _streamStdout?.(result.stdout.replace(/\n/g, '\r\n'));
        if (result?.stderr) _streamStderr?.(result.stderr.replace(/\n/g, '\r\n'));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        _streamStderr?.(msg + '\r\n');
      }

      _activeProcessStdin = stdin;
      _streamStdout?.('$ ');
    }

    _activeProcessStdin = null;
    return { stdout: '', stderr: '', exitCode: 0 };
  });

  bashInstance = new Bash({
    fs: vfsAdapter,
    cwd: '/',
    env: {
      HOME: '/home/user',
      USER: 'user',
      PATH: '/usr/local/bin:/usr/bin:/bin:/node_modules/.bin',
      NODE_ENV: 'development',
    },
    customCommands: [
      nodeCommand,
      jshCommand,
      createPackageManagerCommand('npm'),
      createPackageManagerCommand('pnpm'),
      createPackageManagerCommand('yarn'),
      createPackageManagerCommand('bun'),
    ],
  });
}

/**
 * Read and parse package.json from the VFS
 */
function readPackageJson(cwd: string, pm: string = 'npm'): { pkgJson: PackageJson; error?: undefined } | { pkgJson?: undefined; error: JustBashExecResult } {
  const pkgJsonPath = `${cwd}/package.json`.replace(/\/+/g, '/');

  if (!currentVfs!.existsSync(pkgJsonPath)) {
    const stderr = `${pm} ERR! no package.json found\n`;
    forwardStderr(stderr);
    return {
      error: {
        stdout: '',
        stderr,
        exitCode: 1,
      },
    };
  }

  try {
    const pkgJson = JSON.parse(currentVfs!.readFileSync(pkgJsonPath, 'utf8')) as PackageJson;
    return { pkgJson };
  } catch {
    const stderr = `${pm} ERR! Failed to parse package.json\n`;
    forwardStderr(stderr);
    return {
      error: {
        stdout: '',
        stderr,
        exitCode: 1,
      },
    };
  }
}

/**
 * Handle `npm run [script]` — execute a script from package.json
 */
async function handleNpmRun(args: string[], ctx: CommandContext, pm: string = 'npm'): Promise<JustBashExecResult> {
  const scriptName = args[0];

  // "npm run" with no script name: list available scripts
  if (!scriptName) {
    return listScripts(ctx, pm);
  }

  const result = readPackageJson(ctx.cwd, pm);
  if (result.error) return result.error;
  const pkgJson = result.pkgJson;

  const scripts = pkgJson.scripts || {};
  const scriptCommand = scripts[scriptName];

  if (!scriptCommand) {
    const available = Object.keys(scripts);
    let msg = `${pm} ERR! Missing script: "${scriptName}"\n`;
    if (available.length > 0) {
      msg += '\n' + pm + ' ERR! Available scripts:\n';
      for (const name of available) {
        msg += `${pm} ERR!   ${name}\n`;
        msg += `${pm} ERR!     ${scripts[name]}\n`;
      }
    }
    forwardStderr(msg);
    return { stdout: '', stderr: msg, exitCode: 1 };
  }

  if (!ctx.exec) {
    const stderr = `${pm} ERR! Script execution not available in this context\n`;
    forwardStderr(stderr);
    return {
      stdout: '',
      stderr,
      exitCode: 1,
    };
  }

  // Set up npm-specific environment variables
  const npmEnv: Record<string, string> = {
    ...ctx.env,
    npm_lifecycle_event: scriptName,
  };
  if (pkgJson.name) npmEnv.npm_package_name = pkgJson.name;
  if (pkgJson.version) npmEnv.npm_package_version = pkgJson.version;

  let allStdout = '';
  let allStderr = '';
  const label = `${pkgJson.name || ''}@${pkgJson.version || ''}`;

  // Append to the buffered result AND forward to the streaming output so the
  // terminal panel shows the full `npm run` transcript as it happens.
  const streamOut = (msg: string) => {
    allStdout += msg;
    forwardStdout(msg);
  };
  const streamErr = (msg: string) => {
    allStderr += msg;
    forwardStderr(msg);
  };

  // Run pre<script> if it exists
  const preScript = scripts[`pre${scriptName}`];
  if (preScript) {
    const banner = `\n> ${label} pre${scriptName}\n> ${preScript}\n\n`;
    streamErr(banner);
    const preResult = await ctx.exec(preScript, { cwd: ctx.cwd, env: npmEnv });
    if (preResult.stdout) streamOut(preResult.stdout);
    if (preResult.stderr) streamErr(preResult.stderr);
    if (preResult.exitCode !== 0) {
      return { stdout: allStdout, stderr: allStderr, exitCode: preResult.exitCode };
    }
  }

  // Run the main script
  const mainBanner = `\n> ${label} ${scriptName}\n> ${scriptCommand}\n\n`;
  streamErr(mainBanner);
  const mainResult = await ctx.exec(scriptCommand, { cwd: ctx.cwd, env: npmEnv });
  if (mainResult.stdout) streamOut(mainResult.stdout);
  if (mainResult.stderr) streamErr(mainResult.stderr);

  if (mainResult.exitCode !== 0) {
    return { stdout: allStdout, stderr: allStderr, exitCode: mainResult.exitCode };
  }

  // Run post<script> if it exists
  const postScript = scripts[`post${scriptName}`];
  if (postScript) {
    const banner = `\n> ${label} post${scriptName}\n> ${postScript}\n\n`;
    streamErr(banner);
    const postResult = await ctx.exec(postScript, { cwd: ctx.cwd, env: npmEnv });
    if (postResult.stdout) streamOut(postResult.stdout);
    if (postResult.stderr) streamErr(postResult.stderr);
    if (postResult.exitCode !== 0) {
      return { stdout: allStdout, stderr: allStderr, exitCode: postResult.exitCode };
    }
  }

  return { stdout: allStdout, stderr: allStderr, exitCode: 0 };
}

/**
 * List available scripts from package.json (when `npm run` is called with no args)
 */
function listScripts(ctx: CommandContext, pm: string = 'npm'): JustBashExecResult {
  const result = readPackageJson(ctx.cwd, pm);
  if (result.error) return result.error;
  const pkgJson = result.pkgJson;

  const scripts = pkgJson.scripts || {};
  const names = Object.keys(scripts);

  if (names.length === 0) {
    return { stdout: '', stderr: '', exitCode: 0 };
  }

  const lifecycle = ['prestart', 'start', 'poststart', 'pretest', 'test', 'posttest', 'prestop', 'stop', 'poststop'];
  const lifecyclePresent = names.filter(n => lifecycle.includes(n));
  const customPresent = names.filter(n => !lifecycle.includes(n));

  let output = `Lifecycle scripts included in ${pkgJson.name || ''}:\n`;
  for (const name of lifecyclePresent) {
    output += `  ${name}\n    ${scripts[name]}\n`;
  }
  if (customPresent.length > 0) {
    output += '\navailable via `npm run-script`:\n';
    for (const name of customPresent) {
      output += `  ${name}\n    ${scripts[name]}\n`;
    }
  }

  forwardStdout(output);
  return { stdout: output, stderr: '', exitCode: 0 };
}

/**
 * Handle `npm install [pkg]` — bridge to PackageManager
 */
async function handleNpmInstall(args: string[], ctx: CommandContext, pm: string = 'npm'): Promise<JustBashExecResult> {
  const { PackageManager } = await import('../npm/index');
  const pmInstance = new PackageManager(currentVfs!, { cwd: ctx.cwd });

  let stdout = '';

  // Append to the buffered result AND forward to the streaming output so the
  // terminal panel sees install progress as it happens.
  const streamOut = (msg: string) => {
    stdout += msg;
    forwardStdout(msg);
  };

  try {
    const pkgArgs = args.filter(a => !a.startsWith('-'));
    if (pkgArgs.length === 0) {
      // npm install (no package name) -> install from package.json
      // include devDependencies, matching real npm/pnpm behavior
      const installResult = await pmInstance.installFromPackageJson({
        includeDev: true,
        onProgress: (msg: string) => { streamOut(msg + '\n'); },
      });
      streamOut(`added ${installResult.added.length} packages\n`);
    } else {
      // npm install <pkg> [<pkg> ...]
      for (const arg of pkgArgs) {
        const installResult = await pmInstance.install(arg, {
          save: true,
          onProgress: (msg: string) => { streamOut(msg + '\n'); },
        });
        streamOut(`added ${installResult.added.length} packages\n`);
      }
    }
    return { stdout, stderr: '', exitCode: 0 };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const errMsg = `${pm} ERR! ${msg}\n`;
    forwardStderr(errMsg);
    return { stdout, stderr: errMsg, exitCode: 1 };
  }
}

/**
 * Handle `npm ls` — list installed packages
 */
async function handleNpmList(ctx: CommandContext, _pm: string = 'npm'): Promise<JustBashExecResult> {
  const { PackageManager } = await import('../npm/index');
  const pm = new PackageManager(currentVfs!, { cwd: ctx.cwd });
  const packages = pm.list();
  const entries = Object.entries(packages);

  if (entries.length === 0) {
    return { stdout: '(empty)\n', stderr: '', exitCode: 0 };
  }

  let output = `${ctx.cwd}\n`;
  for (const [name, version] of entries) {
    output += `+-- ${name}@${version}\n`;
  }
  forwardStdout(output);
  return { stdout: output, stderr: '', exitCode: 0 };
}

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  encoding?: BufferEncoding | 'buffer';
  timeout?: number;
  maxBuffer?: number;
  shell?: string | boolean;
}

export interface ExecResult {
  stdout: string | Buffer;
  stderr: string | Buffer;
}

export type ExecCallback = (
  error: Error | null,
  stdout: string | Buffer,
  stderr: string | Buffer
) => void;

/**
 * Execute a command in a shell
 */
export function exec(
  command: string,
  optionsOrCallback?: ExecOptions | ExecCallback,
  callback?: ExecCallback
): ChildProcess {
  let options: ExecOptions = {};
  let cb: ExecCallback | undefined;

  if (typeof optionsOrCallback === 'function') {
    cb = optionsOrCallback;
  } else if (optionsOrCallback) {
    options = optionsOrCallback;
    cb = callback;
  }

  const child = new ChildProcess();

  // Execute asynchronously
  (async () => {
    if (!bashInstance) {
      const error = new Error('child_process not initialized');
      child.emit('error', error);
      if (cb) cb(error, '', '');
      return;
    }

    try {
      const result = await bashInstance!.exec(command, {
        cwd: options.cwd,
        env: options.env,
      });

      const stdout = result.stdout || '';
      const stderr = result.stderr || '';

      // Emit data events
      if (stdout) {
        child.stdout?.push(Buffer.from(stdout));
      }
      child.stdout?.push(null);

      if (stderr) {
        child.stderr?.push(Buffer.from(stderr));
      }
      child.stderr?.push(null);

      // Emit close/exit
      child.emit('close', result.exitCode, null);
      child.emit('exit', result.exitCode, null);

      if (cb) {
        if (result.exitCode !== 0) {
          const error = new Error(`Command failed: ${command}`);
          (error as any).code = result.exitCode;
          cb(error, stdout, stderr);
        } else {
          cb(null, stdout, stderr);
        }
      }
    } catch (error) {
      child.emit('error', error);
      if (cb) cb(error as Error, '', '');
    }
  })();

  return child;
}

/**
 * Execute a command synchronously
 */
export function execSync(
  command: string,
  options?: ExecOptions
): string | Buffer {
  if (!bashInstance) {
    throw new Error('child_process not initialized');
  }

  // Note: just-bash exec is async, so we can't truly do sync execution
  // This is a limitation of the browser environment
  // For now, throw an error suggesting to use exec() instead
  throw new Error(
    'execSync is not supported in browser environment. Use exec() with async/await or callbacks instead.'
  );
}

export interface SpawnOptions {
  cwd?: string;
  env?: Record<string, string>;
  shell?: boolean | string;
  stdio?: 'pipe' | 'inherit' | 'ignore' | Array<'pipe' | 'inherit' | 'ignore'>;
}

/**
 * Spawn a new process
 */
export function spawn(
  command: string,
  args?: string[] | SpawnOptions,
  options?: SpawnOptions
): ChildProcess {
  let spawnArgs: string[] = [];
  let spawnOptions: SpawnOptions = {};

  if (Array.isArray(args)) {
    spawnArgs = args;
    spawnOptions = options || {};
  } else if (args) {
    spawnOptions = args;
  }

  const child = new ChildProcess();

  // Build the full command
  const fullCommand = spawnArgs.length > 0
    ? `${command} ${spawnArgs.map(arg =>
        arg.includes(' ') ? `"${arg}"` : arg
      ).join(' ')}`
    : command;

  // Execute asynchronously
  (async () => {
    if (!bashInstance) {
      const error = new Error('child_process not initialized');
      child.emit('error', error);
      return;
    }

    try {
      const result = await bashInstance!.exec(fullCommand, {
        cwd: spawnOptions.cwd,
        env: spawnOptions.env,
      });

      const stdout = result.stdout || '';
      const stderr = result.stderr || '';

      // Emit data events
      if (stdout) {
        child.stdout?.push(Buffer.from(stdout));
      }
      child.stdout?.push(null);

      if (stderr) {
        child.stderr?.push(Buffer.from(stderr));
      }
      child.stderr?.push(null);

      // Emit close/exit
      child.emit('close', result.exitCode, null);
      child.emit('exit', result.exitCode, null);
    } catch (error) {
      child.emit('error', error);
    }
  })();

  return child;
}

/**
 * Spawn a new process synchronously
 */
export function spawnSync(
  command: string,
  args?: string[],
  options?: SpawnOptions
): { stdout: Buffer; stderr: Buffer; status: number; error?: Error } {
  throw new Error(
    'spawnSync is not supported in browser environment. Use spawn() instead.'
  );
}

export interface SpawnProcessOptions {
  cwd?: string;
  env?: Record<string, string | number | boolean>;
}

export interface SpawnProcessHandle {
  /** Merged stdout + stderr stream (like WebContainers' WebContainerProcess.output) */
  output: ReadableStream<string>;
  /** Stdin stream */
  input: WritableStream<string>;
  /** Resolves with the exit code when the process exits */
  exit: Promise<number>;
  /** Abort signal for this process */
  signal: AbortSignal;
  /** Kill the process */
  kill: () => void;
}

/**
 * Spawn a process with streaming output, stdin, and abort support.
 * This is the primitive used by the WebContainers-compatible facade
 * (`almostnode/webcontainer`) and can be used directly by consumers who
 * want per-process output streams instead of buffered `exec()`.
 *
 * Only one streaming process should run at a time (matching the existing
 * `container.run()` streaming model) — spawning a second long-running
 * process while one is active is not supported yet.
 */
export function spawnProcess(
  command: string,
  args: string[] = [],
  options: SpawnProcessOptions = {}
): SpawnProcessHandle {
  const controller = new AbortController();
  const env = options.env
    ? Object.fromEntries(Object.entries(options.env).map(([k, v]) => [k, String(v)]))
    : undefined;

  let outputController: ReadableStreamDefaultController<string> | null = null;
  const output = new ReadableStream<string>({
    start(c) {
      outputController = c;
    },
  });

  const input = new WritableStream<string>({
    write(chunk) {
      sendStdin(chunk);
    },
  });

  const fullCommand = args.length > 0
    ? `${command} ${args.map(arg => (arg.includes(' ') ? `"${arg}"` : arg)).join(' ')}`
    : command;

  let enqSeq = 0;
  const enqueue = (kind: 'out' | 'err', data: string): boolean => {
    try {
      outputController?.enqueue(data.replace(/\n/g, '\r\n'));
      if (streamDiagEnabled()) streamDiag('enq', kind, String(++enqSeq), String(data.length), 'ok');
      return true;
    } catch {
      if (streamDiagEnabled()) streamDiag('enq', kind, String(++enqSeq), String(data.length), 'err');
      return false;
    }
  };

  const exit = new Promise<number>((resolve) => {
    if (streamDiagEnabled()) streamDiag('spawn', fullCommand);
    setStreamingCallbacks({
      onStdout: (data) => { enqueue('out', data); },
      onStderr: (data) => { enqueue('err', data); },
      signal: controller.signal,
    });

    exec(fullCommand, { cwd: options.cwd, env }, (error, _stdout, _stderr) => {
      if (streamDiagEnabled()) streamDiag('spawn-done', fullCommand, `code=${(error as { code?: unknown } | null)?.code ?? 0}`);
      // Don't clear streaming callbacks here. When a new process starts
      // before the old one's callback fires (e.g. Ctrl+C → kill → respawn),
      // the old clearStreamingCallbacks would wipe the new process's callbacks.
      // setStreamingCallbacks() in the next spawnProcess overwrites them anyway.
      try { outputController?.close(); } catch { /* already closed */ }
      const code = error && typeof (error as { code?: unknown }).code === 'number'
        ? (error as unknown as { code: number }).code
        : 0;
      resolve(code);
    });
  });

  return {
    output,
    input,
    exit,
    signal: controller.signal,
    kill: () => controller.abort(),
  };
}

/**
 * Execute a file
 */
export function execFile(
  file: string,
  args?: string[] | ExecOptions | ExecCallback,
  options?: ExecOptions | ExecCallback,
  callback?: ExecCallback
): ChildProcess {
  let execArgs: string[] = [];
  let execOptions: ExecOptions = {};
  let cb: ExecCallback | undefined;

  if (Array.isArray(args)) {
    execArgs = args;
    if (typeof options === 'function') {
      cb = options;
    } else if (options) {
      execOptions = options;
      cb = callback;
    }
  } else if (typeof args === 'function') {
    cb = args;
  } else if (args) {
    execOptions = args;
    cb = options as ExecCallback;
  }

  const command = execArgs.length > 0 ? `${file} ${execArgs.join(' ')}` : file;
  return exec(command, execOptions, cb);
}

/**
 * Fork — runs a Node.js module in a simulated child process using a new Runtime.
 * In the browser, there's no real process forking. Instead we:
 * 1. Create a ChildProcess with IPC (send/on('message'))
 * 2. Create a new Runtime to execute the module
 * 3. Wire up bidirectional IPC between parent and child
 */
export function fork(
  modulePath: string,
  argsOrOptions?: string[] | Record<string, unknown>,
  options?: Record<string, unknown>
): ChildProcess {
  if (!currentVfs) {
    throw new Error('VFS not initialized');
  }

  // Parse overloaded arguments
  let args: string[] = [];
  let opts: Record<string, unknown> = {};
  if (Array.isArray(argsOrOptions)) {
    args = argsOrOptions;
    opts = options || {};
  } else if (argsOrOptions) {
    opts = argsOrOptions;
  }

  const cwd = (opts.cwd as string) || '/';
  const env = (opts.env as Record<string, string>) || {};
  const execArgv = (opts.execArgv as string[]) || [];

  // Resolve the module path
  const resolvedPath = modulePath.startsWith('/')
    ? modulePath
    : `${cwd}/${modulePath}`.replace(/\/+/g, '/');

  const child = new ChildProcess();
  child.connected = true;
  child.spawnargs = ['node', ...execArgv, resolvedPath, ...args];
  child.spawnfile = 'node';

  // Create a Runtime for the child process
  const childRuntime = new Runtime(currentVfs!, {
    cwd,
    env,
    onConsole: (method, consoleArgs) => {
      const msg = consoleArgs.map(a => String(a)).join(' ');
      if (method === 'error' || method === 'warn') {
        child.stderr?.emit('data', msg + '\n');
      } else {
        child.stdout?.emit('data', msg + '\n');
      }
    },
    onStdout: (data: string) => {
      child.stdout?.emit('data', data);
    },
    onStderr: (data: string) => {
      child.stderr?.emit('data', data);
    },
  });

  const childProc = childRuntime.getProcess();
  childProc.argv = ['node', resolvedPath, ...args];

  // Set up bidirectional IPC with serialized delivery.
  // In real Node.js, IPC messages cross a process boundary (pipe/fd), so there's
  // natural latency. In our same-thread implementation, we need to serialize
  // message delivery to prevent race conditions (e.g. vitest's reporter receiving
  // task-update before the "collected" tasks are registered).

  // Clone IPC messages to mimic real Node.js IPC behavior.
  // Real IPC serializes messages across process boundaries (V8 serializer).
  // Without cloning, shared object references cause issues: vitest's child
  // modifies task objects after sending, and the parent sees stale/corrupted state.
  const cloneIpcMessage = (msg: unknown): unknown => {
    try { return structuredClone(msg); } catch { return msg; }
  };

  // Parent sends → child process receives
  child.send = (message: unknown, _callback?: (error: Error | null) => void): boolean => {
    if (!child.connected) return false;
    const cloned = cloneIpcMessage(message);
    setTimeout(() => {
      childProc.emit('message', cloned);
    }, 0);
    return true;
  };

  // Child sends → parent ChildProcess receives (serialized + awaited)
  // In real Node.js, IPC crosses a process boundary so messages are naturally serialized.
  // In our same-thread implementation, we must manually serialize AND await async handlers.
  // Using emit() won't work — EventEmitter is fire-and-forget for async handlers.
  // Instead, we directly invoke each 'message' listener and await any returned promises.
  // This ensures birpc's async onCollected finishes before onTaskUpdate starts.
  let ipcQueue: Promise<void> = Promise.resolve();
  childProc.send = ((message: unknown, _callback?: (error: Error | null) => void): boolean => {
    if (!child.connected) return false;
    const cloned = cloneIpcMessage(message);
    ipcQueue = ipcQueue.then(async () => {
      const listeners = child.listeners('message');
      for (const listener of listeners) {
        try {
          const result = (listener as (...args: unknown[]) => unknown)(cloned);
          if (result && typeof (result as Promise<unknown>).then === 'function') {
            await result;
          }
        } catch {
          // Handler errors propagate through vitest's own error handling
        }
      }
    });
    return true;
  }) as any;
  childProc.connected = true;

  // Track this fork in the active children count
  _activeForkedChildren++;

  const notifyChildExit = () => {
    _activeForkedChildren--;
    _onForkedChildExit?.();
  };

  // Override child's process.exit
  childProc.exit = ((code = 0) => {
    child.exitCode = code;
    child.connected = false;
    childProc.connected = false;
    childProc.emit('exit', code);
    child.emit('exit', code, null);
    child.emit('close', code, null);
    notifyChildExit();
  }) as (code?: number) => never;

  // Override child's kill to disconnect
  child.kill = (signal?: string): boolean => {
    child.killed = true;
    child.connected = false;
    childProc.connected = false;
    childProc.emit('exit', null, signal || 'SIGTERM');
    child.emit('exit', null, signal || 'SIGTERM');
    child.emit('close', null, signal || 'SIGTERM');
    notifyChildExit();
    return true;
  };

  child.disconnect = (): void => {
    child.connected = false;
    childProc.connected = false;
    child.emit('disconnect');
  };

  // Run the module asynchronously
  setTimeout(() => {
    try {
      childRuntime.runFile(resolvedPath);
    } catch (error) {
      // process.exit throws in sync mode — that's normal
      if (error instanceof Error && error.message.startsWith('Process exited with code')) {
        return;
      }
      const errorMsg = error instanceof Error ? error.message : String(error);
      child.stderr?.emit('data', `Error in forked process: ${errorMsg}\n`);
      child.exitCode = 1;
      child.emit('error', error);
      child.emit('exit', 1, null);
      child.emit('close', 1, null);
    }
  }, 0);

  return child;
}

/**
 * ChildProcess class
 */
export class ChildProcess extends EventEmitter {
  pid: number;
  connected: boolean = false;
  killed: boolean = false;
  exitCode: number | null = null;
  signalCode: string | null = null;
  spawnargs: string[] = [];
  spawnfile: string = '';

  stdin: Writable | null;
  stdout: Readable | null;
  stderr: Readable | null;

  constructor() {
    super();
    this.pid = Math.floor(Math.random() * 10000) + 1000;
    this.stdin = new Writable();
    this.stdout = new Readable();
    this.stderr = new Readable();
  }

  kill(signal?: string): boolean {
    this.killed = true;
    this.emit('exit', null, signal || 'SIGTERM');
    return true;
  }

  disconnect(): void {
    this.connected = false;
  }

  send(message: unknown, callback?: (error: Error | null) => void): boolean {
    // IPC not supported
    if (callback) callback(new Error('IPC not supported'));
    return false;
  }

  ref(): this {
    return this;
  }

  unref(): this {
    return this;
  }
}

export default {
  exec,
  execSync,
  execFile,
  spawn,
  spawnSync,
  fork,
  ChildProcess,
  initChildProcess,
  setStreamingCallbacks,
  clearStreamingCallbacks,
  forwardStdout,
  forwardStderr,
};
