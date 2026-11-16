import {
  type CType, type Endian, type Field, type GraphEdge, type GraphNode, type GraphResult,
  type LinkSpec, type Problem, type Project, type RecordDecl, type Schema,
  NODE_HEADER_H, NODE_MAX_ROWS, NODE_ROW_H, NODE_W,
} from './types';
import { compileExpr, type EvalContext, type EvalValue } from './expr';
import { Memory, toHex } from './mem';
import { sizeOfType } from './cparse';

export const nodeKey = (addr: number, type: string): string => `${addr}:${type}`;
export const ghostKey = (addr: number, type: string): string => `ghost:${addr}:${type}`;

interface Ctx extends EvalContext {}

export function makeReadFunctions(mem: Memory, endian: Endian): Ctx['functions'] {
  const rd = (size: number, signed: boolean) => (a: EvalValue) =>
    mem.readUInt(Number(a), size, endian, signed);
  return {
    u8: rd(1, false), u16: rd(2, false), u32: rd(4, false), u64: rd(8, false),
    s8: rd(1, true), s16: rd(2, true), s32: rd(4, true), s64: rd(8, true),
    f32: (a: EvalValue) => mem.readFloat(Number(a), 4, endian),
    f64: (a: EvalValue) => mem.readFloat(Number(a), 8, endian),
    min: (a: EvalValue, b: EvalValue) => Math.min(Number(a), Number(b)),
    max: (a: EvalValue, b: EvalValue) => Math.max(Number(a), Number(b)),
    abs: (a: EvalValue) => Math.abs(Number(a)),
    idiv: (a: EvalValue, b: EvalValue) => Math.trunc(Number(a) / Number(b)),
  };
}

export function sizeofFn(schema: Schema) {
  return (name: EvalValue) => {
    const n = String(name);
    if (schema.records[n]) return schema.records[n].size;
    return sizeOfTypeImpl(schema, n);
  };
}

function sizeOfTypeImpl(schema: Schema, name: string): number {
  switch (name) {
    case 'u8': case 's8': case 'char': case 'bool': return 1;
    case 'u16': case 's16': case 'short': return 2;
    case 'u32': case 's32': case 'int': case 'float': return 4;
    case 'u64': case 's64': case 'double': case 'ptr': return schema.ptrSize;
    default: return 0;
  }
}

function charArrayToString(mem: Memory, addr: number, count: number): string {
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const b = mem.readUInt(addr + i, 1, 'little', false);
    if (b === 0) break;
    out.push(b);
  }
  return String.fromCharCode(...out);
}

function isPrintable(s: string): boolean {
  return s.length > 0 && Array.from(s).every((c) => {
    const code = c.charCodeAt(0);
    return code >= 32 && code < 127;
  });
}

export function formatScalar(field: Field, raw: unknown): string {
  if (raw == null) return '?';
  if (typeof raw === 'string') return isPrintable(raw) ? JSON.stringify(raw) : `"${raw.replace(/[^\x20-\x7e]/g, '.')}"`;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return String(raw);
    if (field.type.k === 'float') {
      return Number.isInteger(raw) ? raw.toFixed(1) : String(Number(raw.toPrecision(6)));
    }
    if (field.type.k === 'ptr' || field.link) return toHex(raw);
    return String(raw);
  }
  if (Array.isArray(raw)) {
    const head = raw.slice(0, 6).map((v) => (typeof v === 'number' ? String(v) : String(v)));
    return `[${head.join(', ')}${raw.length > 6 ? ', …' : ''}]`;
  }
  if (typeof raw === 'object') return '{…}';
  return String(raw);
}

/** Decode a field value (recursively, depth-limited). */
export function decodeField(
  mem: Memory, schema: Schema, rec: RecordDecl, field: Field, addr: number, depth = 0,
): EvalValue {
  const endian = field.endian ?? rec.endian ?? schema.endian;
  const at = addr + field.offset;
  try {
    if (field.derived) return null; // handled by caller with self context
    return decodeType(mem, schema, field.type, at, endian, depth, field.bitWidth, field.bitOffset);
  } catch {
    return null;
  }
}

