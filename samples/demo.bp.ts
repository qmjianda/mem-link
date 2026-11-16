/// <reference path="../types/memlink-bp.d.ts" />

// 示例：索引入口链表 + 数组 + 计算节点
const BASE = 0x100;
const STRIDE = 24;

const idxToAddr = (v: unknown) => {
  const n = Number(v);
  return n < 0 ? null : BASE + n * STRIDE;
};

const Header = struct('Header', 8, [
  u16('magic', 0, { format: 'hex' }),
  u16('head', 2, { transform: (v) => idxToAddr(v) }),
  u16('tail', 4, { transform: (v) => idxToAddr(v) }),
  u16('count', 6),
]);

const Entry = struct('Entry', 24, [
  i16('next', 0, { transform: (v) => idxToAddr(v) }),
  i16('prev', 2, { transform: (v) => idxToAddr(v) }),
  u16('flags', 4, { format: 'hex' }),
  u16('refcount', 6),
  str('name', 8, 12),
  u32('ts', 20, { format: 'time' }),
]);

const Meta = struct('Meta', 2, [
  bits('kind', 0, 2, 0, 2),
  bits('active', 0, 2, 2, 1),
  bits('mode', 0, 2, 3, 3),
  u8('reserved', 1),
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
