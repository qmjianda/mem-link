/**
 * mem-link / pack
 *
 * One structure DSL: fields are laid out in declaration order, `at` anchors a
 * byte offset, and types are referenced directly. The runtime never parses C;
 * C constructs are represented as the resolved byte layout.
 */

import type { Endian } from './types';

/* ------------------------------------------------------------------ types */

export type FieldKind =
  | 'u8' | 'u16' | 'u32' | 'u64'
  | 'i8' | 'i16' | 'i32' | 'i64'
  | 'f32' | 'f64'
  | 'bool' | 'char' | 'ptr'
  | 'string' | 'bytes' | 'bits' | 'record' | 'array';

export interface MemApi {
  u8(addr: number): number;
  u16(addr: number): number;
  u32(addr: number): number;
  u64(addr: number): number;
  i8(addr: number): number;
  i16(addr: number): number;
  i32(addr: number): number;
  i64(addr: number): number;
  f32(addr: number): number;
  f64(addr: number): number;
  bytes(addr: number, len: number): Uint8Array;
  str(addr: number, len: number): string;
  cstr(addr: number, max?: number): string;
  inBounds(addr: number, len?: number): boolean;
}

export interface TransformCtx {
  /** raw decoded value */
  v: unknown;
  /** absolute address of the field */
  addr: number;
  /** decoded sibling fields of the same record, by field name */
  self: Record<string, unknown>;
  mem: MemApi;
  consts: Record<string, number>;
  type: string;
  field: string;
}

export type TransformFn = (v: unknown, ctx: TransformCtx) => unknown;

export interface FieldOpts {
  /** byte offset anchor; omitted means "place at the current cursor" */
  at?: number;
  /** byte length for string / bytes; optional size override for other kinds */
  size?: number;
  endian?: Endian;
  format?: string;
  label?: string;
  /** numeric value → display label; display only, never changes the value */
  values?: Record<string, string>;
  /** numeric semantics used for ports and downstream UI */
  role?: 'address' | 'offset' | 'index';
  signed?: boolean;
  transform?: TransformFn;
}

export interface BitOpts extends FieldOpts {
  /** bit offset inside the storage unit */
  bit?: number;
  /** storage unit bytes: 1, 2, 4 or 8 */
  unit?: 1 | 2 | 4 | 8;
}

export type LayoutOp =
  | { __op: 'pad'; n: number }
  | { __op: 'align'; n: number };

export interface FieldDef {
  name: string;
  kind: FieldKind;
  /** undefined = auto layout; a number = anchored byte offset */
  offset?: number;
  /** true when the author supplied at; auto fields are re-flowed on materialize */
  anchored?: boolean;
  /** explicit byte size (required for string / bytes; optional override) */
  size?: number;
  /** element count for array */
  count?: number;
  /** type name for diagnostics, or scalar kind for array */
  of?: string;
  /** direct type reference for record / array */
  ofType?: TypeDef;
  bits?: { offset?: number; width: number; unit?: number; unitExplicit?: boolean; signed?: boolean };
  endian?: Endian;
  format?: string;
  label?: string;
  values?: Record<string, string>;
  role?: 'address' | 'offset' | 'index';
  transform?: TransformFn;
  signed?: boolean;
}

export interface TypeDef {
  name: string;
  size: number;
  union?: boolean;
  /** fields use the cursor rule; computed again when a layout reference is materialized */
  auto?: boolean;
  fields: FieldDef[];
  /** placeholder created by layoutType(id) */
  ref?: { kind: 'layout'; id: string };
  /** original declaration list, including pad/align instructions */
  layoutFields?: Array<FieldDef | LayoutOp>;
  /** true when a nested field references a document layout */
  hasLayoutRef?: boolean;
  /** explicit total length supplied by the author (preserved across re-layouts) */
  sizeExplicit?: number;
}

export interface RootDef {
  type: string;
  address: number;
  label?: string;
}

export type ProgramFn = (api: unknown) => void;
export interface ProgramDef {
  code: string;
  timeoutMs?: number;
}

export interface Pack {
  name: string;
  endian: Endian;
  pointerSize: 4 | 8;
  constants: Record<string, number>;
  types: TypeDef[];
  roots: RootDef[];
  program?: ProgramDef;
  /** original TS source, for re-export / debugging */
  source?: string;
}

export interface PackInput {
  name?: string;
  endian?: Endian;
  pointerSize?: 4 | 8;
  constants?: Record<string, number>;
  types: TypeDef[];
  roots?: RootDef[];
  program?: ProgramDef;
}

/* -------------------------------------------------------------- kind sizes */

