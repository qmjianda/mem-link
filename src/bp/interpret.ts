import { addressHex, exactInteger } from './precision';

export type ValueFormat = 'decimal' | 'hex' | 'binary' | 'time' | 'enum' | 'flags';

function mappingOf(text: string): Map<bigint, string> {
  const map = new Map<bigint, string>();
  const rows = text.split(/[,;\n]/).map(s => s.trim()).filter(Boolean);
  for (const row of rows) {
    const eq = row.indexOf('=');
    const key = eq > 0 ? exactInteger(row.slice(0, eq)) : undefined;
    const label = eq > 0 ? row.slice(eq + 1).trim() : '';
    if (key === undefined || !label || map.has(key)) throw new Error(`无法识别映射「${row}」`);
    map.set(key, label);
  }
  return map;
}

export function interpretValue(value: bigint | number, format: ValueFormat, mapping = '', timeUnit = 's'): string {
  if (format === 'decimal') return String(value);
  if (format === 'time') {
    const millis = typeof value === 'bigint'
      ? Number(timeUnit === 'ms' ? value : timeUnit === 'us' ? value / 1000n : value * 1000n)
      : timeUnit === 'ms' ? value : timeUnit === 'us' ? value / 1000 : value * 1000;
    const date = new Date(millis);
    return Number.isFinite(date.valueOf()) ? date.toISOString() : '超出 UTC 日期范围';
  }
  const integer = exactInteger(value);
  if (integer === undefined) return '此格式需要整数';
  if (format === 'hex') return addressHex(integer);
  if (format === 'binary') return integer < 0n ? `-0b${(-integer).toString(2)}` : `0b${integer.toString(2)}`;
  const names = mappingOf(mapping);
  if (format === 'enum') return names.get(integer) ?? `未定义 (${integer})`;
  const bits = BigInt.asUintN(64, integer);
  if (names.size) {
    return [...names].filter(([mask]) => mask > 0n && (mask & bits) === mask).map(([, name]) => name).join(' | ') || '没有匹配的标志';
  }
  return Array.from({ length: 64 }, (_, i) => i).filter(i => (bits & (1n << BigInt(i))) !== 0n).join(', ') || '无置位';
}
