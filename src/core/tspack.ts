/**
 * Direct .ts pack loading.
 *
 * The browser cannot run TypeScript, so a pack is stripped with Sucrase and
 * then evaluated with `new Function`. The DSL names are injected as
 * parameters, which keeps the pack free of imports and makes the transform
 * functions live (closures keep working; nothing is JSON-serialized).
 *
 * This is deliberately a "trusted file" path: a pack is code. The UI asks for
 * confirmation before evaluating a dropped file.
 */

import { transform } from 'sucrase';
import { PACK_DSL, type Pack, validatePack } from './pack';
import type { Problem } from './types';

export interface CompileResult {
  js?: string;
  error?: string;
  /** line/column reported by Sucrase, when available */
  loc?: { line: number; column: number };
}

export interface LoadResult {
  pack?: Pack;
  js?: string;
  /** Evaluate a transform expression inside the pack's lexical scope. */
  compile?: (src: string) => unknown;
  error?: string;
  issues: Problem[];
}

/** Strip TypeScript syntax and turn `export default` into a return. */
export function compilePackSource(source: string): CompileResult {
  let js: string;
  try {
    js = transform(source, {
      transforms: ['typescript'],
      disableESTransforms: true,
    }).code;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const m = msg.match(/\((\d+):(\d+)\)/);
    return {
      error: msg.replace(/^Error transforming [^:]+:\s*/, ''),
      loc: m ? { line: Number(m[1]), column: Number(m[2]) } : undefined,
    };
  }

  // Sucrase keeps ES module syntax. A pack is a single expression, so turn the
  // default export into a return and reject any other module syntax.
  if (/\bexport\s*\{/.test(js)) {
    return { error: '只支持 `export default definePack(...)`，不支持 export { ... }' };
  }
  if (/\bexport\s+(?!default\b)/.test(js)) {
    return { error: '只支持 `export default`；其它 export 会被工具忽略' };
  }
  const hasDefault = /\bexport\s+default\s+/.test(js);
  if (hasDefault) {
    js = js.replace(/\bexport\s+default\s+/, 'const __pack = ');
  } else {
    // Allow a plain `return definePack(...)` too.
    if (!/\breturn\b/.test(js)) {
      return { error: 'pack 需要以 `export default definePack({...})` 结尾' };
    }
  }

  // Value imports cannot be resolved in the sandbox. Type-only imports were
  // already erased by Sucrase, so any import left here is a real one.
  const imp = js.match(/^\s*import\s.+$/m);
  if (imp) {
    return { error: 'pack 里不能 import；definePack/struct/u16 等已作为全局函数注入' };
  }

  return { js };
}

const DSL_NAMES = Object.keys(PACK_DSL);

/**
 * Evaluate compiled JS with the DSL injected.
 *
 * `js` assigns the pack to `__pack`; we then return the pack together with a
 * `compile` helper. The helper is created in the same function scope, so
 * direct `eval` can see pack-local closures (`idxToAddr`, `FLAGS`, ...).
 * Without that, overrides that reuse a pack helper would fail with
 * "idxToAddr is not defined".
 */
export function evaluatePack(js: string): {
  pack?: Pack;
  compile?: (src: string) => unknown;
  error?: string;
} {
  // Older callers/tests may pass a top-level `return`; normalize it.
  const body = js.replace(/^(\s*)return\b/, '$1const __pack =');
  let fn: Function;
  try {
    fn = new Function(
      ...DSL_NAMES,
      `"use strict";\n${body}\n;return { pack: __pack, compile: (src) => eval('(' + src + ')') };\n//# sourceURL=memlink-pack.ts`,
    );
  } catch (e) {
    return { error: `语法错误：${e instanceof Error ? e.message : String(e)}` };
  }

  try {
    const out = fn(...DSL_NAMES.map((n) => (PACK_DSL as Record<string, unknown>)[n])) as {
      pack?: Pack;
      compile?: (src: string) => unknown;
    };
    const pack = out?.pack;
    if (!pack || typeof pack !== 'object') {
      return { error: 'pack 没有返回对象（是不是忘了 definePack？）' };
    }
    if (typeof pack.endian !== 'string' || !Array.isArray(pack.types)) {
      return { error: '返回值不像一个 pack：缺少 endian/types' };
    }
    return { pack, compile: out.compile };
  } catch (e) {
    return { error: `执行失败：${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Compile + evaluate + validate. */
export function loadPack(source: string): LoadResult {
  const c = compilePackSource(source);
  if (c.error || !c.js) return { error: c.error ?? '编译失败', issues: [] };
  const r = evaluatePack(c.js);
  if (!r.pack) return { error: r.error ?? '执行失败', js: c.js, issues: [] };
  const pack = r.pack;
  pack.source = source;
  const issues = validatePack(pack);
  const hard = issues.filter((i) => i.severity === 'error');
  if (hard.length) {
    return { error: hard[0].message, js: c.js, issues };
  }
  return { pack, js: c.js, compile: r.compile, issues };
}
