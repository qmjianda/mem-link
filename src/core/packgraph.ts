/**
 * Walk a binary buffer using a TypeScript pack: decode fields, run transforms,
 * follow transformed values as addresses, and produce the same GraphResult the
 * canvas already understands.
 */

import {
  fieldId, fieldSize, kindSize, packToSchema, nodeHeight,
  type FieldDef, type MemApi, type Pack, type TransformCtx, type TypeDef,
} from './pack';
import { NODE_W } from './types';
import { Memory, toHex } from './mem';
import {
  type Endian, type GraphEdge, type GraphNode, type GraphResult, type Problem,
} from './types';

const NODE_MAX_ROWS = 16;

/* ------------------------------------------------------------------ mem api */

function textOf(bytes: Uint8Array, stopAtNul: boolean): string {
  let end = bytes.length;
  if (stopAtNul) {
    const i = bytes.indexOf(0);
    if (i >= 0) end = i;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, end));
  } catch {
    return String.fromCharCode(...bytes.subarray(0, end));
  }
}

export function packMemApi(mem: Memory): MemApi {
  return {
    u8: (a) => mem.readUInt(a, 1, 'little', false),
    u16: (a) => mem.readUInt(a, 2, 'little', false),
    u32: (a) => mem.readUInt(a, 4, 'little', false),
    u64: (a) => Number(mem.readBig(a, 8, 'little', false)),
    i8: (a) => mem.readUInt(a, 1, 'little', true),
    i16: (a) => mem.readUInt(a, 2, 'little', true),
    i32: (a) => mem.readUInt(a, 4, 'little', true),
    i64: (a) => Number(mem.readBig(a, 8, 'little', true)),
    f32: (a) => mem.readFloat(a, 4, 'little'),
    f64: (a) => mem.readFloat(a, 8, 'little'),
    bytes: (a, len) => mem.bytesAt(a, len).slice(),
    str: (a, len) => textOf(mem.bytesAt(a, len), false),
    cstr: (a, max = 256) => textOf(mem.bytesAt(a, Math.min(max, mem.end - a)), true),
    inBounds: (a, len = 1) => mem.contains(a, len),
  };
}

/* ------------------------------------------------------------------- decode */

function endianOf(pack: Pack, f: FieldDef): Endian {
  return f.endian ?? pack.endian;
}

export function decodeFieldRaw(
  mem: Memory, pack: Pack, type: TypeDef, f: FieldDef, addr: number, depth = 0,
): unknown {
  const at = addr + f.offset;
  const endian = endianOf(pack, f);
  switch (f.kind) {
    case 'u8': return mem.readUInt(at, 1, endian, false);
    case 'u16': return mem.readUInt(at, 2, endian, false);
    case 'u32': return mem.readUInt(at, 4, endian, false);
    case 'u64': return Number(mem.readBig(at, 8, endian, false));
    case 'i8': return mem.readUInt(at, 1, endian, true);
    case 'i16': return mem.readUInt(at, 2, endian, true);
    case 'i32': return mem.readUInt(at, 4, endian, true);
    case 'i64': return Number(mem.readBig(at, 8, endian, true));
    case 'f32': return mem.readFloat(at, 4, endian);
    case 'f64': return mem.readFloat(at, 8, endian);
    case 'bool': return mem.readUInt(at, 1, endian, false) !== 0;
    case 'char': return String.fromCharCode(mem.readUInt(at, 1, endian, false));
    case 'ptr': return Number(mem.readBig(at, pack.pointerSize, endian, false));
    case 'bits': {
      const size = fieldSize(f, pack);
      const b = f.bits!;
      const raw = mem.readBig(at, size, endian, false);
      const width = BigInt(b.width);
      const shift = endian === 'little'
        ? BigInt(b.offset)
        : BigInt(size * 8 - b.offset - b.width);
      let v = Number((raw >> shift) & ((1n << width) - 1n));
      if (b.signed && v >= 2 ** (b.width - 1)) v -= 2 ** b.width;
      return v;
    }
    case 'string': return textOf(mem.bytesAt(at, f.count ?? 0), true);
    case 'bytes': return mem.bytesAt(at, f.count ?? 0).slice();
    case 'record': {
      if (depth >= 3) return { '…': true };
      const t = pack.types.find((x) => x.name === f.of);
      if (!t) return null;
      return decodeRecord(mem, pack, t, at, depth + 1);
    }
    case 'array': {
      const n = f.count ?? 0;
      const elemType = pack.types.find((x) => x.name === f.of);
      const es = elemType ? elemType.size : kindSize((f.of ?? 'u8') as FieldDef['kind'], pack.pointerSize);
      const out: unknown[] = [];
      for (let i = 0; i < n; i++) {
        if (elemType) {
          out.push(depth >= 3 ? { '…': true } : decodeRecord(mem, pack, elemType, at + i * es, depth + 1));
        } else {
          out.push(decodeScalar(mem, pack, f.of ?? 'u8', at + i * es, endian));
        }
      }
      return out;
    }
    default: return null;
  }
}

