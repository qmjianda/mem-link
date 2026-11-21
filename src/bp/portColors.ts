/**
 * One color and one Chinese label per port type.
 *
 * The same map drives canvas ports, edge colors, the inspector, the node
 * palette and help dialogs. A color therefore means the same thing everywhere:
 * teal = number, blue = address, violet = object, orange = list, and so on.
 */

import type { PortType } from './types';

export const PORT_COLORS: Record<PortType, string> = {
  number: 'var(--type-number)',
  integer: 'var(--type-number)',
  numeric: 'var(--type-number)',
  address: 'var(--type-address)',
  'pack-address': 'var(--type-address)',
  offset: 'var(--type-offset)',
  index: 'var(--type-index)',
  string: 'var(--type-string)',
  bytes: 'var(--type-bytes)',
  span: 'var(--type-bytes)',
  boolean: 'var(--type-boolean)',
  instance: 'var(--type-instance)',
  list: 'var(--type-list)',
  buffer: 'var(--type-buffer)',
};

const PORT_LABELS: Partial<Record<PortType, string>> = {
  number: '数值',
  integer: '整数',
  numeric: '数值',
  address: '地址',
  'pack-address': '地址',
  offset: '偏移',
  index: '下标',
  string: '文本',
  bytes: '字节',
  span: '字节范围',
  boolean: '布尔',
  instance: '对象',
  list: '列表',
  buffer: '数据源',
};

const PORT_HINTS: Partial<Record<PortType, string>> = {
  list: '集合；接「元素解析」或「按下标取项」的列表输入',
  instance: '对象；接「元素解析」的元素输入，或展开嵌套字段',
  address: '地址；接地址/基准地址输入',
  'pack-address': '地址；接地址或平台地址输入',
  offset: '文件偏移；接偏移输入',
  index: '下标；接池下标输入',
  buffer: '数据源；接文件或继承上游文件',
  bytes: '原始字节；接字节范围/校验输入',
  span: '有界字节范围；接校验和输入',
};

export const PORT_LEGEND: Array<{ type: PortType; label: string }> = [
  { type: 'number', label: '数值' },
  { type: 'address', label: '地址' },
  { type: 'instance', label: '对象' },
  { type: 'list', label: '列表' },
  { type: 'bytes', label: '字节' },
  { type: 'string', label: '文本' },
  { type: 'buffer', label: '数据源' },
  { type: 'boolean', label: '布尔' },
];

export function portColor(type: PortType): string {
  return PORT_COLORS[type] ?? PORT_COLORS.buffer;
}

export function portTypeLabel(type: PortType): string {
  return PORT_LABELS[type] ?? type;
}

/** Short connection guidance used in port tooltips and the palette legend. */
export function portConnectHint(type: PortType): string {
  return PORT_HINTS[type] ?? '';
}

/** Primary output type used by node-library entries and node header dots. */
export const BUILTIN_PRIMARY_TYPE: Record<string, PortType> = {
  file: 'buffer',
  slice: 'span',
  readint: 'number',
  text: 'string',
  structread: 'instance',
  arrayread: 'list',
  listread: 'list',
  item: 'instance',
  element: 'instance',
  checksum: 'number',
  assert: 'boolean',
  address: 'address',
  ptrwalk: 'address',
  number: 'number',
  string: 'string',
  note: 'buffer',
  expr: 'number',
};

export function nodePrimaryType(kind: 'struct' | 'list' | 'array' | 'calc'): PortType {
  if (kind === 'list' || kind === 'array') return 'list';
  if (kind === 'calc') return 'number';
  return 'instance';
}
