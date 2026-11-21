/**
 * One structure registry for document layouts and enabled pack types.
 *
 * `structureId` is the only handle: `layout/<id>` or
 * `pack/<encodedPackId>/<encodedTypeName>`. There is no fallback by display
 * name or "first type with this name".
 */

import type { TypeDef } from '../core/pack';
import { relayoutType } from '../core/pack';
import { fieldPorts, type BlueprintPack, type BufferValue, type InstanceView, type NodeDef, type PortSpec, type Truncation } from './types';
import { compileLayout, layoutPorts, MAX_FIELD_BYTES, readLayout, readTypeStructure, type BinaryLayout, type CompiledLayout } from './layouts';
import { addOffset, integerInput, ReadIssue } from './binary-read';
import { addressHex, MAX_ADDRESS, offsetIn } from './precision';

export interface StructureEntry {
  id: string;
  name: string;
  source: 'layout' | 'pack';
  size: number;
  type: TypeDef;
  layout?: BinaryLayout;
  pack?: BlueprintPack;
  error?: string;
  packId?: string;
  typeName?: string;
}

export interface StructureRegistry {
  layouts: Map<string, BinaryLayout>;
  packs: Map<string, BlueprintPack>;
  entries: Map<string, StructureEntry>;
  packErrors: Map<string, string>;
  layout(id: string): BinaryLayout | undefined;
  get(id: string): StructureEntry | undefined;
  list(): StructureEntry[];
}

const encodeId = (value: string) => encodeURIComponent(value);

export const layoutStructureId = (id: string) => `layout/${id}`;
export const packStructureId = (packId: string, typeName: string) =>
  `pack/${encodeId(packId)}/${encodeId(typeName)}`;

export function layoutIdFromStructureId(id: string): string | undefined {
  return id.startsWith('layout/') ? id.slice('layout/'.length) : undefined;
}

const packCache = new WeakMap<BlueprintPack, { rev: string; value: BlueprintPack }>();

function layoutRev(layouts: ReadonlyMap<string, BinaryLayout>): string {
  return [...layouts.values()].map(l => `${l.id}:${JSON.stringify(l)}`).join('|');
}

export function compileFor(id: string, layoutMap: ReadonlyMap<string, BinaryLayout>, stack: Set<string> = new Set()): CompiledLayout {
  const rawId = id.startsWith('layout/') ? id.slice('layout/'.length) : id;
  const layout = layoutMap.get(rawId);
  if (!layout) throw new Error(`结构布局不存在：${id}`);
  return compileLayout(layout, (nested) => layoutMap.get(nested), stack);
}

function resolveType(type: TypeDef, layoutMap: ReadonlyMap<string, BinaryLayout>, pointerSize: 4 | 8, stack: Set<string>): TypeDef {
  if (type.ref) {
    if (stack.has(type.ref.id)) throw new Error(`布局引用成环：${type.ref.id}`);
    stack.add(type.ref.id);
    try {
      return compileFor(type.ref.id, layoutMap).type;
    } finally {
      stack.delete(type.ref.id);
    }
  }
  const fields = type.fields.map((f) => {
    if (!f.ofType) return f;
    return { ...f, ofType: resolveType(f.ofType, layoutMap, pointerSize, stack), size: f.size === 0 ? undefined : f.size };
  });
  const byIndex = new Map(type.fields.map((f, i) => [f, fields[i]]));
  const layoutFields = type.layoutFields?.map(item => '__op' in item ? item : (byIndex.get(item) ?? item));
  const next: TypeDef = { ...type, fields, ...(layoutFields ? { layoutFields } : {}) };
  // Layout refs have been replaced; the auto layout can now be finalized.
  next.hasLayoutRef = false;
  return relayoutType(next, pointerSize);
}

/** Materialize layout references and auto offsets for one pack. */
export function materializePack(
  pack: BlueprintPack,
  layoutMap: ReadonlyMap<string, BinaryLayout>,
): BlueprintPack {
  const rev = layoutRev(layoutMap);
  const hit = packCache.get(pack);
  if (hit?.rev === rev) return hit.value;

  const stack = new Set<string>();
  const types: Record<string, TypeDef> = {};
  for (const [name, type] of Object.entries(pack.types)) {
    types[name] = resolveType(type, layoutMap, pack.pointerSize, stack);
  }
  const nodes: Record<string, NodeDef> = {};
  for (const [key, def] of Object.entries(pack.nodes)) {
    nodes[key] = def.kind === 'calc'
      ? def
      : { ...def, type: resolveType(def.type, layoutMap, pack.pointerSize, stack) };
  }
  const value: BlueprintPack = { ...pack, types, nodes };
  packCache.set(pack, { rev, value });
  return value;
}

export function buildStructureRegistry(
  layouts: readonly BinaryLayout[],
  packs: ReadonlyMap<string, BlueprintPack>,
): StructureRegistry {
  const layoutMap = new Map(layouts.map(l => [l.id, l]));
  const materialized = new Map<string, BlueprintPack>();
  const packErrors = new Map<string, string>();
  for (const [id, pack] of packs) {
    try {
      materialized.set(id, materializePack(pack, layoutMap));
    } catch (err) {
      packErrors.set(id, err instanceof Error ? err.message : String(err));
      materialized.set(id, pack);
    }
  }

  const entries = new Map<string, StructureEntry>();
  for (const layout of layouts) {
    const id = layoutStructureId(layout.id);
    try {
      const compiled = compileFor(layout.id, layoutMap);
      entries.set(id, {
        id, name: layout.name, source: 'layout', size: compiled.size,
        type: compiled.type, layout,
      });
    } catch {
      // Invalid layouts stay selectable by id; the node reports the compile
      // error with the exact field. An empty entry would be a fake structure.
      entries.set(id, {
        id, name: layout.name, source: 'layout', size: 0,
        type: { name: layout.name, size: 0, fields: [] }, layout,
      });
    }
  }
  for (const [packId, pack] of materialized) {
    for (const [typeName, type] of Object.entries(pack.types)) {
      const id = packStructureId(packId, typeName);
      const error = packErrors.get(packId);
      entries.set(id, {
        id, name: typeName, source: 'pack', size: type.size, type, pack,
        packId, typeName, ...(error ? { error } : {}),
      });
    }
  }
  const list = [...entries.values()].sort((a, b) => a.source.localeCompare(b.source) || a.name.localeCompare(b.name));
  return {
    layouts: layoutMap,
    packs: materialized,
    entries,
    packErrors,
    layout: (id) => layoutMap.get(id),
    get: (id) => entries.get(id),
    list: () => list,
  };
}

