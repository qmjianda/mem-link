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

export interface CompileResult {
  js?: string;
  error?: string;
  /** line/column reported by Sucrase, when available */
  loc?: { line: number; column: number };
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
