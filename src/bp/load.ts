/**
 * Loader for blueprint packs. Same trusted-code path as v2: Sucrase strips
 * TypeScript, `new Function` injects the DSL, and the exported object stays
 * live (closures are not serialized).
 */

import type { Problem } from '../core/types';
import type { TypeDef } from '../core/pack';
import { fieldSize } from '../core/pack';
import { compilePackSource } from '../core/tspack';
import { BP_DSL_NAMES, BP_DSL_VALUES } from './dsl';
import type { BlueprintPack, NodeDef, PortType } from './types';

export interface BPLoadResult {
  pack?: BlueprintPack;
  js?: string;
  /** evaluate an expression inside the pack's lexical scope */
  compile?: (src: string) => unknown;
  error?: string;
  issues: Problem[];
}

const PORT_TYPES: PortType[] = ['number', 'string', 'bytes', 'boolean', 'instance', 'list', 'buffer'];

function isPortType(v: unknown): v is PortType {
  return typeof v === 'string' && (PORT_TYPES as string[]).includes(v);
}

function validateType(name: string, type: TypeDef, pack: BlueprintPack): Problem[] {
  const out: Problem[] = [];
  if (!type || typeof type !== 'object') {
    return [{ severity: 'error', message: `类型 ${name} 不是对象` }];
  }
  if (type.name !== name) {
    out.push({ severity: 'warn', message: `类型键名 ${name} 与 name=${type.name} 不一致` });
  }
  if (!Number.isFinite(type.size) || type.size <= 0) {
    out.push({ severity: 'error', message: `类型 ${name} 的 size 必须是正数` });
    return out;
  }
  if (!Array.isArray(type.fields)) {
    out.push({ severity: 'error', message: `类型 ${name} 缺少 fields` });
    return out;
  }

  const compat = { pointerSize: pack.pointerSize, types: Object.values(pack.types) };
  const seen = new Set<string>();
  for (const f of type.fields) {
    const tag = `${name}.${f?.name}`;
    if (!f || typeof f.name !== 'string' || !f.name) {
      out.push({ severity: 'error', message: `类型 ${name} 有字段缺少 name` });
      continue;
    }
    if (seen.has(f.name)) out.push({ severity: 'error', message: `字段重名 ${tag}` });
    seen.add(f.name);
    if (!Number.isFinite(f.offset) || f.offset < 0) {
      out.push({ severity: 'error', message: `${tag} 的 offset 非法` });
      continue;
    }
    if (f.kind === 'bits' && (!f.bits || f.bits.width <= 0 || f.bits.offset < 0)) {
      out.push({ severity: 'error', message: `${tag} 的位域参数非法` });
    }
    if (f.kind === 'record' || f.kind === 'array') {
      const target = f.of;
      if (!target || !pack.types[target]) {
        out.push({ severity: 'error', message: `${tag} 引用了不存在的类型 ${target ?? '?'}` });
      }
    }
    const size = fieldSize(f, compat);
    if (!Number.isFinite(size) || size <= 0) {
      out.push({ severity: 'error', message: `${tag} 的大小非法（${size}）` });
    } else if (f.offset + size > type.size) {
      out.push({
        severity: 'error',
        message: `${tag} 越界`,
        detail: `offset ${f.offset} + size ${size} > ${type.size}`,
      });
    }
  }
  return out;
}

function validateNode(key: string, def: NodeDef, pack: BlueprintPack): Problem[] {
  const out: Problem[] = [];
  if (!def || typeof def !== 'object') {
    return [{ severity: 'error', message: `节点 ${key} 不是对象` }];
  }
  if (!['struct', 'list', 'array', 'calc'].includes(def.kind)) {
    return [{ severity: 'error', message: `节点 ${key} 的 kind=${String((def as { kind?: unknown }).kind)} 不支持` }];
  }
  if (def.kind === 'calc') {
    if (typeof def.run !== 'function') out.push({ severity: 'error', message: `计算节点 ${key} 缺少 run 函数` });
    for (const [group, ports] of [['inputs', def.inputs], ['outputs', def.outputs]] as const) {
      if (!ports || typeof ports !== 'object') {
        out.push({ severity: 'error', message: `计算节点 ${key} 缺少 ${group}` });
        continue;
      }
      for (const [name, t] of Object.entries(ports)) {
        if (!isPortType(t)) {
          out.push({ severity: 'error', message: `计算节点 ${key}.${name} 的端口类型 ${String(t)} 不支持` });
        }
      }
    }
    return out;
  }

  if (!def.type || !pack.types[def.type.name]) {
    out.push({ severity: 'error', message: `节点 ${key} 引用的类型 ${def.type?.name ?? '?'} 不在 types 里` });
  }
  if (def.kind === 'list') {
    if (typeof def.next !== 'function') out.push({ severity: 'error', message: `链表节点 ${key} 缺少 next 函数` });
    if (def.max != null && (!Number.isFinite(def.max) || def.max <= 0)) {
      out.push({ severity: 'error', message: `链表节点 ${key} 的 max 必须是正数` });
    }
    if (def.nulls && (!Array.isArray(def.nulls) || def.nulls.some((n) => !Number.isFinite(n)))) {
      out.push({ severity: 'error', message: `链表节点 ${key} 的 nulls 必须是数字数组` });
    }
  }
  if (def.kind === 'array') {
    if (def.count != null && (!Number.isFinite(def.count) || def.count < 0)) {
      out.push({ severity: 'error', message: `数组节点 ${key} 的 count 非法` });
    }
    if (def.stride != null && (!Number.isFinite(def.stride) || def.stride <= 0)) {
      out.push({ severity: 'error', message: `数组节点 ${key} 的 stride 非法` });
    }
  }
  return out;
}

