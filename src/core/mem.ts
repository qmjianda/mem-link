import type { Endian } from './types';

export class Memory {
  buf: Uint8Array;
  base: number;

  constructor(buf: Uint8Array, base = 0) {
    this.buf = buf;
    this.base = base;
  }

  get size(): number { return this.buf.length; }
  get end(): number { return this.base + this.buf.length; }

  contains(addr: number, len = 1): boolean {
    return addr >= this.base && addr + len <= this.end && addr + len >= addr;
  }

  private off(addr: number): number { return addr - this.base; }

  readUInt(addr: number, size: number, endian: Endian = 'little', signed = false): number {
    if (!this.contains(addr, size)) throw new Error(`读取越界：0x${addr.toString(16)} + ${size}`);
    const o = this.off(addr);
    let v = 0;
    if (endian === 'little') {
      for (let i = size - 1; i >= 0; i--) v = v * 256 + this.buf[o + i];
    } else {
      for (let i = 0; i < size; i++) v = v * 256 + this.buf[o + i];
    }
    if (signed && size < 8) {
      const max = 2 ** (size * 8);
      if (v >= max / 2) v -= max;
    }
    return v;
  }

  readBig(addr: number, size: number, endian: Endian = 'little', signed = false): bigint {
    if (!this.contains(addr, size)) throw new Error(`读取越界：0x${addr.toString(16)} + ${size}`);
    const o = this.off(addr);
    let v = 0n;
    if (endian === 'little') {
      for (let i = size - 1; i >= 0; i--) v = (v << 8n) | BigInt(this.buf[o + i]);
    } else {
      for (let i = 0; i < size; i++) v = (v << 8n) | BigInt(this.buf[o + i]);
    }
    if (signed) {
      const bits = BigInt(size * 8);
      const half = 1n << (bits - 1n);
      if (v >= half) v -= 1n << bits;
    }
    return v;
  }

  readFloat(addr: number, size: 4 | 8, endian: Endian = 'little'): number {
    if (!this.contains(addr, size)) throw new Error(`读取越界：0x${addr.toString(16)} + ${size}`);
    const o = this.off(addr);
    const dv = new DataView(this.buf.buffer, this.buf.byteOffset + o, size);
    return size === 4 ? dv.getFloat32(0, endian === 'little') : dv.getFloat64(0, endian === 'little');
  }

  bytesAt(addr: number, len: number): Uint8Array {
    if (!this.contains(addr, len)) throw new Error(`读取越界：0x${addr.toString(16)} + ${len}`);
    const o = this.off(addr);
    return this.buf.subarray(o, o + len);
  }

  write(addr: number, data: Uint8Array | number[]): void {
    const arr = data instanceof Uint8Array ? data : Uint8Array.from(data);
    if (!this.contains(addr, arr.length)) throw new Error(`写入越界：0x${addr.toString(16)} + ${arr.length}`);
    this.buf.set(arr, this.off(addr));
  }

  writeUInt(addr: number, size: number, value: number, endian: Endian = 'little'): void {
    const arr = new Uint8Array(size);
    let v = Math.trunc(value);
    if (v < 0) v += 2 ** (size * 8);
    for (let i = 0; i < size; i++) {
      const byte = v % 256;
      arr[endian === 'little' ? i : size - 1 - i] = byte;
      v = Math.floor(v / 256);
    }
    this.write(addr, arr);
  }

  clone(): Memory { return new Memory(this.buf.slice(), this.base); }
}

export function toHex(n: number, pad = 0): string {
  const neg = n < 0;
  const s = Math.abs(Math.trunc(n)).toString(16).toUpperCase();
  return `${neg ? '-' : ''}0x${s.padStart(pad, '0')}`;
}

/**
 * 严格 HEX 文本解析：支持空白分隔字节、连续偶数位 HEX、`0x` 前缀字节，
 * 以及 `hexdump -C` / `xxd` 风格的带地址转储。
 *
 * 与「尽量提取看起来像十六进制的内容」不同，这里宁可报错也不猜：
 * 奇数位、无法识别的字符、倒退/跳跃的地址、`*` 压缩行都会返回带行号的
 * 错误，调用方据此保留原有转储。地址列只用于校验连续性，不改变映射基址。
 */
export interface HexParseResult {
  bytes: Uint8Array;
  error?: string;
}

