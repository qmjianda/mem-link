import type { Endian } from '../core/types';
import type { BufferValue } from './types';
import {
  addressHex, addressInteger, exactInteger, isMappedAddress, mappedAddress, MAX_ADDRESS, MIN_INTEGER, offsetIn, sameMapping,
} from './precision';

export class ReadIssue extends Error {
  constructor(readonly code: 'BAD_INPUT' | 'NO_SOURCE' | 'SOURCE_CONFLICT' | 'OUT_OF_BOUNDS'
    | 'READ_LIMIT' | 'MISSING_TERMINATOR' | 'INVALID_ENCODING' | 'UNMAPPED_POINTER' | 'INVALID_LAYOUT'
    | 'TRUNCATED' | 'INDEX_OUT_OF_RANGE' | 'RECORD_CYCLE' | 'ASSERT_FAILED' | 'ASSERT_UNAVAILABLE',
  message: string, readonly address?: bigint, readonly length?: number) {
    super(message);
  }
}

export function requireSource(buffer?: BufferValue, note?: string): BufferValue {
  if (!buffer) throw new ReadIssue('NO_SOURCE', note ?? '请选择或连接已载入的转储');
  return buffer;
}

export function integerInput(value: unknown, label: string, min = MIN_INTEGER, max = MAX_ADDRESS): bigint {
  const n = exactInteger(value);
  if (n === undefined || n < min || n > max) throw new ReadIssue('BAD_INPUT', `${label}：需要 ${min}–${max} 内的整数`);
  return n;
}

export function addressIn(value: unknown, buffer: BufferValue): bigint {
  if (isMappedAddress(value)) {
    if (!sameMapping(value, buffer)) throw new ReadIssue('SOURCE_CONFLICT', '输入地址与选定的数据源不属于同一映射', value.value);
    return value.value;
  }
  const addr = addressInteger(value);
  if (addr === undefined) throw new ReadIssue('BAD_INPUT', '地址：需要无符号 64 位地址');
  return addr;
}

export function addOffset(base: bigint, delta: bigint): bigint {
  const address = base + delta;
  if (address < 0n || address > MAX_ADDRESS) {
    throw new ReadIssue('BAD_INPUT', `换算结果 ${addressHex(address)} 超出无符号 64 位地址范围`);
  }
  return address;
}

interface ByteSpan {
  readonly buffer: BufferValue;
}

const spans = new WeakSet<object>();

export function isByteSpan(value: unknown): value is ByteSpan {
  return typeof value === 'object' && value !== null && spans.has(value);
}

/** Bounded view, sharing original storage and mapping; not a new raw byte array. */
export function byteSpan(src: BufferValue, at: bigint, length: bigint): ByteSpan {
  if (length > BigInt(src.bytes.length)) {
    const available = offsetIn(src, at, 0);
    throw new ReadIssue('OUT_OF_BOUNDS', `${addressHex(at)} 的 ${length} 字节范围不可用`, at,
      available === undefined ? 0 : src.bytes.length - available);
  }
  const bytes = checkedBytes(src, at, Number(length));
  const span: ByteSpan = Object.freeze({
    buffer: {
      ...src, bytes,
      base: at, mappingBase: src.mappingBase ?? src.base,
    },
  });
  spans.add(span);
  return span;
}

export function checkedBytes(src: BufferValue, address: bigint, length: number): Uint8Array {
  const off = offsetIn(src, address, length);
  if (off === undefined) {
    throw new ReadIssue('OUT_OF_BOUNDS', `${addressHex(address)} 起 ${length} 字节超出可读范围`, address, length);
  }
  return src.bytes.subarray(off, off + length);
}

export function scalarRead(
  src: BufferValue, addr: bigint, kind: string, endian: Endian,
): { value: number | bigint; raw: bigint; width: number } {
  const width = Number(kind.slice(1)) / 8;
  if (!/^(?:[ui](?:8|16|32|64)|f(?:32|64))$/.test(kind)) {
    throw new ReadIssue('BAD_INPUT', '未知数值类型');
  }
  const bytes = checkedBytes(src, addr, width);
  let raw = 0n;
  for (let i = 0; i < width; i++) {
    raw = (raw << 8n) | BigInt(bytes[endian === 'little' ? width - i - 1 : i]);
  }
  if (kind.startsWith('f')) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, width);
    const value = width === 4 ? view.getFloat32(0, endian === 'little') : view.getFloat64(0, endian === 'little');
    return { value, raw, width };
  }
  return { value: kind.startsWith('i') ? BigInt.asIntN(width * 8, raw) : raw, raw, width };
}

export type TextEncoding = 'ascii' | 'utf-8' | 'utf-16le' | 'utf-16be';
export const TEXT_READ_LIMIT = 1 << 20;

export function stringRead(
  src: BufferValue, address: bigint, length: bigint, mode: 'fixed' | 'nul', encoding: TextEncoding,
): { text: string; length: number } {
  if (length > BigInt(TEXT_READ_LIMIT)) throw new ReadIssue('READ_LIMIT', `字符串读取上限为 ${TEXT_READ_LIMIT} 字节`, address);
  if (length < 0n) throw new ReadIssue('BAD_INPUT', '字符串长度不能为负数', address);
  const units = encoding === 'utf-16le' || encoding === 'utf-16be' ? 2 : 1;
  let bytes: Uint8Array;
  let used: number;
  if (mode === 'fixed') {
    used = Number(length);
    bytes = checkedBytes(src, address, used);
  } else {
    const off = offsetIn(src, address);
    if (off === undefined) throw new ReadIssue('OUT_OF_BOUNDS', `字符串起点 ${addressHex(address)} 不可读`, address);
    const max = Math.min(Number(length), src.bytes.length - off);
    const scan = src.bytes.subarray(off, off + max);
    let end = -1;
    for (let at = 0; at + units <= max; at += units) {
      if (scan[at] === 0 && (units === 1 || scan[at + 1] === 0)) { end = at; break; }
    }
    if (end < 0) throw new ReadIssue('MISSING_TERMINATOR', `${addressHex(address)} 起 ${max} 字节内未找到终止符`, address, max);
    bytes = scan.subarray(0, end);
    used = end + units;
  }
  try {
    if (encoding === 'ascii') {
      if (bytes.some((b) => b > 0x7f)) throw new Error();
      return { text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes), length: used };
    }
    return { text: new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(bytes), length: used };
  } catch {
    throw new ReadIssue('INVALID_ENCODING', `${addressHex(address)} 起的字节不是有效的 ${encoding.toUpperCase()}`, address, used);
  }
}

export function pointerRead(src: BufferValue, at: bigint, width: 4 | 8, endian: Endian, nil = 0n) {
  const raw = scalarRead(src, at, width === 4 ? 'u32' : 'u64', endian).raw;
  if (raw === nil) return { raw, state: 'null' as const };
  if (offsetIn(src, raw) === undefined) return { raw, state: 'unmapped' as const };
  return { raw, state: 'mapped' as const, target: mappedAddress(src, raw) };
}