const KIND_SIZE: Record<string, number> = {
  u8: 1, i8: 1, bool: 1, char: 1,
  u16: 2, i16: 2,
  u32: 4, i32: 4, f32: 4,
  u64: 8, i64: 8, f64: 8,
};

export function kindSize(kind: FieldKind, pointerSize: 4 | 8): number {
  if (kind === 'ptr') return pointerSize;
  return KIND_SIZE[kind] ?? 0;
}

const sizeBase = (pointerSize: 4 | 8) => ({ pointerSize, types: [] as TypeDef[] });

export function fieldSize(f: Pick<FieldDef, 'kind' | 'size' | 'count' | 'of' | 'ofType' | 'bits'>, pack?: { pointerSize: 4 | 8; types: TypeDef[] }): number {
  if (f.size != null) return f.size;
  if (f.kind === 'string' || f.kind === 'bytes') return f.count ?? 0;
  if (f.kind === 'bits') return f.bits?.unit ?? Math.ceil(((f.bits?.offset ?? 0) + (f.bits?.width ?? 0)) / 8);
  if (f.kind === 'record') return f.ofType?.size ?? 0;
  if (f.kind === 'array') {
    const elem = f.ofType?.size ?? (f.of ? kindSize(f.of as FieldKind, pack?.pointerSize ?? 4) : 0);
    return elem * (f.count ?? 0);
  }
  return kindSize(f.kind, pack?.pointerSize ?? 4);
}

/* -------------------------------------------------------------------- DSL */

function cleanOpts(opts: FieldOpts): Omit<FieldOpts, 'at' | 'size' | 'bit' | 'unit'> {
  const { at: _at, size: _size, ...rest } = opts;
  return rest;
}

const scalar = (kind: FieldKind) =>
  (name: string, opts: FieldOpts = {}): FieldDef => ({
    name, kind, offset: opts.at, anchored: opts.at != null, ...(opts.size != null ? { size: opts.size } : {}), ...cleanOpts(opts),
  });

export const u8 = scalar('u8');
export const u16 = scalar('u16');
export const u32 = scalar('u32');
export const u64 = scalar('u64');
export const i8 = scalar('i8');
export const i16 = scalar('i16');
export const i32 = scalar('i32');
export const i64 = scalar('i64');
export const f32 = scalar('f32');
export const f64 = scalar('f64');
export const bool = scalar('bool');
export const char = scalar('char');
export const ptr = scalar('ptr');

export function str(name: string, opts: FieldOpts & { size: number }): FieldDef {
  return { name, kind: 'string', offset: opts.at, anchored: opts.at != null, size: opts.size, count: opts.size, ...cleanOpts(opts) };
}

export function bytes(name: string, opts: FieldOpts & { size: number }): FieldDef {
  return { name, kind: 'bytes', offset: opts.at, anchored: opts.at != null, size: opts.size, count: opts.size, ...cleanOpts(opts) };
}

export function bits(name: string, width: number, opts: BitOpts = {}): FieldDef {
  return {
    name, kind: 'bits', offset: opts.at, anchored: opts.at != null,
    bits: { offset: opts.bit, width, unit: opts.unit, unitExplicit: opts.unit != null, signed: opts.signed },
    ...cleanOpts(opts),
  };
}

export function record(name: string, type: TypeDef, opts: FieldOpts = {}): FieldDef {
  return { name, kind: 'record', offset: opts.at, anchored: opts.at != null, of: type.name, ofType: type, ...cleanOpts(opts) };
}

export function array(name: string, type: TypeDef | FieldKind, count: number, opts: FieldOpts = {}): FieldDef {
  return typeof type === 'string'
    ? { name, kind: 'array', offset: opts.at, anchored: opts.at != null, of: type, count, ...cleanOpts(opts) }
    : { name, kind: 'array', offset: opts.at, anchored: opts.at != null, of: type.name, ofType: type, count, ...cleanOpts(opts) };
}

export function pad(n: number): LayoutOp {
  return { __op: 'pad', n };
}

export function align(n: number): LayoutOp {
  return { __op: 'align', n };
}

export function layoutType(id: string): TypeDef {
  return { name: `@layout:${id}`, size: 0, fields: [], ref: { kind: 'layout', id }, auto: true };
}

interface StructOpts {
  /** override the derived total length; must not be smaller than the content */
  size?: number;
}

function assertAnchor(value: unknown, label: string): void {
  if (value == null) return;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} 的偏移必须是非负安全整数`);
  }
}

function assertCount(value: unknown, label: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${label} 的长度必须是正整数`);
  }
}

function alignUp(value: number, n: number): number {
  return Math.ceil(value / n) * n;
}