function decodeType(
  mem: Memory, schema: Schema, t: CType, addr: number, endian: Endian, depth: number,
  bitWidth?: number, bitOffset?: number,
): EvalValue {
  switch (t.k) {
    case 'int': {
      if (bitWidth != null) {
        const unit = mem.readUInt(addr, t.size, endian, false);
        const shift = bitOffset ?? 0;
        let v = (unit >> shift) & (2 ** bitWidth - 1);
        if (t.signed && v >= 2 ** (bitWidth - 1)) v -= 2 ** bitWidth;
        return v;
      }
      if (t.size === 8) {
        const b = mem.readBig(addr, 8, endian, t.signed);
        return Number(b);
      }
      return mem.readUInt(addr, t.size, endian, t.signed);
    }
    case 'char': {
      const b = mem.readUInt(addr, 1, endian, t.signed);
      return b;
    }
    case 'bool': return mem.readUInt(addr, 1, endian, false) !== 0 ? 1 : 0;
    case 'float': return mem.readFloat(addr, t.size, endian);
    case 'ptr': return mem.readUInt(addr, t.size, endian, false);
    case 'array': {
      if (t.elem.k === 'char') return charArrayToString(mem, addr, t.count);
      const elemSize = sizeOfType(t.elem, schema);
      const out: EvalValue[] = [];
      const n = Math.min(t.count, 256);
      for (let i = 0; i < n; i++) {
        out.push(decodeType(mem, schema, t.elem, addr + i * elemSize, endian, depth + 1));
      }
      return out;
    }
    case 'record': {
      const sub = schema.records[t.name];
      if (!sub) return null;
      if (depth > 2) return '{…}';
      const obj: Record<string, EvalValue> = {};
      for (const f of sub.fields) {
        if (f.derived) continue;
        obj[f.name || '_'] = decodeType(mem, schema, f.type, addr + f.offset, f.endian ?? endian, depth + 1,
          f.bitWidth, f.bitOffset);
      }
      return obj;
    }
  }
}

/* ------------------------------------------------------------ graph build */

export interface BuildOptions {
  pinned?: Map<string, { x: number; y: number }>;
  maxNodes?: number;
}

interface QueueItem { addr: number; type: string; depth: number; rootId?: string; from?: { key: string; fieldId: string; spec: LinkSpec; raw: number } }

function evaluateRoot(
  expr: string, mem: Memory, schema: Schema, functions: Ctx['functions'],
): { value: number; error?: string } {
  const c = compileExpr(expr);
  if (c.error) return { value: NaN, error: c.error };
  try {
    const v = c.eval({
      vars: { base: mem.base, size: mem.size, end: mem.end, ptr: schema.ptrSize, ptrSize: schema.ptrSize },
      functions: { ...functions, sizeof: sizeofFn(schema) },
    });
    if (typeof v !== 'number') return { value: NaN, error: '不是数字' };
    return { value: v };
  } catch (e) {
    return { value: NaN, error: e instanceof Error ? e.message : String(e) };
  }
}

