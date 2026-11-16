/**
 * Ambient types for `.bp.ts` blueprints. Reference this file at the top of a
 * pack (`/// <reference path="../types/memlink-bp.d.ts" />`) to get editor
 * completion. The runtime injects these functions as globals.
 */

type BPEndian = 'little' | 'big';
type BPPortType = 'number' | 'string' | 'bytes' | 'boolean' | 'instance' | 'list' | 'buffer';

interface BPFieldOpts {
  size?: number;
  count?: number;
  of?: string;
  bits?: { offset: number; width: number; signed?: boolean };
  endian?: BPEndian;
  format?: string;
  label?: string;
  signed?: boolean;
  transform?: (v: unknown, ctx: BPTransformCtx) => unknown;
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
  offset: number;
  kind: string;
  size?: number;
  count?: number;
  of?: string;
  bits?: { offset: number; width: number; signed?: boolean };
  endian?: BPEndian;
  format?: string;
  label?: string;
  follow?: string;
  transform?: (v: unknown, ctx: BPTransformCtx) => unknown;
}

interface BPTypeDef {
  name: string;
  size: number;
  union?: boolean;
  fields: BPFieldDef[];
}

interface BPEntryView {
  addr: number;
  index?: number;
  type: BPTypeDef;
  raw: Record<string, unknown>;
  value: Record<string, unknown>;
}

interface BPEvalCtx {
  mem: any;
  pack: unknown;
  nodeId: string;
  endian: BPEndian;
  pointerSize: 4 | 8;
  consts: Record<string, number>;
  read(type: BPTypeDef, addr: number): BPEntryView;
}

declare function struct(name: string, size: number, fields: BPFieldDef[]): BPTypeDef;
declare function union(name: string, size: number, fields: BPFieldDef[]): BPTypeDef;
declare function u8(name: string, offset: number, opts?: BPFieldOpts): BPFieldDef;
declare function u16(name: string, offset: number, opts?: BPFieldOpts): BPFieldDef;
declare function u32(name: string, offset: number, opts?: BPFieldOpts): BPFieldDef;
declare function u64(name: string, offset: number, opts?: BPFieldOpts): BPFieldDef;
declare function i8(name: string, offset: number, opts?: BPFieldOpts): BPFieldDef;
declare function i16(name: string, offset: number, opts?: BPFieldOpts): BPFieldDef;
declare function i32(name: string, offset: number, opts?: BPFieldOpts): BPFieldDef;
declare function i64(name: string, offset: number, opts?: BPFieldOpts): BPFieldDef;
declare function f32(name: string, offset: number, opts?: BPFieldOpts): BPFieldDef;
declare function f64(name: string, offset: number, opts?: BPFieldOpts): BPFieldDef;
declare function bool(name: string, offset: number, opts?: BPFieldOpts): BPFieldDef;
declare function char(name: string, offset: number, opts?: BPFieldOpts): BPFieldDef;
declare function ptr(name: string, offset: number, opts?: BPFieldOpts): BPFieldDef;
declare function str(name: string, offset: number, count: number, opts?: BPFieldOpts): BPFieldDef;
declare function bytes(name: string, offset: number, count: number, opts?: BPFieldOpts): BPFieldDef;
declare function bits(name: string, offset: number, size: number, bitOffset: number, width: number, opts?: BPFieldOpts): BPFieldDef;
declare function record(name: string, offset: number, of: string, opts?: BPFieldOpts): BPFieldDef;
declare function array(name: string, offset: number, of: string, count: number, opts?: BPFieldOpts): BPFieldDef;

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