function bitGroupUnit(bitsNeeded: number, explicit?: number): number {
  if (explicit != null) {
    if (![1, 2, 4, 8].includes(explicit)) throw new Error(`位组的存储宽度必须是 1、2、4 或 8 字节`);
    if (bitsNeeded > explicit * 8) throw new Error(`位组需要 ${bitsNeeded} 位，超过 ${explicit} 字节`);
    return explicit;
  }
  for (const unit of [1, 2, 4, 8]) if (bitsNeeded <= unit * 8) return unit;
  throw new Error(`位组需要 ${bitsNeeded} 位，超过 64 位上限`);
}

function buildType(name: string, fields: Array<FieldDef | LayoutOp>, union: boolean, opts: StructOpts, pointerSize: 4 | 8): TypeDef {
  if (!name.trim()) throw new Error('结构名称不能为空');
  const type: TypeDef = { name, size: 0, fields: [], union, auto: true, layoutFields: fields.slice() };
  let cursor = 0;
  for (let i = 0; i < fields.length; i += 1) {
    const raw = fields[i];
    if ('__op' in raw) {
      assertCount(raw.n, raw.__op === 'pad' ? 'pad' : 'align');
      cursor = raw.__op === 'pad' ? cursor + raw.n : alignUp(cursor, raw.n);
      continue;
    }
    const f = raw;
    if (f.kind === 'bits') {
      const group: FieldDef[] = [f];
      const groupStart = f.anchored ? (f.offset ?? 0) : (union ? 0 : cursor);
      let groupUnit = f.bits?.unitExplicit ? f.bits.unit : undefined;
      let j = i + 1;
      // Consecutive bit fields that share the same anchored offset and storage
      // unit belong to one group. This also keeps auto groups whose members each
      // repeat an explicit unit (the designer's export shape) in one slot.
      while (j < fields.length) {
        const next = fields[j];
        if ('__op' in next || next.kind !== 'bits' || !next.bits) break;
        if (next.anchored && (next.offset ?? 0) !== groupStart) break;
        const nextUnit = next.bits.unitExplicit ? next.bits.unit : undefined;
        if (nextUnit !== undefined) {
          if (groupUnit !== undefined && nextUnit !== groupUnit) break;
          groupUnit = nextUnit;
        }
        group.push(next);
        j += 1;
      }
      const first = group[0];
      const start = first.anchored ? (first.offset ?? 0) : (union ? 0 : cursor);
      assertAnchor(start, `${name}.${first.name}`);
      let used = 0;
      let bitCursor = 0;
      for (const b of group) {
        if (!b.bits) throw new Error(`${name}.${b.name} 缺少位域参数`);
        if (b.bits.width < 1 || b.bits.width > 64) throw new Error(`${name}.${b.name} 的位宽必须在 1–64 之间`);
        const bit = b.bits.offset ?? bitCursor;
        b.bits = { ...b.bits, offset: bit };
        bitCursor = Math.max(bitCursor, bit + b.bits.width);
        used = Math.max(used, bitCursor);
      }
      const unit = bitGroupUnit(used, group.find((b) => b.bits?.unit != null)?.bits?.unit);
      for (const b of group) {
        b.offset = start;
        b.bits = { ...b.bits!, unit };
        b.size = unit;
        type.fields.push(b);
      }
      cursor = Math.max(cursor, start + unit);
      i = j - 1;
      continue;
    }
    const size = fieldSize(f, sizeBase(pointerSize));
    if (!Number.isFinite(size) || size <= 0) {
      if (f.kind === 'record' && f.ofType?.ref) {
        type.hasLayoutRef = true;
        f.size = 0;
      } else {
        throw new Error(`${name}.${f.name} 的大小非法`);
      }
    } else {
      f.size = f.size ?? size;
    }
    const start = f.anchored ? (f.offset ?? 0) : (union ? 0 : cursor);
    assertAnchor(start, `${name}.${f.name}`);
    f.offset = start;
    type.fields.push(f);
    if (f.ofType) {
      if (f.ofType.ref) type.hasLayoutRef = true;
      else if (f.ofType.auto) type.hasLayoutRef = false;
    }
    cursor = Math.max(cursor, start + (f.size ?? 0));
  }
  if (!union) {
    const spans = type.fields.filter(f => f.kind !== 'bits')
      .map(f => ({ name: f.name, start: f.offset ?? 0, end: (f.offset ?? 0) + (f.size ?? 0) }))
      .sort((a, b) => a.start - b.start || a.end - b.end);
    for (let i = 0; i < spans.length; i += 1) {
      for (let j = 0; j < i; j += 1) {
        if (spans[i].start < spans[j].end) {
          throw new Error(`${name} 字段重叠：${spans[j].name} / ${spans[i].name}`);
        }
      }
    }
  }
  if (opts.size != null) {
    assertCount(opts.size, `${name} 的长度`);
    if (opts.size < cursor) throw new Error(`${name} 的长度 ${opts.size} 小于字段结束位置 ${cursor}`);
    type.size = opts.size;
  } else {
    type.size = cursor;
  }
  if (type.size <= 0) throw new Error(`${name} 的长度必须大于 0`);
  if (opts.size != null) type.sizeExplicit = opts.size;
  return type;
}

