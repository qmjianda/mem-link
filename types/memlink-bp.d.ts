/**
 * Ambient types for `.bp.ts` packs. Reference this file at the top of a pack
 * (`/// <reference path="../types/memlink-bp.d.ts" />`) to get editor
 * completion. The runtime injects these functions as globals.
 *
 * One geometry rule: fields are placed in declaration order. `at` anchors a
 * byte offset; omit it to continue at the current cursor. `pad` / `align` are
 * layout instructions inside the fields array.
 */

type BPEndian = 'little' | 'big';
type BPPortType = 'number' | 'string' | 'bytes' | 'boolean' | 'instance' | 'list' | 'buffer';

type BPFieldKind =
  | 'u8' | 'u16' | 'u32' | 'u64'
  | 'i8' | 'i16' | 'i32' | 'i64'
  | 'f32' | 'f64'
  | 'bool' | 'char' | 'ptr'
  | 'string' | 'bytes' | 'bits' | 'record' | 'array';

interface BPFieldOpts {
  /** byte offset anchor; omitted = current cursor */
  at?: number;
  /** byte length for string / bytes, optional override for other kinds */
  size?: number;
  endian?: BPEndian;
  format?: string;
  label?: string;
  /** numeric value → display label; display only */
  values?: Record<string, string>;
  /** numeric semantics used for ports and downstream UI */
  role?: 'address' | 'offset' | 'index';
  signed?: boolean;
  transform?: (v: unknown, ctx: BPTransformCtx) => unknown;
}

interface BPBitOpts extends BPFieldOpts {
  /** bit offset inside the storage unit */
  bit?: number;
  /** storage unit bytes: 1, 2, 4 or 8 */
  unit?: 1 | 2 | 4 | 8;
}

interface BPTransformCtx {
  v: unknown;
  addr: number;
  self: Record<string, unknown>;
  mem: BPMemApi;
  consts: Record<string, number>;
  type: string;
  field: string;
}

interface BPMemApi {
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

interface BPFieldDef {
  name: string;
  kind: BPFieldKind;
  offset?: number;
  anchored?: boolean;
  size?: number;
  count?: number;
  of?: string;
  ofType?: BPTypeDef;
  bits?: { offset?: number; width: number; unit?: number; unitExplicit?: boolean; signed?: boolean };
  endian?: BPEndian;
  format?: string;
  label?: string;
  values?: Record<string, string>;
  role?: 'address' | 'offset' | 'index';
  transform?: (v: unknown, ctx: BPTransformCtx) => unknown;
  signed?: boolean;
}

interface BPTypeDef {
  name: string;
  size: number;
  union?: boolean;
  auto?: boolean;
  fields: BPFieldDef[];
  ref?: { kind: 'layout'; id: string };
  hasLayoutRef?: boolean;
  sizeExplicit?: number;
}

type BPLayoutOp =
  | { __op: 'pad'; n: number }
  | { __op: 'align'; n: number };

interface BPEntryView {
  addr: number;
  index?: number;
  type: BPTypeDef;
  raw: Record<string, unknown>;
  value: Record<string, unknown>;
}

interface BPEvalCtx {
  mem: BPMemApi;
  pack: unknown;
  nodeId: string;
  endian: BPEndian;
  pointerSize: 4 | 8;
  consts: Record<string, number>;
  read(type: BPTypeDef, addr: number): BPEntryView;
}

declare function struct(name: string, fields: Array<BPFieldDef | BPLayoutOp>, opts?: { size?: number }): BPTypeDef;
declare function union(name: string, fields: Array<BPFieldDef | BPLayoutOp>, opts?: { size?: number }): BPTypeDef;
declare function u8(name: string, opts?: BPFieldOpts): BPFieldDef;
declare function u16(name: string, opts?: BPFieldOpts): BPFieldDef;
declare function u32(name: string, opts?: BPFieldOpts): BPFieldDef;
declare function u64(name: string, opts?: BPFieldOpts): BPFieldDef;
declare function i8(name: string, opts?: BPFieldOpts): BPFieldDef;
declare function i16(name: string, opts?: BPFieldOpts): BPFieldDef;
declare function i32(name: string, opts?: BPFieldOpts): BPFieldDef;
declare function i64(name: string, opts?: BPFieldOpts): BPFieldDef;
declare function f32(name: string, opts?: BPFieldOpts): BPFieldDef;
declare function f64(name: string, opts?: BPFieldOpts): BPFieldDef;
declare function bool(name: string, opts?: BPFieldOpts): BPFieldDef;
declare function char(name: string, opts?: BPFieldOpts): BPFieldDef;
declare function ptr(name: string, opts?: BPFieldOpts): BPFieldDef;
declare function str(name: string, opts: BPFieldOpts & { size: number }): BPFieldDef;
declare function bytes(name: string, opts: BPFieldOpts & { size: number }): BPFieldDef;
declare function bits(name: string, width: number, opts?: BPBitOpts): BPFieldDef;
declare function record(name: string, type: BPTypeDef, opts?: BPFieldOpts): BPFieldDef;
declare function array(name: string, type: BPTypeDef | BPFieldKind, count: number, opts?: BPFieldOpts): BPFieldDef;
declare function pad(n: number): BPLayoutOp;
declare function align(n: number): BPLayoutOp;
declare function layoutType(id: string): BPTypeDef;

declare function structNode(type: BPTypeDef, opts?: { label?: string; description?: string }): unknown;
declare function listNode(type: BPTypeDef, opts: {
  next: (entry: BPEntryView, ctx: BPEvalCtx) => number | null | undefined;
  nulls?: number[];
  max?: number;
  label?: string;
  description?: string;
}): unknown;
declare function arrayNode(type: BPTypeDef, opts?: {
  count?: number;
  stride?: number;
  /** 输入原始文件偏移（相对数据源基址）而不是映射地址 */
  offset?: boolean;
  label?: string;
  description?: string;
}): unknown;
declare function calcNode(opts: {
  inputs: Record<string, BPPortType>;
  outputs: Record<string, BPPortType>;
  run: (inputs: Record<string, unknown>, ctx: BPEvalCtx) => Record<string, unknown>;
  label?: string;
  description?: string;
}): unknown;

declare function definePack(input: {
  name?: string;
  endian?: BPEndian;
  pointerSize?: 4 | 8;
  constants?: Record<string, number>;
  types: Record<string, BPTypeDef> | BPTypeDef[];
  nodes: Record<string, unknown>;
}): unknown;
