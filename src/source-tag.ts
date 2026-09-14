/**
 * Source tagging for container-evaluated code.
 *
 * Every module the almostnode runtime evaluates is annotated with a
 * `//# sourceURL=almostnode:<path>` pragma. Engines attach that name to
 * stack frames, which gives us a minification-proof way to tell container
 * code apart from host-page code (both share `globalThis` on the main
 * thread). The global-console capture in `shims/child_process.ts` forwards
 * only container-originated calls into process streams; host-page calls
 * pass through untouched — no matter how the host bundle is minified.
 */

export const SOURCE_TAG_PRAGMA = '//# sourceURL=';
export const SOURCE_TAG_PREFIX = 'almostnode:';

/**
 * Append a sourceURL tag for `sourcePath` to evaluated code. Idempotent.
 * The tag goes on its own line so it is safe after any valid program text.
 */
export function tagSource(code: string, sourcePath: string): string {
  const tag = `${SOURCE_TAG_PRAGMA}${SOURCE_TAG_PREFIX}${sourcePath}`;
  if (code.includes(tag)) return code;
  return `${code}\n${tag}`;
}

/**
 * Whether an error stack contains at least one frame from tagged
 * (container-evaluated) code. Stacks that cannot be captured count as
 * non-container: the global-console capture stays conservative and lets
 * the host page keep its own output rather than risk bleeding it into
 * the container's terminal.
 */
export function isContainerSourceStack(stack: string | null | undefined): boolean {
  return !!stack && stack.includes(SOURCE_TAG_PREFIX);
}