export function struct(name: string, fields: Array<FieldDef | LayoutOp>, opts: StructOpts = {}): TypeDef {
  return buildType(name, fields, false, opts, 4);
}

export function union(name: string, fields: Array<FieldDef | LayoutOp>, opts: StructOpts = {}): TypeDef {
  return buildType(name, fields, true, opts, 4);
}

/**
 * Recursively collect direct type references. The same object may be
 * referenced many times; two different objects with the same name are an
 * error, never a last-write-wins overwrite.
 */
export function collectTypes(roots: TypeDef[]): Map<string, TypeDef> {
  const out = new Map<string, TypeDef>();
  const visit = (type: TypeDef, stack: Set<TypeDef>) => {
    if (type.ref) {
      const existing = out.get(type.name);
      if (existing && existing !== type) throw new Error(`类型名 ${type.name} 被不同定义重复使用`);
      out.set(type.name, type);
      return;
    }
    if (stack.has(type)) throw new Error(`类型 ${type.name} 存在循环引用`);
    const existing = out.get(type.name);
    if (existing && existing !== type) throw new Error(`类型名 ${type.name} 被不同定义重复使用`);
    if (existing) return;
    out.set(type.name, type);
    stack.add(type);
    for (const f of type.fields) {
      if (f.ofType && !f.ofType.ref) visit(f.ofType, stack);
      if (f.ofType?.ref) type.hasLayoutRef = true;
    }
    stack.delete(type);
  };
  for (const root of roots) visit(root, new Set());
  return out;
}

/** Recompute auto layouts after pointer size and nested type sizes are known. */
export function finalizeTypes(types: Map<string, TypeDef>, pointerSize: 4 | 8): void {
  const done = new Set<TypeDef>();
  const visit = (type: TypeDef, stack: Set<TypeDef>) => {
    if (type.ref || done.has(type)) return;
    if (stack.has(type)) throw new Error(`类型 ${type.name} 存在循环引用`);
    stack.add(type);
    for (const f of type.fields) {
      if (f.ofType && !f.ofType.ref) visit(f.ofType, stack);
      if (f.ofType?.ref) type.hasLayoutRef = true;
    }
    if (type.auto) {
      const rebuilt = buildType(type.name, type.layoutFields ?? type.fields, !!type.union, { size: type.sizeExplicit }, pointerSize);
      type.fields = rebuilt.fields;
      type.layoutFields = rebuilt.layoutFields;
      type.size = rebuilt.size;
      type.hasLayoutRef = rebuilt.hasLayoutRef;
      type.sizeExplicit = rebuilt.sizeExplicit;
    }
    stack.delete(type);
    done.add(type);
  };
  for (const type of types.values()) visit(type, new Set());
}

/** Recompute one auto layout after its nested direct references have sizes. */
export function relayoutType(type: TypeDef, pointerSize: 4 | 8): TypeDef {
  if (type.ref || !type.auto) return type;
  const rebuilt = buildType(type.name, type.layoutFields ?? type.fields, !!type.union, { size: type.sizeExplicit }, pointerSize);
  type.fields = rebuilt.fields;
  type.layoutFields = rebuilt.layoutFields;
  type.size = rebuilt.size;
  type.hasLayoutRef = rebuilt.hasLayoutRef;
  type.sizeExplicit = rebuilt.sizeExplicit;
  return type;
}

export function definePack(input: PackInput): Pack {
  const types = collectTypes(input.types ?? []);
  finalizeTypes(types, input.pointerSize ?? 4);
  return {
    name: input.name ?? 'untitled',
    endian: input.endian ?? 'little',
    pointerSize: input.pointerSize ?? 4,
    constants: input.constants ?? {},
    types: [...types.values()],
    roots: input.roots ?? [],
    program: input.program,
  };
}

/** Every name the pack loader injects into the evaluated module. */
export const PACK_DSL = {
  definePack, struct, union,
  u8, u16, u32, u64, i8, i16, i32, i64, f32, f64, bool, char, ptr,
  str, bytes, bits, record, array, pad, align, layoutType,
} as const;
