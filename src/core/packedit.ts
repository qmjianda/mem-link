/**
 * Write a single pack field back into the buffer.
 *
 * Pack fields are described independently of the C schema, so this is a
 * separate writer from `edit.ts` (which works on parsed C records). Values are
 * parsed with the same literal syntax the inspector uses: `0x..`, decimal,
 * `'A'`, `"text"`, or a hex byte string for `bytes`.
 */

import type { FieldDef, Pack, TypeDef } from './pack';
import { fieldSize } from './pack';
import type { Memory } from './mem';
import { parseHexText } from './mem';
import { parseValueText } from './edit';

export interface WriteResult {
  ok: boolean;
  error?: string;
  value?: unknown;
}

function fail(error: string): WriteResult {
  return { ok: false, error };
}

function numberFrom(text: string): { n?: number; error?: string } {
  const p = parseValueText(text);
  if (p.error || !p.value) return { error: p.error ?? '无法解析' };
  if (p.value.kind === 'number') return { n: p.value.number };
  // A plain word is parsed as a string; accept a single character for char.
  if (p.value.kind === 'string' && (p.value.string ?? '').length === 1) {
    return { n: (p.value.string ?? '').charCodeAt(0) };
  }
  return { error: '这里需要一个数字' };
}

function writeFloat(mem: Memory, addr: number, size: 4 | 8, value: number, little: boolean): void {
  const dv = new DataView(mem.buf.buffer, mem.buf.byteOffset + (addr - mem.base), size);
  if (size === 4) dv.setFloat32(0, value, little);
  else dv.setFloat64(0, value, little);
}

function writeBig(mem: Memory, addr: number, size: number, value: bigint, little: boolean): void {
  const arr = new Uint8Array(size);
  let v = value;
  const mask = 0xffn;
  for (let i = 0; i < size; i++) {
    arr[little ? i : size - 1 - i] = Number(v & mask);
    v >>= 8n;
  }
  mem.write(addr, arr);
}

export function writePackValue(
  mem: Memory,
  pack: Pack,
  _type: TypeDef,
  field: FieldDef,
  addr: number,
  text: string,
): WriteResult {
  const size = Math.max(1, fieldSize(field, pack));
  const at = addr + field.offset;
  if (!mem.contains(at, size)) return fail(`字段超出缓冲区：0x${at.toString(16)} + ${size}`);
  const endian = field.endian ?? pack.endian;
  const little = endian === 'little';

  try {
    if (field.kind === 'string') {
      const s = text.trim().replace(/^"(.*)"$/s, '$1').replace(/^'(.*)'$/s, '$1');
      const bytes = new TextEncoder().encode(s);
      const out = new Uint8Array(size);
      out.set(bytes.subarray(0, size));
      mem.write(at, out);
      return { ok: true, value: s };
    }

    if (field.kind === 'bytes') {
      const p = parseHexText(text);
      if (p.error) return fail(p.error);
      if (p.bytes.length > size) return fail(`最多写入 ${size} 字节`);
      const out = new Uint8Array(size);
      out.set(p.bytes);
      mem.write(at, out);
      return { ok: true, value: p.bytes };
    }

    if (field.kind === 'f32' || field.kind === 'f64') {
      const p = numberFrom(text);
      if (p.n === undefined) return fail(p.error ?? '需要数字');
      writeFloat(mem, at, field.kind === 'f32' ? 4 : 8, p.n, little);
      return { ok: true, value: p.n };
    }

    if (field.kind === 'bool') {
      const t = text.trim().toLowerCase();
      const n = t === 'true' ? 1 : t === 'false' ? 0 : Number(t);
      if (n !== 0 && n !== 1) return fail('bool 只能是 0/1 或 true/false');
      mem.writeUInt(at, 1, n, endian);
      return { ok: true, value: n === 1 };
    }

    if (field.kind === 'bits') {
      const p = numberFrom(text);
      if (p.n === undefined) return fail(p.error ?? '需要数字');
      const bits = field.bits;
      if (!bits) return fail('位域缺少定义');
      const width = BigInt(bits.width);
      const mask = (1n << width) - 1n;
      const shift = BigInt(bits.offset);
      const raw = mem.readBig(at, size, endian, false);
      const nv = BigInt(Math.trunc(p.n)) & mask;
      const out = (raw & ~(mask << shift)) | (nv << shift);
      writeBig(mem, at, size, out, little);
      return { ok: true, value: Number(nv) };
    }

    if (field.kind === 'char') {
      const p = numberFrom(text);
      if (p.n === undefined) return fail(p.error ?? '需要字符或数字');
      mem.writeUInt(at, 1, p.n & 0xff, endian);
      return { ok: true, value: p.n };
    }

    if (field.kind === 'record' || field.kind === 'array') {
      return fail('嵌套字段请在子节点上编辑');
    }

    // Scalar integers and pointers.
    const p = numberFrom(text);
    if (p.n === undefined) return fail(p.error ?? '需要数字');
    if (size > 8) return fail('字段宽度不支持');
    mem.writeUInt(at, size, p.n, endian);
    return { ok: true, value: p.n };
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}
