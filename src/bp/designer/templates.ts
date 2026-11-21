import type { BinaryLayout } from '../layouts';
import { nextLayoutId, uniqueLayoutName } from './operations';

export type DesignerTemplate = 'header' | 'bitfield' | 'nested-array' | 'pool-list';

export const DESIGNER_TEMPLATES: Array<{ id: DesignerTemplate; label: string; detail: string }> = [
  { id: 'header', label: '表头', detail: 'magic / version / count / flags' },
  { id: 'bitfield', label: '位域', detail: '2 字节存储单元 + 具名位段' },
  { id: 'nested-array', label: '嵌套数组', detail: 'Entry 被 Table 以定长数组引用' },
  { id: 'pool-list', label: '池下标链表', detail: 'next / value / pad' },
];

function baseLayout(layouts: BinaryLayout[], name: string): BinaryLayout {
  return {
    id: nextLayoutId(layouts),
    name: uniqueLayoutName(layouts, name),
    endian: 'little',
    fields: [],
  };
}

export function createTemplate(id: DesignerTemplate, layouts: BinaryLayout[]): BinaryLayout[] {
  if (id === 'header') {
    const l = baseLayout(layouts, 'Header');
    l.fields = [
      { id: 'f1', name: 'magic', kind: 'u16' },
      { id: 'f2', name: 'version', kind: 'u16' },
      { id: 'f3', name: 'count', kind: 'u32' },
      { id: 'f4', name: 'kind', kind: 'bits', at: '8', bit: '0', width: '2', unit: '2' },
      { id: 'f5', name: 'active', kind: 'bits', at: '8', bit: '2', width: '1', unit: '2' },
      { id: 'f6', name: 'mode', kind: 'bits', at: '8', bit: '3', width: '3', unit: '2' },
    ];
    return [l];
  }
  if (id === 'bitfield') {
    const l = baseLayout(layouts, 'Flags');
    l.fields = [
      { id: 'f1', name: 'kind', kind: 'bits', at: '0', bit: '0', width: '2', unit: '2' },
      { id: 'f2', name: 'active', kind: 'bits', at: '0', bit: '2', width: '1', unit: '2' },
      { id: 'f3', name: 'mode', kind: 'bits', at: '0', bit: '3', width: '3', unit: '2' },
      { id: 'f4', name: 'ready', kind: 'bits', at: '0', bit: '6', width: '1', unit: '2' },
      { id: 'f5', name: 'error', kind: 'bits', at: '0', bit: '7', width: '1', unit: '2' },
    ];
    return [l];
  }
  if (id === 'nested-array') {
    const entry = baseLayout(layouts, 'Entry');
    entry.fields = [
      { id: 'f1', name: 'id', kind: 'u16' },
      { id: 'f2', name: 'value', kind: 'u16' },
    ];
    const table = baseLayout([...layouts, entry], 'Table');
    table.fields = [
      { id: 'f1', name: 'count', kind: 'u16' },
      { id: 'f2', name: 'entries', kind: 'array', of: `layout/${entry.id}`, count: '4' },
    ];
    return [entry, table];
  }
  const entry = baseLayout(layouts, 'Entry');
  entry.fields = [
    { id: 'f1', name: 'next', kind: 'i16' },
    { id: 'f2', name: 'value', kind: 'u16' },
    { id: 'f3', name: 'pad', kind: 'u32' },
  ];
  return [entry];
}
