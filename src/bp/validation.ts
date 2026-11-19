import { isByteSpan, ReadIssue } from './binary-read';

export const MAX_CHECK_BYTES = 16 << 20;

export function checksum(span: unknown, algo: string): bigint {
  if (!isByteSpan(span)) throw new ReadIssue('BAD_INPUT', '校验和需要一段完整的字节范围');
  const { bytes, base } = span.buffer;
  if (bytes.length > MAX_CHECK_BYTES) {
    throw new ReadIssue('READ_LIMIT', `校验范围超过 ${MAX_CHECK_BYTES} 字节；未计算任何部分结果`, BigInt(base));
  }
  if (algo === 'sum32') {
    let sum = 0;
    for (const byte of bytes) sum = (sum + byte) >>> 0;
    return BigInt(sum);
  }
  if (algo !== 'crc32') throw new ReadIssue('BAD_INPUT', '不支持的校验算法');
  let c = ~0;
  for (const byte of bytes) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return BigInt((~c) >>> 0);
}

type Numeric = number | bigint;

const valid = (v: unknown): v is Numeric => typeof v === 'bigint' || (typeof v === 'number'
  && Number.isFinite(v) && (!Number.isInteger(v) || Number.isSafeInteger(v)));

export function assertNumeric(actual: unknown, expected: unknown, max?: unknown, range = false) {
  if (!valid(actual) || !valid(expected) || (range && (!valid(max) || expected > max))) return '未能校验';
  const passes = range && valid(max)
    ? actual >= expected && actual <= max
    : (typeof actual === typeof expected ? actual === expected : !(actual < expected || actual > expected));
  return passes ? '通过' : '不通过';
}