export function structurePorts(entry: StructureEntry): PortSpec[] {
  if (entry.layout) return layoutPorts(entry.layout);
  return fieldPorts(entry.type);
}

export function readStructureEntry(
  entry: StructureEntry,
  registry: StructureRegistry,
  src: BufferValue,
  at: bigint,
  index?: number,
): InstanceView {
  if (entry.error) throw new ReadIssue('INVALID_LAYOUT', entry.error);
  if (entry.layout) {
    return readLayout(src, at, compileFor(entry.layout.id, registry.layouts), index);
  }
  if (entry.pack) {
    return readTypeStructure(src, at, entry.type, entry.id, entry.pack, index);
  }
  throw new Error(`结构 ${entry.id} 没有可用的解码来源`);
}

const ITEM_LIMIT = 4096;

export interface StructureWalk {
  items: InstanceView[];
  stop: 'complete' | 'limit' | 'cycle' | 'unreadable';
  notice?: ReadIssue;
  trunc?: Truncation;
}

function budget(size: number, configured = ITEM_LIMIT): number {
  return Math.min(configured, ITEM_LIMIT, Math.floor(MAX_FIELD_BYTES / Math.max(1, size)));
}

export function expandEntryArray(
  src: BufferValue,
  start: bigint,
  count: bigint,
  stride: bigint | undefined,
  entry: StructureEntry,
  registry: StructureRegistry,
): StructureWalk {
  const width = entry.size;
  if (!Number.isSafeInteger(width) || width < 1) throw new ReadIssue('BAD_INPUT', '元素需要固定宽度');
  const step = stride ?? BigInt(width);
  const items: InstanceView[] = [];
  const limit = budget(width);
  try {
    let i = 0;
    for (; i < limit && BigInt(i) < count; i += 1) {
      items.push(readStructureEntry(entry, registry, src, addOffset(start, BigInt(i) * step), i));
    }
    if (BigInt(i) === count) return { items, stop: 'complete' };
    return {
      items, stop: 'limit', trunc: { at: i, unit: 'index', limit, canContinue: true },
      notice: new ReadIssue('TRUNCATED', `达到读取预算，从第 ${i} 项截断`),
    };
  } catch (err) {
    if (!(err instanceof ReadIssue)) throw err;
    return { items, stop: 'unreadable', notice: err };
  }
}

export function walkEntryList(
  src: BufferValue,
  entry: StructureEntry,
  registry: StructureRegistry,
  config: {
    start: bigint; nextField: string; stopValue: bigint; max: number;
    pool?: { base: bigint; stride: bigint };
  },
): StructureWalk {
  const field = entry.type.fields.find(f => f.name === config.nextField);
  if (!field || !/^(?:[ui]\d+|bits)$/.test(field.kind)) {
    throw new ReadIssue('INVALID_LAYOUT', 'next 必须绑定布局中的整数字段');
  }
  if (field.role && field.role !== (config.pool ? 'index' : 'address')) {
    throw new ReadIssue('INVALID_LAYOUT', 'next 字段语义与推进方式不一致');
  }
  const items: InstanceView[] = [];
  const visited = new Set<bigint>();
  const limit = budget(entry.size, config.max);
  let at = config.start;
  try {
    for (;;) {
      if (visited.has(at)) return { items, stop: 'cycle', notice: new ReadIssue('RECORD_CYCLE', `链表成环：${addressHex(at)}`, at) };
      if (offsetIn(src, at, entry.size) === undefined) throw new ReadIssue('OUT_OF_BOUNDS', `记录 ${addressHex(at)} 的字节不可用`, at);
      if (items.length === limit) {
        return {
          items, stop: 'limit', trunc: { at, unit: 'address', limit, canContinue: true },
          notice: new ReadIssue('TRUNCATED', `达到读取上限，从 ${addressHex(at)} 截断`, at),
        };
      }
      visited.add(at);
      const item = readStructureEntry(entry, registry, src, at, items.length);
      items.push(item);
      const portName = entry.layout ? `field:${entry.id}:${config.nextField}` : config.nextField;
      const view = item.fields.find(f => f.name === portName);
      if (!view) throw new ReadIssue('INVALID_LAYOUT', `缺少 next 字段：${config.nextField}`);
      const next = integerInput(view.raw, 'next');
      if (next === config.stopValue) return { items, stop: 'complete' };
      at = config.pool
        ? addOffset(config.pool.base, integerInput(next, 'next 池下标', 0n) * config.pool.stride)
        : integerInput(next, 'next 地址', 0n, MAX_ADDRESS);
    }
  } catch (err) {
    if (!(err instanceof ReadIssue)) throw err;
    return { items, stop: 'unreadable', notice: err };
  }
}

export function emptyStructureRegistry(): StructureRegistry {
  return buildStructureRegistry([], new Map());
}
