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
