/**
 * Inline transform editing.
 *
 * A pack field's transform is a live function. The inspector can override it
 * without rewriting the pack source: overrides are compiled with
 * `new Function('v','ctx', ...)` and applied to a cloned pack before the graph
 * is rebuilt. Clearing an override restores the function from the .ts file.
 */

import type { FieldDef, Pack, TransformFn } from '../core/pack';
import { fieldId } from '../core/pack';

export interface FieldOverride {
  /** function expression, e.g. `(v, ctx) => ctx.consts.BASE + v * 24`; empty = no transform */
  code: string;
  /** undefined = keep pack value, null = remove follow, string = set follow */
  follow?: string | null;
}

/**
 * Compile an override in the page scope. This is the fallback for packs loaded
 * without a scope-aware compiler; it cannot see pack-local helper closures.
 */
export function compileTransform(code: string): { fn?: TransformFn; error?: string } {
  const src = code.trim();
  if (!src) return { fn: undefined };
  try {
    // `src` is a *function expression*; evaluate it once to obtain the function.
    const fn = new Function(`"use strict"; return (${src});`)();
    if (typeof fn !== 'function') return { error: '需要一个 (v, ctx) => ... 函数' };
    return { fn: fn as TransformFn };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/** Compile through the pack's own evaluator so pack helpers stay in scope. */
export function compileOverride(
  compile: (src: string) => unknown,
  code: string,
): { fn?: TransformFn; error?: string } {
  const src = code.trim();
  if (!src) return { fn: undefined };
  try {
    const fn = compile(src);
    if (typeof fn !== 'function') return { error: '需要一个 (v, ctx) => ... 函数' };
    return { fn: fn as TransformFn };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/** Apply inspector overrides to a copy of the pack. */
export function applyOverrides(
  pack: Pack,
  overrides: Record<string, FieldOverride>,
  compile?: (src: string) => unknown,
): Pack {
  if (!Object.keys(overrides).length) return pack;
  return {
    ...pack,
    types: pack.types.map((t) => ({
      ...t,
      fields: t.fields.map((f) => {
        const o = overrides[fieldId(t.name, f.name)];
        if (!o) return f;
        const nf: FieldDef = { ...f };
        if (o.follow !== undefined) nf.follow = o.follow ?? undefined;
        const c = compile ? compileOverride(compile, o.code) : compileTransform(o.code);
        if (!c.error) nf.transform = c.fn;
        return nf;
      }),
    })),
  };
}

export interface TransformTemplate {
  id: string;
  name: string;
  code: string;
  follow?: string | null;
  hint?: string;
}

export const TRANSFORM_TEMPLATES: TransformTemplate[] = [
  {
    id: 'index',
    name: '下标 → 地址',
    code: '(v, ctx) => v < 0 ? null : ctx.consts.BASE + v * ctx.consts.STRIDE',
    hint: '需要常量 BASE / STRIDE；负数视为结束',
  },
  {
    id: 'index1',
    name: '1 基下标 → 地址',
    code: '(v, ctx) => v <= 0 ? null : ctx.consts.BASE + (v - 1) * ctx.consts.STRIDE',
    hint: '0 表示空',
  },
  {
    id: 'offset',
    name: '文件偏移 → 地址',
    code: '(v, ctx) => ctx.consts.BASE + v',
    hint: '需要常量 BASE',
  },
  {
    id: 'flags',
    name: '位标志 → 名称',
    code: "(v, ctx) => ['READ', 'WRITE', 'DIRTY'].filter((_, i) => Number(v) & (1 << i)).join('|') || '0'",
    hint: '按位拼接名称',
  },
  {
    id: 'enum',
    name: '枚举 → 名称',
    code: "(v, ctx) => ({ 0: 'FREE', 1: 'USED', 2: 'DIRTY' })[Number(v)] ?? v",
    hint: '把数字映射成标签',
  },
  {
    id: 'time',
    name: 'Unix 秒 → 时间',
    code: '(v, ctx) => new Date(Number(v) * 1000).toISOString()',
    hint: '也适用于毫秒，乘 1 即可',
  },
  {
    id: 'hex',
    name: '数字 → 十六进制',
    code: '(v, ctx) => `0x${Number(v).toString(16).toUpperCase()}`',
    hint: '仅改变显示',
  },
  {
    id: 'nullcheck',
    name: '0 → null',
    code: '(v, ctx) => Number(v) === 0 ? null : Number(v)',
    hint: '0 当空地址',
  },
];
