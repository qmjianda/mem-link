/**
 * mem-link / pack
 *
 * A "pack" is a TypeScript-declared description of a binary layout. The file
 * is executed inside the tool with a small DSL injected as globals:
 *
 *   export default definePack({
 *     endian: 'little', pointerSize: 4,
 *     constants: { BASE: 0x100, STRIDE: 24 },
 *     types: [
 *       struct('Entry', 24, [
 *         i16('next', 0, { follow: 'self', transform: (v, c) => v < 0 ? null : c.consts.BASE + v * c.consts.STRIDE }),
 *       ]),
 *     ],
 *     roots: [{ type: 'Entry', address: 0x100 }],
 *   });
 *
 * Layout is explicit: the generator (usually an AI) is responsible for offsets
 * and sizes. The runtime never parses C. Transforms stay live functions, so a
 * pack can be evaluated in the browser without a build step.
 */

import type {
  CType, Endian, Field as CField, GraphNode, Problem, RecordDecl, Schema,
} from './types';
import { INT, CHAR, PTR, BOOL, NODE_HEADER_H, NODE_MAX_ROWS, NODE_ROW_H } from './types';

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
  endian?: Endian;
  format?: string;
  label?: string;
  follow?: string;
  transform?: TransformFn;
  signed?: boolean;
  size?: number;
}

export interface FieldDef {
  name: string;
  offset: number;
  kind: FieldKind;
  /** explicit byte size (required for bytes/string, optional for the rest) */
  size?: number;
  /** element count for array/string */
  count?: number;
  /** record type for record/array */
  of?: string;
  bits?: { offset: number; width: number; signed?: boolean };
  endian?: Endian;
  format?: string;
  label?: string;
  follow?: string;
  transform?: TransformFn;
}

