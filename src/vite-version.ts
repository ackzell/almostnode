/**
 * Shared vite version guard.
 *
 * almostnode supports vite@7 only. vite@8 (and later majors) needs real
 * rolldown/lightningcss native bindings that don't exist in the browser yet,
 * so we fail fast with a clear message instead of letting vite throw cryptic
 * bootstrap errors deep inside its own dist code.
 */

import { VirtualFS } from './virtual-fs';

export function assertViteSupported(version: string): void {
  const major = parseInt(version.split('.')[0], 10);
  if (!Number.isFinite(major)) return;
  if (major >= 8) {
    throw new Error(
      `vite@${version} is not supported by almostnode — pin vite@^7.0.0 in your package.json.`
    );
  }
}

/**
 * Check the installed vite version for a resolved file path under a
 * `node_modules/vite` directory and throw if it is unsupported.
 */
export function assertViteSupportedByPath(vfs: VirtualFS, resolvedPath: string): void {
  const marker = '/node_modules/vite/';
  const idx = resolvedPath.indexOf(marker);
  if (idx === -1) return;

  const viteRoot = resolvedPath.slice(0, idx + '/node_modules/vite'.length);
  const pkgPath = viteRoot + '/package.json';
  try {
    const pkg = JSON.parse(vfs.readFileSync(pkgPath, 'utf8'));
    assertViteSupported(pkg.version);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('vite@')) throw error;
    // Ignore read/parse failures — no version info means nothing to guard.
  }
}