export function validateBlueprintPack(pack: BlueprintPack): Problem[] {
  const out: Problem[] = [];
  if (!pack || typeof pack !== 'object') return [{ severity: 'error', message: 'pack 不是对象' }];
  if (!pack.types || typeof pack.types !== 'object' || Array.isArray(pack.types)) {
    return [{ severity: 'error', message: 'pack.types 必须是 { 名称: struct(...) } 对象' }];
  }
  if (!pack.nodes || typeof pack.nodes !== 'object' || Array.isArray(pack.nodes)) {
    out.push({ severity: 'error', message: 'pack.nodes 必须是 { 名称: 节点 } 对象' });
  }
  if (pack.endian !== 'little' && pack.endian !== 'big') {
    out.push({ severity: 'error', message: 'endian 必须是 little / big' });
  }
  if (pack.pointerSize !== 4 && pack.pointerSize !== 8) {
    out.push({ severity: 'error', message: 'pointerSize 必须是 4 / 8' });
  }
  if (!pack.constants || typeof pack.constants !== 'object') {
    out.push({ severity: 'warn', message: 'constants 缺失，按空对象处理' });
    pack.constants = {};
  }

  for (const [name, type] of Object.entries(pack.types)) {
    out.push(...validateType(name, type, pack));
  }
  if (!Object.keys(pack.types).length) out.push({ severity: 'error', message: 'pack 没有任何类型' });

  for (const [key, def] of Object.entries(pack.nodes ?? {})) {
    out.push(...validateNode(key, def, pack));
  }
  if (!Object.keys(pack.nodes ?? {}).length) out.push({ severity: 'warn', message: 'pack 没有声明任何节点' });
  return out;
}

export function evaluateBlueprintPack(js: string): {
  pack?: BlueprintPack;
  compile?: (src: string) => unknown;
  error?: string;
} {
  const body = js.replace(/^(\s*)return\b/, '$1const __pack =');
  let fn: Function;
  try {
    fn = new Function(
      ...BP_DSL_NAMES,
      `"use strict";\n${body}\n;return { pack: __pack, compile: (src) => eval('(' + src + ')') };\n//# sourceURL=memlink-blueprint.ts`,
    );
  } catch (e) {
    return { error: `语法错误：${e instanceof Error ? e.message : String(e)}` };
  }
  try {
    const out = fn(...BP_DSL_VALUES) as { pack?: BlueprintPack; compile?: (src: string) => unknown };
    const pack = out?.pack;
    if (!pack || typeof pack !== 'object') return { error: 'pack 没有返回对象（是不是忘了 definePack？）' };
    if (typeof pack.endian !== 'string' || !pack.types || typeof pack.types !== 'object') {
      return { error: '返回值不像一个 pack：缺少 endian/types' };
    }
    return { pack, compile: out.compile };
  } catch (e) {
    return { error: `执行失败：${e instanceof Error ? e.message : String(e)}` };
  }
}

export function loadBlueprintPack(source: string): BPLoadResult {
  const c = compilePackSource(source);
  if (c.error) return { error: c.error, issues: [] };
  const ev = evaluateBlueprintPack(c.js!);
  if (ev.error || !ev.pack) return { error: ev.error ?? '无法加载 pack', issues: [] };
  const issues = validateBlueprintPack(ev.pack);
  const fatal = issues.find((p) => p.severity === 'error');
  return { pack: ev.pack, js: c.js, compile: ev.compile, issues, error: fatal?.message };
}
