import type { CType, Field } from '../core/types';

export function typeLabel(t: CType): string {
  switch (t.k) {
    case 'int': {
      const bits = t.size * 8;
      if (bits === 8) return t.signed ? 'int8_t' : 'uint8_t';
      if (bits === 16) return t.signed ? 'int16_t' : 'uint16_t';
      if (bits === 32) return t.signed ? 'int32_t' : 'uint32_t';
      return t.signed ? 'int64_t' : 'uint64_t';
    }
    case 'char': return 'char';
    case 'bool': return 'bool';
    case 'float': return t.size === 4 ? 'float' : 'double';
    case 'ptr': return 'void *';
    case 'array': return `${typeLabel(t.elem)}[${t.count}]`;
    case 'record': return t.name;
  }
}

export function fieldTypeLabel(f: Field): string {
  if (f.bitWidth != null) return `${typeLabel(f.type)} : ${f.bitWidth}`;
  return typeLabel(f.type);
}

export function addr(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return `0x${Math.abs(Math.trunc(n)).toString(16).toUpperCase()}`;
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function hex32(n: number): string {
  return `0x${Math.max(0, Math.trunc(n)).toString(16).toUpperCase().padStart(8, '0')}`;
}
