import type { Endian } from '../core/types';
import { Memory } from '../core/mem';
import { addOffset, checkedBytes, integerInput, ReadIssue, scalarRead, stringRead } from './binary-read';
import { addressHex, addressInteger, isMappedAddress, mappedAddress } from './precision';
import { brandInstance, type BufferValue, type FieldView, type InstanceView, type PortSpec, type PortType } from './types';

export const SCALARS = ['u8', 'i8', 'u16', 'i16', 'u32', 'i32', 'u64', 'i64', 'f32', 'f64'] as const;
export const LAYOUT_FIELD_TYPES = [...SCALARS, 'bytes', 'string', 'bits'] as const;
export type ScalarType = typeof SCALARS[number];
type LayoutKind = typeof LAYOUT_FIELD_TYPES[number];
export const MAX_LAYOUT_BYTES = 1 << 20;
export const MAX_LAYOUT_FIELDS = 128;
export const MAX_FIELD_BYTES = 8 << 20;

/** Plain document data: numeric inputs are stored as text and validated before reads. */
export interface LayoutField {
  id: string;
  name: string;
  offset: string;
  kind: LayoutKind;
  size?: string;
  endian?: Endian;
  bitOffset?: string;
  bitWidth?: string;
  role?: 'address' | 'offset' | 'index';
}

export interface BinaryLayout {
  id: string;
  name: string;
  size: string;
  endian: Endian;
  fields: LayoutField[];
  nextField: number;
}

export function layoutIdValid(id: unknown): id is string {
  return typeof id === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(id);
}

export function validLayoutDocument(value: unknown): value is BinaryLayout[] {
  if (!Array.isArray(value) || value.length > 512) return false;
  const used = new Set<string>();
  return value.every((v) => {
    const l = v as Partial<BinaryLayout> | null;
    if (!l || !layoutIdValid(l.id) || used.has(l.id) || typeof l.name !== 'string' || typeof l.size !== 'string'
      || !['little', 'big'].includes(l.endian ?? '') || !Number.isSafeInteger(l.nextField) || l.nextField! < 1
      || !Array.isArray(l.fields) || l.fields.length > MAX_LAYOUT_FIELDS) return false;
    used.add(l.id);
    const ids = new Set<string>();
    return l.fields.every((f) => {
      if (!f || !layoutIdValid(f.id) || ids.has(f.id) || typeof f.name !== 'string' || typeof f.offset !== 'string'
        || !LAYOUT_FIELD_TYPES.includes(f.kind)) return false;
      ids.add(f.id);
      return [f.size, f.bitOffset, f.bitWidth].every(v => v === undefined || typeof v === 'string')
        && (f.endian === undefined || ['little', 'big'].includes(f.endian))
        && (f.role === undefined || ['address', 'offset', 'index'].includes(f.role));
    });
  });
}

export const fieldPort = (layoutId: string, id: string) => `field:${layoutId}:${id}`;

export function layoutFieldType(field: LayoutField): PortType {
  if (field.kind === 'bytes' || field.kind === 'string') return field.kind;
  if (field.kind.startsWith('f')) return 'number';
  return field.role ?? 'integer';
}

export function layoutPorts(layout?: BinaryLayout): PortSpec[] {
  return layout?.fields.map(f => ({ name: fieldPort(layout.id, f.id), label: f.name || '未命名字段', type: layoutFieldType(f) })) ?? [];
}

