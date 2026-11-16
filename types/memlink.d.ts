/**
 * Ambient types for `.pack.ts` files.
 *
 * Add this line at the top of a pack to get editor completion:
 *   /// <reference path="../types/memlink.d.ts" />
 *
 * The functions below are injected by the tool at evaluation time; packs must
 * not import them.
 */

import type {
  Endian, FieldDef, FieldOpts, Pack, PackInput, TypeDef,
} from '../src/core/pack';

declare global {
  function definePack(input: PackInput): Pack;
  function struct(name: string, size: number, fields: FieldDef[]): TypeDef;
  function union(name: string, size: number, fields: FieldDef[]): TypeDef;

  function u8(name: string, offset: number, opts?: FieldOpts): FieldDef;
  function u16(name: string, offset: number, opts?: FieldOpts): FieldDef;
  function u32(name: string, offset: number, opts?: FieldOpts): FieldDef;
  function u64(name: string, offset: number, opts?: FieldOpts): FieldDef;
  function i8(name: string, offset: number, opts?: FieldOpts): FieldDef;
  function i16(name: string, offset: number, opts?: FieldOpts): FieldDef;
  function i32(name: string, offset: number, opts?: FieldOpts): FieldDef;
  function i64(name: string, offset: number, opts?: FieldOpts): FieldDef;
  function f32(name: string, offset: number, opts?: FieldOpts): FieldDef;
  function f64(name: string, offset: number, opts?: FieldOpts): FieldDef;

  function bool(name: string, offset: number, opts?: FieldOpts): FieldDef;
  function char(name: string, offset: number, opts?: FieldOpts): FieldDef;
  function ptr(name: string, offset: number, opts?: FieldOpts): FieldDef;

  function str(name: string, offset: number, count: number, opts?: FieldOpts): FieldDef;
  function bytes(name: string, offset: number, count: number, opts?: FieldOpts): FieldDef;
  function bits(
    name: string, offset: number, size: number, bitOffset: number, width: number, opts?: FieldOpts,
  ): FieldDef;
  function record(name: string, offset: number, of: string, opts?: FieldOpts): FieldDef;
  function array(name: string, offset: number, of: string, count: number, opts?: FieldOpts): FieldDef;

  /** pack 里常用的常量别名，方便写 transform */
  type PackEndian = Endian;
}

export {};
