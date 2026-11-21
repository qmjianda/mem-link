/// <reference path="../types/memlink-bp.d.ts" />

// 示例：索引入口链表 + 数组 + 计算节点
const BASE = 0x100;
const STRIDE = 24;

const idxToAddr = (v: unknown) => {
  const n = Number(v);
  return n < 0 ? null : BASE + n * STRIDE;
};

const Header = struct('Header', [
  u16('magic', { format: 'hex' }),
  u16('head', { transform: (v) => idxToAddr(v) }),
  u16('tail', { transform: (v) => idxToAddr(v) }),
  u16('count'),
]);

const Entry = struct('Entry', [
  i16('next', { transform: (v) => idxToAddr(v) }),
  i16('prev', { transform: (v) => idxToAddr(v) }),
  u16('flags', { format: 'hex' }),
  u16('refcount'),
  str('name', { size: 12 }),
  u32('ts', { format: 'time' }),
]);

const Meta = struct('Meta', [
  bits('kind', 2),
  bits('active', 1),
  bits('mode', 3),
  u8('reserved'),
]);

export default definePack({
  name: 'demo-index-list',
  endian: 'little',
  pointerSize: 4,
  constants: { BASE, STRIDE, NULL_INDEX: -1 },
  types: { Header, Entry, Meta },
  nodes: {
    header: structNode(Header, { label: 'Header 文件头' }),
    meta: structNode(Meta, { label: 'Meta 元数据' }),
    entryList: listNode(Entry, {
      label: 'Entry 链表',
      next: (e) => {
        const v = e.value.next;
        return typeof v === 'number' && v >= 0 ? v : null;
      },
      nulls: [-1],
      max: 256,
    }),
    entryArray: arrayNode(Entry, { label: 'Entry 数组', count: 8, stride: 24 }),
    indexToAddr: calcNode({
      label: '下标 → 地址',
      inputs: { index: 'number' },
      outputs: { address: 'number' },
      run: ({ index }) => ({ address: BASE + Number(index) * STRIDE }),
    }),
  },
});