export interface TypeDef {
  name: string;
  size: number;
  union?: boolean;
  fields: FieldDef[];
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

const KINDS = new Set<FieldKind>([
  ...(Object.keys(KIND_SIZE) as FieldKind[]),
  'ptr', 'string', 'bytes', 'bits', 'record', 'array',
]);

export function kindSize(kind: FieldKind, pointerSize: 4 | 8): number {
  if (kind === 'ptr') return pointerSize;
  return KIND_SIZE[kind] ?? 0;
}

export function fieldSize(f: FieldDef, pack: Pick<Pack, 'pointerSize' | 'types'>): number {
  if (f.size != null) return f.size;
  if (f.kind === 'string') return f.count ?? 0;
  if (f.kind === 'bytes') return f.count ?? 0;
  if (f.kind === 'bits') return Math.ceil(((f.bits?.offset ?? 0) + (f.bits?.width ?? 0)) / 8);
  if (f.kind === 'record') {
    const t = pack.types.find((x) => x.name === f.of);
    return t?.size ?? 0;
  }
  if (f.kind === 'array') {
    const elem = f.of ? pack.types.find((x) => x.name === f.of) : undefined;
    const es = elem ? elem.size : kindSize((f.of ?? 'u8') as FieldKind, pack.pointerSize);
    return es * (f.count ?? 0);
  }
  return kindSize(f.kind, pack.pointerSize);
}

export function fieldId(typeName: string, fieldName: string): string {
  return `${typeName}.${fieldName}`;
}

/* -------------------------------------------------------------------- DSL */

const scalar = (kind: FieldKind) =>
  (name: string, offset: number, opts: FieldOpts = {}): FieldDef => ({
    name, offset, kind, ...opts,
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

export function str(name: string, offset: number, count: number, opts: FieldOpts = {}): FieldDef {
  return { name, offset, kind: 'string', count, size: count, ...opts };
}

export function bytes(name: string, offset: number, count: number, opts: FieldOpts = {}): FieldDef {
  return { name, offset, kind: 'bytes', count, size: count, ...opts };
}

export function bits(
  name: string, offset: number, size: number, bitOffset: number, width: number, opts: FieldOpts = {},
): FieldDef {
  return {
    name, offset, kind: 'bits', size,
    bits: { offset: bitOffset, width, signed: opts.signed },
    ...opts,
  };
}

export function record(name: string, offset: number, of: string, opts: FieldOpts = {}): FieldDef {
  return { name, offset, kind: 'record', of, ...opts };
}

export function array(
  name: string, offset: number, of: string, count: number, opts: FieldOpts = {},
): FieldDef {
  return { name, offset, kind: 'array', of, count, ...opts };
}

export function struct(name: string, size: number, fields: FieldDef[]): TypeDef {
  return { name, size, fields };
}

export function union(name: string, size: number, fields: FieldDef[]): TypeDef {
  return { name, size, union: true, fields };
}

export function definePack(input: PackInput): Pack {
  return {
    name: input.name ?? 'untitled',
    endian: input.endian ?? 'little',
    pointerSize: input.pointerSize ?? 4,
    constants: input.constants ?? {},
    types: input.types ?? [],
    roots: input.roots ?? [],
    program: input.program,
  };
}

/** Every name the pack loader injects into the evaluated module. */
export const PACK_DSL = {
  definePack, struct, union,
  u8, u16, u32, u64, i8, i16, i32, i64, f32, f64, bool, char, ptr,
  str, bytes, bits, record, array,
} as const;

/* --------------------------------------------------------------- validation */

export function validatePack(pack: Pack): Problem[] {
  const issues: Problem[] = [];
  const err = (message: string, fieldId?: string) =>
    issues.push({ severity: 'error', message, fieldId });
  const warn = (message: string, fieldId?: string) =>
    issues.push({ severity: 'warn', message, fieldId });

  if (pack.endian !== 'little' && pack.endian !== 'big') err(`endian 必须是 little/big`);
  if (pack.pointerSize !== 4 && pack.pointerSize !== 8) err(`pointerSize 必须是 4/8`);
  if (!pack.types.length) err('pack 里没有任何类型');

  const byName = new Map<string, TypeDef>();
  for (const t of pack.types) {
    if (!t.name) err('类型名不能为空');
    else if (byName.has(t.name)) err(`类型 ${t.name} 重复`);
    byName.set(t.name, t);
    if (!Number.isInteger(t.size) || t.size <= 0) err(`类型 ${t.name} 的 size 必须是正整数`);
  }

  for (const t of pack.types) {
    const names = new Set<string>();
    const spans: { start: number; end: number; name: string; bits: boolean }[] = [];
    for (const f of t.fields) {
      const id = fieldId(t.name, f.name);
      if (!f.name) err(`类型 ${t.name} 有字段没有名字`);
      if (names.has(f.name)) err(`${t.name}.${f.name} 字段名重复`, id);
      names.add(f.name);
      if (!KINDS.has(f.kind)) {
        err(`${id} 的 kind "${f.kind}" 不支持`, id);
        continue;
      }
      if (!Number.isInteger(f.offset) || f.offset < 0) {
        err(`${id} 的 offset 必须是非负整数`, id);
        continue;
      }
      const size = fieldSize(f, pack);
      if (!size || size <= 0) {
        err(`${id} 无法确定大小（${f.kind}）`, id);
        continue;
      }
      if (f.offset + size > t.size) {
        err(`${id} 超出类型 ${t.name} 的 size ${t.size}（offset ${f.offset} + ${size}）`, id);
      }
      if (f.kind === 'record' && !byName.has(f.of ?? '')) {
        err(`${id} 引用了不存在的类型 ${f.of}`, id);
      }
      if (f.kind === 'array') {
        if (!f.count || f.count <= 0) err(`${id} 的 count 必须是正整数`, id);
        if (!f.of) err(`${id} 缺少数组元素类型 of`, id);
        else if (!byName.has(f.of) && !KINDS.has(f.of as FieldKind)) {
          err(`${id} 的数组元素类型 ${f.of} 不存在`, id);
        }
      }
      if (f.kind === 'string' || f.kind === 'bytes') {
        if (!f.count || f.count <= 0) err(`${id} 的 count 必须是正整数`, id);
      }
      if (f.kind === 'bits') {
        const b = f.bits;
        if (!b || b.width <= 0) err(`${id} 缺少位宽`, id);
        else if (b.offset < 0 || b.offset + b.width > size * 8) {
          err(`${id} 的位域 [${b.offset},${b.offset + b.width}) 超出存储单元 ${size} 字节`, id);
        }
      }
      if (f.follow && f.follow !== 'self' && !byName.has(f.follow)) {
        err(`${id} 的 follow 目标类型 ${f.follow} 不存在`, id);
      }
      if (f.transform != null && typeof f.transform !== 'function') {
        err(`${id} 的 transform 必须是函数`, id);
      }
      if (f.endian && f.endian !== 'little' && f.endian !== 'big') {
        err(`${id} 的 endian 必须是 little/big`, id);
      }
      spans.push({ start: f.offset, end: f.offset + size, name: f.name, bits: f.kind === 'bits' });
    }

    for (const [key, value] of Object.entries({ ...pack.constants })) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        err(`常量 ${key} 必须是有限数字`);
      }
    }

    if (!t.union) {
      const sorted = spans.filter((s) => !s.bits).sort((a, b) => a.start - b.start);
      for (let i = 1; i < sorted.length; i++) {
        if (sorted[i].start < sorted[i - 1].end) {
          err(`${t.name}.${sorted[i].name} 与 ${t.name}.${sorted[i - 1].name} 字节重叠`, fieldId(t.name, sorted[i].name));
        }
      }
    }
    const used = spans.reduce((m, s) => Math.max(m, s.end), 0);
    if (used < t.size) warn(`类型 ${t.name} 末尾有 ${t.size - used} 字节未使用`);
  }

  for (const r of pack.roots) {
    if (!byName.has(r.type)) err(`根节点引用了不存在的类型 ${r.type}`);
    if (!Number.isFinite(r.address) || r.address < 0) err(`根节点 ${r.type} 的地址无效`);
  }

  if (pack.program) {
    if (!pack.program.code) err('program.code 不能为空');
    if (pack.program.timeoutMs != null && (pack.program.timeoutMs < 10 || pack.program.timeoutMs > 60000)) {
      err('program.timeoutMs 必须在 10..60000 之间');
    }
  }

  return issues;
}

/* ---------------------------------------------------------- pack -> schema */

function ctypeOf(f: FieldDef, pack: Pack): CType {
  switch (f.kind) {
    case 'u8': return INT(1, false);
    case 'u16': return INT(2, false);
    case 'u32': return INT(4, false);
    case 'u64': return INT(8, false);
    case 'i8': return INT(1, true);
    case 'i16': return INT(2, true);
    case 'i32': return INT(4, true);
    case 'i64': return INT(8, true);
    case 'f32': return { k: 'float', size: 4 };
    case 'f64': return { k: 'float', size: 8 };
    case 'bool': return BOOL;
    case 'char': return CHAR(false);
    case 'ptr': return PTR(pack.pointerSize);
    case 'string': return { k: 'array', elem: CHAR(false), count: f.count ?? 0 };
    case 'bytes': return { k: 'array', elem: INT(1, false), count: f.count ?? 0 };
    case 'bits': return INT(f.bits?.width ? Math.ceil(f.bits.width / 8) : 1, f.bits?.signed ?? false);
    case 'record': return { k: 'record', name: f.of ?? '', union: false };
    case 'array': {
      const elemType = pack.types.find((t) => t.name === f.of);
      return {
        k: 'array',
        elem: elemType ? { k: 'record', name: elemType.name, union: !!elemType.union } : ctypeOf({ ...f, kind: (f.of ?? 'u8') as FieldKind }, pack),
        count: f.count ?? 0,
      };
    }
  }
}

/** Build the minimal C-schema shape the canvas / inspector already understand. */
export function packToSchema(pack: Pack): Schema {
  const records: Record<string, RecordDecl> = {};
  for (const t of pack.types) {
    const fields: CField[] = t.fields.map((f) => ({
      id: fieldId(t.name, f.name),
      name: f.name,
      type: ctypeOf(f, pack),
      offset: f.offset,
      size: fieldSize(f, pack),
      bitWidth: f.kind === 'bits' ? f.bits?.width : undefined,
      bitOffset: f.kind === 'bits' ? f.bits?.offset : undefined,
      endian: f.endian,
      note: f.label,
    }));
    records[t.name] = {
      name: t.name,
      kind: t.union ? 'union' : 'struct',
      fields,
      size: t.size,
      align: 1,
    };
  }
  return {
    records,
    typedefs: {},
    ptrSize: pack.pointerSize,
    endian: pack.endian,
    issues: [],
    source: pack.name,
  };
}

/** Height of a node card for a given type, matching the canvas constants. */
export function nodeHeight(t: TypeDef): number {
  return NODE_HEADER_H + Math.min(t.fields.length, NODE_MAX_ROWS) * NODE_ROW_H + 8;
}

export function emptyNode(type: TypeDef, addr: number, depth: number, seq: number): GraphNode {
  return {
    key: '', addr, type: type.name, size: type.size,
    values: {}, display: {}, links: [],
    depth, x: 0, y: 0, seq,
    height: nodeHeight(type),
  };
}
