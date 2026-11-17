/**
 * Decode a binary buffer with a TypeScript pack: read fields, run transforms,
 * and format the result for the inspector.
 */

import {
  fieldSize, kindSize,
  type FieldDef, type MemApi, type Pack, type TypeDef,
} from './pack';
import { Memory, toHex } from './mem';
import type { Endian } from './types';

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

function decodeFieldRaw(
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