const HEXDUMP_LINE = /^\s*([0-9a-fA-F]{4,16})(?::|\s{2,})\s*(.*)$/;
const ADDRESS_ONLY = /^\s*([0-9a-fA-F]{4,16}):?\s*$/;

export function parseHexText(text: string): HexParseResult {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const nonEmpty: number[] = [];
  lines.forEach((l, i) => { if (l.trim()) nonEmpty.push(i); });
  const lastNonEmpty = nonEmpty.length ? nonEmpty[nonEmpty.length - 1] : -1;

  const hexdumpLike = nonEmpty.some((i) => {
    const m = HEXDUMP_LINE.exec(lines[i]);
    return !!m && /[0-9a-fA-F]{2}/.test(m[2].split('|')[0]);
  });

  const out: number[] = [];
  let expected: bigint | null = null;
  let sawData = false;

  const fail = (i: number, reason: string): HexParseResult =>
    ({ bytes: new Uint8Array(), error: `第 ${i + 1} 行：${reason}` });

  for (const i of nonEmpty) {
    let line = lines[i];
    const bar = line.indexOf('|');
    if (bar >= 0) line = line.slice(0, bar);
    line = line.replace(/[#;].*$/, '');
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed === '*') {
      return fail(i, '不支持 * 压缩行；请先导出未压缩的 HEX 内容');
    }

    if (hexdumpLike) {
      const addressOnly = ADDRESS_ONLY.exec(line);
      const dataLine = HEXDUMP_LINE.exec(line);
      const addressText = addressOnly?.[1] ?? dataLine?.[1];
      if (!addressText) {
        return fail(i, '格式混杂：带地址的转储里出现了无法识别的行');
      }
      const offset = BigInt(`0x${addressText}`);
      // xxd 的 ASCII 栏用两列以上空格分隔；hexdump -C 已在 `|` 处截断。
      const rest = (dataLine?.[2]?.split(/\s{2,}/)[0] ?? '').trim();

      // 末尾单独的地址行是 hexdump 的结束偏移，不是数据。
      if (!rest) {
        if (i !== lastNonEmpty) return fail(i, '地址行只能出现在末尾');
        if (!sawData) return fail(i, '只有地址，没有可解析的字节');
        if (expected !== null && offset !== expected) {
          return fail(i, `末尾地址 ${addressText} 与已读长度 ${expected.toString(16)} 不符`);
        }
        continue;
      }

      if (sawData && expected !== null && offset !== expected) {
        return fail(i, `地址 ${addressText} 不连续（应为 ${expected.toString(16)}）`);
      }
      const tokens = rest.split(/\s+/).filter(Boolean);
      for (const token of tokens) {
        if (!/^[0-9a-fA-F]{2}$/.test(token)) {
          return fail(i, `数据列包含无法识别的内容「${token}」`);
        }
        out.push(parseInt(token, 16));
      }
      sawData = true;
      expected = offset + BigInt(tokens.length);
      continue;
    }

    // 纯 HEX：每个空白/逗号分隔的标记必须是完整字节，0x 前缀只允许 1–2 位。
    const tokens = trimmed.split(/[\s,]+/).filter(Boolean);
    for (const token of tokens) {
      if (/^0x/i.test(token)) {
        const digits = token.slice(2);
        if (!/^[0-9a-fA-F]{1,2}$/.test(digits)) {
          return fail(i, `0x 字节「${token}」应为 1–2 位十六进制`);
        }
        out.push(parseInt(digits, 16));
        continue;
      }
      if (!/^[0-9a-fA-F]+$/.test(token)) {
        return fail(i, `无法识别的内容「${token}」`);
      }
      if (token.length % 2 !== 0) {
        return fail(i, `字节「${token}」只有奇数个十六进制位`);
      }
      for (let k = 0; k < token.length; k += 2) {
        out.push(parseInt(token.slice(k, k + 2), 16));
      }
    }
  }

  if (!out.length) return { bytes: new Uint8Array(), error: '没有找到可解析的十六进制字节' };
  return { bytes: Uint8Array.from(out) };
}

export function downloadBlob(data: Uint8Array, filename: string, mime = 'application/octet-stream'): void {
  const view = new Uint8Array(data);
  const blob = new Blob([view.buffer as ArrayBuffer], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