function decodeScalar(mem: Memory, pack: Pack, kind: string, at: number, endian: Endian): unknown {
  const f = { name: '', offset: 0, kind: kind as FieldDef['kind'], endian } as FieldDef;
  return decodeFieldRaw(mem, pack, { name: '', size: 0, fields: [] }, f, at);
}

export function decodeRecord(
  mem: Memory, pack: Pack, type: TypeDef, addr: number, depth = 0,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of type.fields) {
    out[f.name] = decodeFieldRaw(mem, pack, type, f, addr, depth);
  }
  return out;
}

/* ------------------------------------------------------------------ format */

function isPrintable(s: string): boolean {
  return s.length > 0 && Array.from(s).every((c) => {
    const code = c.charCodeAt(0);
    return code >= 32 && code < 127;
  });
}

export function formatPackValue(f: FieldDef, v: unknown): string {
  if (v == null) return '∅ null';
  if (typeof v === 'string') return isPrintable(v) ? JSON.stringify(v) : `"${v.replace(/[^\x20-\x7e]/g, '.')}"`;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return String(v);
    switch (f.format) {
      case 'hex': return toHex(v);
      case 'bin': return `${v < 0 ? '-' : ''}0b${Math.abs(Math.trunc(v)).toString(2)}`;
      case 'time': return new Date(v * 1000).toISOString().replace('T', ' ').slice(0, 19);
      case 'timeMs': return new Date(v).toISOString().replace('T', ' ').slice(0, 19);
      case 'char': return JSON.stringify(String.fromCharCode(v));
      default:
        if (f.kind === 'f32' || f.kind === 'f64') {
          return Number.isInteger(v) ? v.toFixed(1) : String(Number(v.toPrecision(7)));
        }
        return String(v);
    }
  }
  if (v instanceof Uint8Array) {
    const head = Array.from(v.slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join(' ');
    return `⟨${head}${v.length > 8 ? ' …' : ''}⟩`;
  }
  if (Array.isArray(v)) {
    const head = v.slice(0, 4).map((x) => (typeof x === 'number' ? String(x) : typeof x === 'string' ? JSON.stringify(x) : '{…}'));
    return `[${head.join(', ')}${v.length > 4 ? ', …' : ''}]`;
  }
  return '{…}';
}

/* ------------------------------------------------------------------- graph */

export interface PackBuildOptions {
  pinned?: Map<string, { x: number; y: number }>;
  maxNodes?: number;
  /** report transforms that throw as problems instead of silently showing null */
  strictTransforms?: boolean;
}

interface QueueItem {
  addr: number;
  type: string;
  depth: number;
  rootId?: string;
  from?: { key: string; fieldId: string; label: string; raw: unknown };
}

