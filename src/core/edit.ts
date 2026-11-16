/**
 * Field editing: turn user text into bytes and write them back into a Memory.
 * Everything here is deliberately explicit — no eval, no coercion surprises.
 */
import type { Endian, Field, RecordDecl, Schema } from './types';
import { Memory } from './mem';

export interface ParsedValue {
  kind: 'number' | 'string';
  number?: number;
  string?: string;
  /** true when the user explicitly typed 0x / 0b, so we should keep the base */
  base?: 10 | 16 | 2 | 8;
}

export function parseValueText(text: string): { value?: ParsedValue; error?: string } {
  const s = text.trim();
  if (!s.length) return { error: '空值' };
  if (s.length >= 2 && s[0] === "'" && s[s.length - 1] === "'") {
    const body = s.slice(1, -1).replace(/^\\(.)$/, '$1');
    if (body.length !== 1) return { error: '字符字面量只能有一个字符' };
    return { value: { kind: 'number', number: body.charCodeAt(0) } };
  }
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') {
    return { value: { kind: 'string', string: s.slice(1, -1).replace(/\\(.)/g, '$1') } };
  }
  let base: 2 | 8 | 10 | 16 = 10;
  let body = s;
  let sign = 1;
  if (body.startsWith('-')) { sign = -1; body = body.slice(1); }
  if (body.startsWith('+')) body = body.slice(1);
  if (/^0x/i.test(body)) { base = 16; body = body.slice(2); }
  else if (/^0b/i.test(body)) { base = 2; body = body.slice(2); }
  else if (/^0o/i.test(body)) { base = 8; body = body.slice(2); }
  if (!body.length) return { error: '缺少数字' };
  const digits = base === 16 ? /^[0-9a-fA-F_]+$/ : base === 2 ? /^[01_]+$/ : base === 8 ? /^[0-7_]+$/ : /^[0-9_]+$/;
  if (!digits.test(body)) {
    // plain word -> string, useful for char arrays
    return { value: { kind: 'string', string: s } };
  }
  const n = parseInt(body.replace(/_/g, ''), base);
  if (!Number.isFinite(n)) return { error: `无法解析 ${s}` };
  // float form?
  if (base === 10 && /^[0-9_]*\.[0-9_]+([eE][-+]?\d+)?$/.test(body)) {
    return { value: { kind: 'number', number: sign * Number(body.replace(/_/g, '')) } };
  }
  return { value: { kind: 'number', number: sign * n, base } };
}

export function fieldByteRange(field: Field): { offset: number; size: number } {
  return { offset: field.offset, size: Math.max(1, field.size) };
}

/** Write a decoded field value back into the buffer. Returns an error string on failure. */
export function writeFieldValue(
  mem: Memory,
  schema: Schema,
  rec: RecordDecl,
  field: Field,
  addr: number,
  text: string,
  endianOverride?: Endian,
): { ok: boolean; error?: string } {
  if (field.derived) return { ok: false, error: '派生字段只读（由表达式计算）' };
  const parsed = parseValueText(text);
  if (!parsed.value) return { ok: false, error: parsed.error };
  const endian = endianOverride ?? field.endian ?? rec.endian ?? schema.endian;
  const at = addr + field.offset;
  const v = parsed.value;

  try {
    if (v.kind === 'string') {
      if (field.type.k === 'array' && field.type.elem.k === 'char') {
        const count = field.type.count;
        const bytes = new Uint8Array(count);
        for (let i = 0; i < Math.min(count - 1, v.string!.length); i++) {
          bytes[i] = v.string!.charCodeAt(i) & 0xff;
        }
        mem.write(at, bytes);
        return { ok: true };
      }
      return { ok: false, error: '该字段不是字符串类型，请输入数字或 0x 值' };
    }

    const num = v.number!;
    if (field.bitWidth != null) {
      // read-modify-write the storage unit
      const unitSize = field.type.k === 'int' ? field.type.size : 1;
      const unit = mem.readUInt(at, unitSize, endian, false);
      const shift = field.bitOffset ?? 0;
      const mask = (2 ** field.bitWidth - 1) << shift;
      const bits = Math.trunc(num) & (2 ** field.bitWidth - 1);
      mem.writeUInt(at, unitSize, (unit & ~mask) | (bits << shift), endian);
      return { ok: true };
    }
    switch (field.type.k) {
      case 'int':
        mem.writeUInt(at, field.type.size, num, endian);
        return { ok: true };
      case 'char':
      case 'bool':
        mem.writeUInt(at, 1, num, endian);
        return { ok: true };
      case 'ptr':
        mem.writeUInt(at, field.type.size, num, endian);
        return { ok: true };
      case 'float': {
        const dv = new DataView(new ArrayBuffer(field.type.size));
        if (field.type.size === 4) dv.setFloat32(0, num, endian === 'little');
        else dv.setFloat64(0, num, endian === 'little');
        mem.write(at, new Uint8Array(dv.buffer));
        return { ok: true };
      }
      case 'array':
        return { ok: false, error: '数组字段请逐个元素或按字符串编辑' };
      case 'record':
        return { ok: false, error: '嵌套结构请直接编辑其字段' };
    }
    return { ok: false, error: '不支持的字段类型' };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/* --------------------------------------------------------- value display */

export interface ValueForms {
  dec: string;
  hex: string;
  bin: string;
  ascii: string;
  bytesLE: string;
  bytesBE: string;
}

const g4 = (s: string): string => s.replace(/\B(?=(.{4})+$)/g, ' ');

export function valueForms(n: number, width = 4): ValueForms {
  const neg = n < 0;
  const abs = Math.abs(Math.trunc(n));
  const hex = `${neg ? '-' : ''}0x${abs.toString(16).toUpperCase().padStart(2, '0')}`;
  const bits = Math.max(8, Math.min(64, width * 8));
  const masked = abs & (2 ** Math.min(bits, 32) - 1);
  const bin = g4((neg ? '-' : '') + masked.toString(2).padStart(Math.min(bits, 32), '0'));
  const valid = n >= 0 && n < 0x110000 && !(n >= 0xd800 && n <= 0xdfff);
  const ascii = valid && n >= 32 && n < 127 ? String.fromCharCode(n) : valid ? '·' : '';
  const bytes: number[] = [];
  let v = Math.abs(n);
  for (let i = 0; i < width; i++) { bytes.push(v % 256); v = Math.floor(v / 256); }
  const hx = (b: number) => b.toString(16).toUpperCase().padStart(2, '0');
  return {
    dec: String(n),
    hex,
    bin,
    ascii,
    bytesLE: bytes.map(hx).join(' '),
    bytesBE: [...bytes].reverse().map(hx).join(' '),
  };
}
