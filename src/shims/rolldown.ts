import * as acorn from 'acorn';

// ==================== Version info ====================
export const VERSION = '1.0.3';
export const RUNTIME_MODULE_ID = '\0runtime';

// ==================== BuiltinPlugin ====================
export class BuiltinPlugin {
  name: string;
  _options: Record<string, unknown>;
  _runnable: unknown = null;

  constructor(name: string, options?: Record<string, unknown>) {
    this.name = name;
    this._options = options ?? {};
  }
}

// ==================== Config ====================
export function defineConfig(options: any): any {
  return options;
}

// ==================== Bundler API ====================
export async function rolldown(options: any): Promise<any> {
  console.warn('[rolldown] rolldown() not yet implemented');
  return {
    build: async () => ({ output: [] }),
    generate: async () => ({ output: [] }),
    write: async () => ({ output: [] }),
    watch: () => ({ close: async () => {} }),
    close: async () => {},
  };
}

export async function build(options: any): Promise<any> {
  return { output: [] };
}

export function watch(options: any): any {
  return { close: async () => {} };
}

// ==================== RolldownMagicString ====================
export class RolldownMagicString {
  private str: string;
  constructor(str: string) { this.str = str; }
  toString(): string { return this.str; }
}

// ==================== Parse ====================
export function parse(
  input: string,
  options?: { allowReturnOutsideFunction?: boolean; jsx?: boolean },
): { program: any; module: any; comments: any[]; errors: any[] } {
  const ast = acorn.parse(input, {
    ecmaVersion: 'latest',
    sourceType: 'module',
    locations: true,
    ...(options ?? {}),
  });
  return { program: ast, module: null, comments: [], errors: [] };
}

export function parseSync(
  input: string,
  options?: { allowReturnOutsideFunction?: boolean; jsx?: boolean },
): { program: any; module: any; comments: any[]; errors: any[] } {
  return parse(input, options);
}

export function parseAst(input: string, options?: any): any {
  return acorn.parse(input, {
    ecmaVersion: 'latest',
    sourceType: 'module',
    locations: true,
    ...(options ?? {}),
  });
}

export async function parseAstAsync(input: string, options?: any): Promise<any> {
  return parseAst(input, options);
}

// ==================== Transform ====================
export function transformSync(code: string, _filename: string, _options?: any): { code: string; map: null } {
  return { code, map: null };
}

export async function transform(code: string, filename: string, options?: any): Promise<{ code: string; map: null }> {
  return transformSync(code, filename, options);
}

// ==================== Minify ====================
export function minifySync(code: string, _filename: string): { code: string; map: null } {
  return { code, map: null };
}

export async function minify(code: string, filename: string): Promise<{ code: string; map: null }> {
  return minifySync(code, filename);
}

// ==================== TsconfigCache ====================
export class TsconfigCache {
  private cache = new Map<string, any>();
  get(key: string): any { return this.cache.get(key); }
  set(key: string, value: any): void { this.cache.set(key, value); }
  has(key: string): boolean { return this.cache.has(key); }
  clear(): void { this.cache.clear(); }
}

// ==================== resolveTsconfig ====================
export function resolveTsconfig(_filename: string, _cache?: TsconfigCache): any {
  return {};
}

// ==================== Visitor ====================
export class Visitor {
  visit(_ast: any, _visitors: Record<string, Function>): void {}
}

// ==================== Filter helpers ====================
export function withFilter(fn: any, _filters?: any): any { return fn; }
export function exactRegex(str: string): RegExp {
  return new RegExp(`^${str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
}
export function prefixRegex(str: string): RegExp {
  return new RegExp(`^${str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
}
export function makeIdFiltersToMatchWithQuery(_query: string, _include: any[], _exclude: any[]): any[] {
  return [];
}
export function and(..._filters: any[]): any { return _filters; }
export function or(..._filters: any[]): any { return _filters; }
export function not(_filter: any): any { return {}; }
export function id(_str?: string): any { return {}; }
export function importerId(_str?: string): any { return {}; }
export function moduleType(..._types: string[]): any { return {}; }
export function code(_pattern: RegExp | string): any { return {}; }
export function query(_str: string): any { return {}; }
export function include(..._filters: any[]): any { return {}; }
export function exclude(..._filters: any[]): any { return {}; }
export function queries(..._qs: string[]): any { return {}; }
export function interpreter(..._interpreters: string[]): any { return {}; }
export function filterVitePlugins(..._plugins: any[]): any[] { return _plugins; }

// ==================== Plugins ====================
export const esmExternalRequirePlugin = new BuiltinPlugin('esm-external-require', {});

// ==================== Experimental (dev server, scan, etc.) ====================
export function dev(..._args: any[]): any {
  console.warn('[rolldown] dev() called - Vite 8 dev mode needs real bundling');
  return {
    run: async () => {},
    invalidate: () => {},
    compileEntry: async () => null,
    close: async () => {},
  };
}

export function scan(..._args: any[]): any {
  return { dependencies: [] };
}

export function oxcRuntimePlugin(): BuiltinPlugin {
  return new BuiltinPlugin('oxc-runtime', {});
}

function createPlugin(name: string) {
  return function (this: any, ...args: any[]): BuiltinPlugin {
    return new BuiltinPlugin(name, args.length > 0 ? (args[0] instanceof BuiltinPlugin ? {} : args[0]) : {});
  };
}

export const viteAliasPlugin: any = createPlugin('builtin:alias');
export const viteBuildImportAnalysisPlugin: any = createPlugin('builtin:build-import-analysis');
export const viteDynamicImportVarsPlugin: any = createPlugin('builtin:dynamic-import-vars');
export const viteImportGlobPlugin: any = createPlugin('builtin:import-glob');
export const viteJsonPlugin: any = createPlugin('builtin:json');
export const viteLoadFallbackPlugin: any = createPlugin('builtin:load-fallback');
export const viteManifestPlugin: any = createPlugin('builtin:manifest');
export const viteModulePreloadPolyfillPlugin: any = createPlugin('builtin:module-preload-polyfill');
export const viteReporterPlugin: any = createPlugin('builtin:reporter');
export const viteResolvePlugin: any = createPlugin('builtin:resolve');
export const viteTransformPlugin: any = createPlugin('builtin:transform');
export const viteWasmFallbackPlugin: any = createPlugin('builtin:wasm-fallback');
export const viteWebWorkerPostPlugin: any = createPlugin('builtin:web-worker-post');