export function buildPackGraph(
  pack: Pack, mem: Memory, opts: PackBuildOptions = {},
): GraphResult {
  const t0 = performance.now();
  const maxNodes = opts.maxNodes ?? 4000;
  const typeMap = new Map(pack.types.map((t) => [t.name, t]));
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const problems: Problem[] = [];
  let truncated = false;
  let seq = 0;

  const api = packMemApi(mem);
  const keyOf = (addr: number, type: string) => `${addr}:${type}`;
  const ghostKeyOf = (addr: number, type: string) => `ghost:${addr}:${type}`;

  // Roots are expanded one at a time: the first root that reaches an address
  // owns its depth. This keeps program-added roots from promoting nodes that
  // are already reachable from a structural root.
  const pendingRoots: Array<{ addr: number; type: string }> = [];
  for (const root of pack.roots) {
    const t = typeMap.get(root.type);
    if (!t) {
      problems.push({ severity: 'error', message: `根节点类型 ${root.type} 不存在` });
      continue;
    }
    if (!Number.isFinite(root.address) || root.address < 0) {
      problems.push({ severity: 'error', message: `根节点 ${root.type} 的地址无效` });
      continue;
    }
    pendingRoots.push({ addr: root.address, type: root.type });
  }

  const makeNode = (addr: number, typeName: string, depth: number, ghostReason?: string): GraphNode | null => {
    const t = typeMap.get(typeName);
    if (!t) return null;
    const key = ghostReason ? ghostKeyOf(addr, typeName) : keyOf(addr, typeName);
    const existing = nodes.get(key);
    if (existing) return existing;

    const node: GraphNode = {
      key, addr, type: typeName, size: t.size,
      values: {}, rawValues: {}, display: {}, links: [],
      depth, x: 0, y: 0, seq: seq++,
      height: nodeHeight(t),
    };

    const inBounds = Number.isFinite(addr) && mem.contains(addr, Math.max(1, t.size));
    if (!inBounds || ghostReason) {
      node.ghost = true;
      node.ghostReason = ghostReason
        ?? `地址 0x${addr.toString(16)} 不在缓冲区 [0x${mem.base.toString(16)}, 0x${mem.end.toString(16)}) 内`;
      node.height = 34 + 2 * 21 + 8;
      problems.push({
        severity: 'error',
        nodeKey: key,
        message: `${typeName} 地址未映射`,
        detail: node.ghostReason,
      });
      nodes.set(key, node);
      return node;
    }

    const rawSelf: Record<string, unknown> = {};
    const transformedSelf: Record<string, unknown> = {};

    // Pass 1: decode every field, so transforms can read any sibling by name.
    for (const f of t.fields) {
      const id = fieldId(t.name, f.name);
      try {
        const raw = decodeFieldRaw(mem, pack, t, f, addr);
        rawSelf[f.name] = raw;
        node.rawValues![id] = raw;
      } catch (e) {
        problems.push({
          severity: 'error', nodeKey: key, fieldId: id,
          message: `${t.name}.${f.name} 读取失败：${e instanceof Error ? e.message : String(e)}`,
        });
        rawSelf[f.name] = null;
        node.rawValues![id] = null;
      }
    }

    // Pass 2: apply transforms against the complete raw record.
    for (const f of t.fields) {
      const id = fieldId(t.name, f.name);
      const raw = rawSelf[f.name];
      let value: unknown = raw;
      if (f.transform && raw !== null) {
        const ctx: TransformCtx = {
          v: raw,
          addr: addr + f.offset,
          self: rawSelf,
          mem: api,
          consts: pack.constants,
          type: t.name,
          field: f.name,
        };
        try {
          value = f.transform(raw, ctx);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          node.transformErrors = node.transformErrors ?? {};
          node.transformErrors[id] = msg;
          value = null;
          if (opts.strictTransforms) {
            problems.push({ severity: 'error', nodeKey: key, fieldId: id, message: `${t.name}.${f.name} 转换失败：${msg}` });
          }
        }
      }
      node.values[id] = value;
      transformedSelf[f.name] = value;

      const rawText = formatPackValue(f, raw);
      const valueText = (f.follow || f.transform) && typeof value === 'number'
        ? toHex(value)
        : formatPackValue(f, value);
      node.display[id] = f.transform && rawText !== valueText
        ? `${rawText} → ${valueText}`
        : valueText;

      if (f.follow) {
        node.links.push({
          fieldId: id,
          spec: { target: '@abs', expr: 'v', type: f.follow === 'self' ? t.name : f.follow },
          raw: typeof value === 'number' ? value : null,
        });
      }
    }

    node.values.__self = transformedSelf;
    node.rawValues!.__self = rawSelf;
    nodes.set(key, node);
    return node;
  };

  while (pendingRoots.length && !truncated) {
    const queue: QueueItem[] = [{ ...pendingRoots.shift()!, depth: 0 }];
    while (queue.length) {
      if (nodes.size >= maxNodes) { truncated = true; break; }
      const item = queue.shift()!;
      const key = keyOf(item.addr, item.type);
      if (nodes.has(key)) {
        // Already materialized; still connect the incoming edge.
        const n = nodes.get(key)!;
        if (item.from) {
          const cycle = n.depth <= item.depth;
          edges.push({
            id: `${item.from.key}->${key}:${item.from.fieldId}`,
            from: item.from.key, to: key, fieldId: item.from.fieldId,
            label: item.from.label,
            kind: cycle ? 'cycle' : 'link',
            value: typeof item.from.raw === 'number' ? item.from.raw : null,
          });
        }
        continue;
      }
  
      const node = makeNode(item.addr, item.type, item.depth);
      if (!node) {
        problems.push({ severity: 'error', message: `类型 ${item.type} 不存在` });
        continue;
      }
      if (item.rootId && !node.rootId) node.rootId = item.rootId;
  
      if (item.from) {
        edges.push({
          id: `${item.from.key}->${node.key}:${item.from.fieldId}`,
          from: item.from.key, to: node.key, fieldId: item.from.fieldId,
          label: item.from.label,
          kind: node.ghost ? 'broken' : 'link',
          value: typeof item.from.raw === 'number' ? item.from.raw : null,
        });
      }
      if (node.ghost) continue;
  
      const t = typeMap.get(node.type)!;
      for (const f of t.fields) {
        if (!f.follow) continue;
        const id = fieldId(t.name, f.name);
        const value = node.values[id];
        const label = f.label || f.name;
  
        if (value == null) {
          edges.push({
            id: `${node.key}->null:${id}`, from: node.key, to: '', fieldId: id,
            label, kind: 'null', value: null,
          });
          continue;
        }
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          problems.push({
            severity: 'error', nodeKey: node.key, fieldId: id,
            message: `${t.name}.${f.name} 的 follow 值不是有效地址：${String(value)}`,
          });
          continue;
        }
        const targetType = f.follow === 'self' ? t.name : f.follow;
        if (!typeMap.has(targetType)) {
          problems.push({
            severity: 'error', nodeKey: node.key, fieldId: id,
            message: `${t.name}.${f.name} 的 follow 类型 ${targetType} 不存在`,
          });
          continue;
        }
        if (value < 0) {
          edges.push({
            id: `${node.key}->null:${id}`, from: node.key, to: '', fieldId: id,
            label, kind: 'null', value,
          });
          continue;
        }
        const targetKey = keyOf(value, targetType);
        const existing = nodes.get(targetKey);
        if (existing) {
          edges.push({
            id: `${node.key}->${targetKey}:${id}`, from: node.key, to: targetKey, fieldId: id,
            label, kind: existing.depth <= node.depth ? 'cycle' : 'link', value,
          });
          continue;
        }
        queue.push({
          addr: value, type: targetType, depth: node.depth + 1,
          from: { key: node.key, fieldId: id, label, raw: value },
        });
      }
    }
  }

  const list = [...nodes.values()];
  layout(list, opts.pinned);

  return {
    nodes: list,
    edges,
    problems,
    truncated,
    stats: { nodes: list.length, edges: edges.length, ms: Math.round(performance.now() - t0) },
  };
}

/* ------------------------------------------------------------------ layout */

export function layout(nodes: GraphNode[], pinned?: Map<string, { x: number; y: number }>): void {
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
      n.x = x; n.y = y;
      y += n.height + 24;
    }
  }
}

/** Convenience for the UI: a synthetic schema for canvas/inspector rendering. */
export function packGraphSchema(pack: Pack) {
  return packToSchema(pack);
}

export { NODE_MAX_ROWS };