export function compileLayout(layout?: BinaryLayout) {
  if (!layout) throw new ReadIssue('INVALID_LAYOUT', '请选择有效的结构布局');
  try {
    if (!layout.name.trim()) throw new Error('请填写布局名称');
    const size = Number(integerInput(layout.size, '结构长度', 1n, BigInt(MAX_LAYOUT_BYTES)));
    if (!layout.fields.length) throw new Error('至少定义一个字段');
    const names = new Set<string>();
    const fields = layout.fields.map(f => {
      const name = f.name.trim();
      if (!name || names.has(name)) throw new Error(`字段名称为空或重复：${name || '未命名'}`);
      names.add(name);
      const offset = Number(integerInput(f.offset, `${name} 的偏移`, 0n, BigInt(size)));
      const width = f.kind === 'string' || f.kind === 'bytes' || f.kind === 'bits'
        ? Number(integerInput(f.size ?? '1', `${name} 的长度`, 1n, BigInt(size)))
        : Number(f.kind.slice(1)) / 8;
      if (offset + width > size) throw new Error(`字段「${name}」超出结构范围`);
      let shift = 0;
      let bits = 0;
      if (f.kind === 'bits') {
        if (![1, 2, 4, 8].includes(width)) throw new Error(`字段「${name}」的存储宽度应为 1、2、4 或 8 字节`);
        shift = Number(integerInput(f.bitOffset ?? '0', `${name} 的位偏移`, 0n, BigInt(width * 8 - 1)));
        bits = Number(integerInput(f.bitWidth ?? '1', `${name} 的位宽`, 1n, BigInt(width * 8 - shift)));
      }
      return { f, offset, width, shift, bits };
    });
    if (fields.reduce((n, f) => n + f.width, 0) > MAX_FIELD_BYTES) throw new Error('字段总读取量超出布局预算');
    return { layout, size, fields };
  } catch (err) {
    throw new ReadIssue('INVALID_LAYOUT', err instanceof Error ? err.message : String(err));
  }
}

export function displayField(value: unknown): string {
  if (value instanceof Uint8Array) return [...value.subarray(0, 24)].map(b => b.toString(16).padStart(2, '0')).join(' ')
    + (value.length > 24 ? ` … (${value.length} B)` : '');
  if (typeof value === 'string') return JSON.stringify(value);
  if (isMappedAddress(value)) return addressHex(value.value);
  return String(value ?? '∅');
}

export function readLayout(src: BufferValue, at: bigint, spec: ReturnType<typeof compileLayout>, index?: number): InstanceView {
  const { layout, size, fields: defs } = spec;
  const bytes = checkedBytes(src, at, size);
  const fields: FieldView[] = defs.map(({ f, offset, width, shift, bits }) => {
    const start = addOffset(at, BigInt(offset));
    const endian = f.endian ?? layout.endian;
    const raw = f.kind === 'bytes' ? bytes.subarray(offset, offset + width)
      : f.kind === 'string' ? stringRead(src, start, BigInt(width), 'fixed', 'utf-8').text
        : f.kind === 'bits' ? (scalarRead(src, start, `u${width * 8}`, endian).raw >> BigInt(shift)) & ((1n << BigInt(bits)) - 1n)
          : scalarRead(src, start, f.kind, endian).value;
    const type = layoutFieldType(f);
    const target = type === 'address' ? addressInteger(raw) : undefined;
    const value = type === 'address' ? (target === undefined ? undefined : mappedAddress(src, target)) : raw;
    return {
      name: fieldPort(layout.id, f.id), label: f.name, kind: f.kind, type: f.kind, portType: type,
      offset, size: width, raw, value, rawDisplay: displayField(raw), display: displayField(value),
    };
  });
  return brandInstance({
    addr: 0, location: mappedAddress(src, at), layoutId: layout.id,
    typeName: layout.name, index, size, fields, mem: new Memory(bytes),
  });
}

export function readScalarItem(src: BufferValue, at: bigint, kind: string, endian: Endian, index: number): InstanceView {
  const { value, width } = scalarRead(src, at, kind, endian);
  const type = typeof value === 'number' ? 'number' : 'integer';
  return brandInstance({
    addr: 0, location: mappedAddress(src, at), index, typeName: kind, size: width,
    mem: new Memory(checkedBytes(src, at, width)),
    fields: [{
      name: 'value', label: '值', type: kind, kind: kind as ScalarType, portType: type,
      offset: 0, size: width, raw: value, value, rawDisplay: displayField(value), display: displayField(value),
    }],
  });
}
