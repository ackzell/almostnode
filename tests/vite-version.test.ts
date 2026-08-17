import { describe, it, expect } from 'vitest';
import { VirtualFS } from '../src/virtual-fs';
import { assertViteSupported, assertViteSupportedByPath } from '../src/vite-version';

describe('vite version guard', () => {
  it('allows vite@7', () => {
    expect(() => assertViteSupported('7.3.5')).not.toThrow();
  });

  it('rejects vite@8 and later majors', () => {
    expect(() => assertViteSupported('8.0.0')).toThrow(/not supported/);
    expect(() => assertViteSupported('9.0.0-beta.0')).toThrow(/not supported/);
  });

  it('rejects vite@8 when resolved under node_modules/vite', () => {
    const vfs = new VirtualFS();
    vfs.mkdirSync('/node_modules/vite', { recursive: true });
    vfs.writeFileSync('/node_modules/vite/package.json', JSON.stringify({ version: '8.0.0' }));
    expect(() => assertViteSupportedByPath(vfs, '/node_modules/vite/dist/node/index.js')).toThrow(/not supported/);
  });

  it('allows vite@7 when resolved under node_modules/vite', () => {
    const vfs = new VirtualFS();
    vfs.mkdirSync('/node_modules/vite', { recursive: true });
    vfs.writeFileSync('/node_modules/vite/package.json', JSON.stringify({ version: '7.3.5' }));
    expect(() => assertViteSupportedByPath(vfs, '/node_modules/vite/dist/node/index.js')).not.toThrow();
  });

  it('ignores non-vite paths', () => {
    const vfs = new VirtualFS();
    expect(() => assertViteSupportedByPath(vfs, '/node_modules/lodash/index.js')).not.toThrow();
  });
});