export function buildGraph(
  schema: Schema, project: Project, mem: Memory, opts: BuildOptions = {},
): GraphResult {
  const t0 = performance.now();
  const maxNodes = opts.maxNodes ?? 4000;
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const problems: Problem[] = [];
  let truncated = false;
  let seq = 0;

  const funcs = { ...makeReadFunctions(mem, schema.endian), sizeof: sizeofFn(schema) };
  const poolBases = new Map<string, number>();
  for (const pool of project.pools) {
    const r = evaluateRoot(pool.base, mem, schema, funcs);
    if (r.error) problems.push({ severity: 'error', message: `池 ${pool.name} 的 base 求值失败：${r.error}` });
    else poolBases.set(pool.name, r.value);
  }

  const queue: QueueItem[] = [];
  for (const root of project.roots) {
    const rec = schema.records[root.type];
    if (!rec) {
      problems.push({ severity: 'error', message: `根 ${root.label || root.id} 的类型 ${root.type} 不存在` });
      continue;
    }
    const r = evaluateRoot(root.addr, mem, schema, funcs);
    if (r.error) {
      problems.push({ severity: 'error', message: `根 ${root.label || root.id} 的地址求值失败：${r.error}` });
      continue;
    }
    const count = Math.max(1, root.count ?? 1);
    for (let i = 0; i < count; i++) {
      queue.push({ addr: r.value + i * rec.size, type: root.type, depth: 0, rootId: root.id });
    }
  }

  const makeNode = (addr: number, typeName: string, depth: number): GraphNode | null => {
    const rec = schema.records[typeName];
    if (!rec) return null;
    const key = nodeKey(addr, typeName);
    if (nodes.has(key)) return nodes.get(key)!;

    const inBounds = mem.contains(addr, Math.max(1, rec.size));
    const node: GraphNode = {
      key, addr, type: typeName, size: rec.size,
      values: {}, display: {}, links: [],
      depth, x: 0, y: 0, seq: seq++,
      height: NODE_HEADER_H + Math.min(rec.fields.length, NODE_MAX_ROWS) * NODE_ROW_H + 8,
    };

    if (!inBounds) {
      node.ghost = true;
      node.ghostReason = `地址 0x${addr.toString(16)} 不在缓冲区 [0x${mem.base.toString(16)}, 0x${mem.end.toString(16)}) 内`;
      node.height = NODE_HEADER_H + 2 * NODE_ROW_H + 8;
    } else {
      const self: Record<string, EvalValue> = {};
      for (const f of rec.fields) {
        if (f.derived) {
          const c = compileExpr(f.derived);
          let val: EvalValue = null;
          try {
            val = c.error ? null : c.eval({ vars: { ...self, self, addr, base: mem.base }, functions: funcs });
          } catch { val = null; }
          node.values[f.id] = val;
          self[f.name || '_'] = val;
          node.display[f.id] = formatScalar(f, val);
          continue;
        }
        const val = decodeField(mem, schema, rec, f, addr);
        node.values[f.id] = val;
        if (f.name) self[f.name] = val;
        node.display[f.id] = formatScalar(f, val);
      }
      node.values.__self = self as EvalValue;

      // link fields are declared in the project, keyed by `Record.field`
      for (const f of rec.fields) {
        const spec = project.links[`${rec.name}.${f.name}`];
        if (!spec) continue;
        const raw = node.values[f.id];
        const rawNum = typeof raw === 'number' ? raw : null;
        node.links.push({ fieldId: f.id, spec, raw: rawNum });
      }
    }

    nodes.set(key, node);
    return node;
  };

  const linkEnv = (node: GraphNode, raw: number, base: number, idx: number): Ctx => ({
    vars: {
      v: raw,
      self: (node.values.__self as EvalValue) ?? null,
      addr: node.addr,
      base,
      idx,
      ptr: schema.ptrSize,
      ptrSize: schema.ptrSize,
    },
    functions: funcs,
  });

  const visited = new Set<string>();

  while (queue.length) {
    const item = queue.shift()!;
    if (nodes.size >= maxNodes) { truncated = true; break; }
    const key = nodeKey(item.addr, item.type);
    if (visited.has(key)) continue;
    visited.add(key);

    const rec = schema.records[item.type];
    if (!rec) { problems.push({ severity: 'error', message: `未知类型 ${item.type}` }); continue; }
    const node = makeNode(item.addr, item.type, item.depth);
    if (!node) continue;
    if (item.rootId && !node.rootId) node.rootId = item.rootId;

    if (node.ghost) {
      if (item.from) {
        edges.push({
          id: `${item.from.key}->${key}:${item.from.fieldId}`,
          from: item.from.key, to: key, fieldId: item.from.fieldId,
          label: item.from.spec.target === '@abs' ? 'addr' : 'idx',
          kind: 'broken', value: item.from.raw,
        });
      }
      continue;
    }

    for (const lf of node.links) {
      const spec = lf.spec;
      const fieldName = rec.fields.find((f) => f.id === lf.fieldId)?.name ?? lf.fieldId;
      if (lf.raw == null) {
        problems.push({ severity: 'warn', nodeKey: node.key, fieldId: lf.fieldId, message: `${rec.name}.${fieldName} 不是数字，无法作为链接` });
        continue;
      }
      const raw = lf.raw;

      let targetAddr = NaN;
      let poolBase = 0;
      let typeName = spec.type || '';

      if (spec.target !== '@abs') {
        const pool = project.pools.find((p) => p.name === spec.target);
        if (!pool) {
          problems.push({ severity: 'error', nodeKey: node.key, fieldId: lf.fieldId, message: `链接目标池 ${spec.target} 不存在` });
          continue;
        }
        typeName = typeName || pool.type;
        poolBase = poolBases.get(pool.name) ?? NaN;
        if (raw < 0) {
          edges.push({ id: `${node.key}->null:${lf.fieldId}`, from: node.key, to: '', fieldId: lf.fieldId, label: fieldName, kind: 'null', value: raw });
          continue;
        }
        targetAddr = poolBase + raw * pool.stride;
      } else {
        if (raw === 0 || raw < 0) {
          edges.push({ id: `${node.key}->null:${lf.fieldId}`, from: node.key, to: '', fieldId: lf.fieldId, label: fieldName, kind: 'null', value: raw });
          continue;
        }
        targetAddr = raw;
        typeName = typeName || (rec.fields.find((f) => f.id === lf.fieldId)?.type.k === 'record'
          ? (rec.fields.find((f) => f.id === lf.fieldId)!.type as Extract<CType, { k: 'record' }>).name
          : '');
        if (!typeName) {
          problems.push({ severity: 'error', nodeKey: node.key, fieldId: lf.fieldId, message: `${rec.name}.${fieldName} 指向绝对地址，但未指定目标类型` });
          continue;
        }
      }

      // evaluate expression on top of raw value
      let value = raw;
      if (spec.expr.trim()) {
        const c = compileExpr(spec.expr);
        if (c.error) {
          problems.push({ severity: 'error', nodeKey: node.key, fieldId: lf.fieldId, message: `表达式错误：${c.error}` });
          continue;
        }
        try {
          const v = c.eval(linkEnv(node, raw, poolBase, raw));
          if (typeof v !== 'number') {
            problems.push({ severity: 'error', nodeKey: node.key, fieldId: lf.fieldId, message: '链接表达式结果不是数字' });
            continue;
          }
          value = v;
        } catch (e) {
          problems.push({ severity: 'error', nodeKey: node.key, fieldId: lf.fieldId, message: `表达式求值失败：${(e as Error).message}` });
          continue;
        }
      }

      if (spec.target !== '@abs') {
        if (value < 0) {
          edges.push({ id: `${node.key}->null:${lf.fieldId}`, from: node.key, to: '', fieldId: lf.fieldId, label: fieldName, kind: 'null', value });
          continue;
        }
        const pool = project.pools.find((p) => p.name === spec.target)!;
        if (value >= pool.count) {
          const addr = poolBase + value * pool.stride;
          const gk = ghostKey(addr, typeName);
          const ghost = makeNode(addr, typeName, node.depth + 1);
          if (ghost) ghost.ghostReason = `下标 ${value} 超出池 ${pool.name} 范围 [0, ${pool.count})`;
          edges.push({ id: `${node.key}->${gk}:${lf.fieldId}`, from: node.key, to: gk, fieldId: lf.fieldId, label: fieldName, kind: 'broken', value });
          problems.push({
            severity: 'error', nodeKey: node.key, fieldId: lf.fieldId,
            message: `${rec.name}.${fieldName} → 下标 ${value} 越界（池 ${pool.name} 长度 ${pool.count}）`,
          });
          continue;
        }
        targetAddr = poolBase + value * pool.stride;
      } else {
        if (value === 0 || value < 0) {
          edges.push({ id: `${node.key}->null:${lf.fieldId}`, from: node.key, to: '', fieldId: lf.fieldId, label: fieldName, kind: 'null', value });
          continue;
        }
        targetAddr = value;
      }

      const tKey = nodeKey(targetAddr, typeName);
      const existing = nodes.get(tKey);
      let kind: GraphEdge['kind'] = 'link';
      if (existing) {
        if (existing.depth <= node.depth) kind = 'cycle';
      } else if (!mem.contains(targetAddr, Math.max(1, schema.records[typeName]?.size ?? 1))) {
        const ghost = makeNode(targetAddr, typeName, node.depth + 1);
        if (ghost) ghost.ghostReason = `目标地址 0x${targetAddr.toString(16)} 越界（缓冲区 0x${mem.base.toString(16)}–0x${mem.end.toString(16)}）`;
        edges.push({ id: `${node.key}->${ghostKey(targetAddr, typeName)}:${lf.fieldId}`, from: node.key, to: ghostKey(targetAddr, typeName), fieldId: lf.fieldId, label: fieldName, kind: 'broken', value });
        problems.push({
          severity: 'error', nodeKey: node.key, fieldId: lf.fieldId,
          message: `${rec.name}.${fieldName} → 0x${targetAddr.toString(16)} 越界`,
          detail: `缓冲区范围 0x${mem.base.toString(16)}–0x${mem.end.toString(16)}`,
        });
        continue;
      }

      edges.push({ id: `${node.key}->${tKey}:${lf.fieldId}`, from: node.key, to: tKey, fieldId: lf.fieldId, label: fieldName, kind, value });
      if (!existing) queue.push({ addr: targetAddr, type: typeName, depth: node.depth + 1 });
    }
  }

  const list = [...nodes.values()];
  layoutGraph(list, opts.pinned);

  return {
    nodes: list,
    edges,
    problems,
    truncated,
    stats: { nodes: list.length, edges: edges.length, ms: Math.round(performance.now() - t0) },
  };
}

/* ----------------------------------------------------------------- layout */

export function layoutGraph(nodes: GraphNode[], pinned?: Map<string, { x: number; y: number }>): void {
  const cols = new Map<number, GraphNode[]>();
  for (const n of nodes) {
    if (pinned?.has(n.key)) {
      const p = pinned.get(n.key)!;
      n.x = p.x; n.y = p.y; n.pinned = true;
      continue;
    }
    const arr = cols.get(n.depth) ?? [];
    arr.push(n);
    cols.set(n.depth, arr);
  }
  const depths = [...cols.keys()].sort((a, b) => a - b);
  for (const d of depths) {
    const arr = cols.get(d)!;
    arr.sort((a, b) => a.seq - b.seq);
    const x = 40 + d * (NODE_W + 160);
    let y = 40;
    for (const n of arr) {
      n.x = x;
      n.y = y;
      y += n.height + 24;
    }
  }
}
