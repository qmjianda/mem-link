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

/** Best effort hex text parser: plain hex, 0x-prefixed lists, or classic hexdump output. */
export function parseHexText(text: string): { bytes: Uint8Array; error?: string } {
  const lines = text.split(/\r?\n/);
  const out: number[] = [];
  const hexdumpLike = lines.some((l) => /^\s*[0-9a-fA-F]{4,16}\s{2,}[0-9a-fA-F]{2}/.test(l));
  for (const rawLine of lines) {
    let line = rawLine;
    const bar = line.indexOf('|');
    if (bar >= 0) line = line.slice(0, bar);
    line = line.replace(/[#;].*$/, '');
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (hexdumpLike) {
      line = line.replace(/^\s*[0-9a-fA-F]{4,16}\s+/, '');
      line = line.replace(/\s+[0-9a-fA-F]{4,16}\s*$/, ''); // trailing offset column
    }
    const tokens = line.match(/0x[0-9a-fA-F]+|[0-9a-fA-F]{2}\b|\b[0-9a-fA-F]{2}\b/g);
    if (!tokens) continue;
    if (hexdumpLike) {
      for (const t of tokens) out.push(parseInt(t.replace(/^0x/i, ''), 16) & 0xff);
    } else {
      // if the line is a run of pairs without separators, split it
      const clean = line.replace(/0x/gi, '').replace(/[^0-9a-fA-F]/g, '');
      if (clean.length >= 2 && tokens.length === 1 && clean.length > 2) {
        for (let i = 0; i + 1 < clean.length; i += 2) out.push(parseInt(clean.slice(i, i + 2), 16));
      } else {
        for (const t of tokens) out.push(parseInt(t.replace(/^0x/i, ''), 16) & 0xff);
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
