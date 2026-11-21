/// <reference path="../../types/memlink-bp.d.ts" />

// 模板：池下标链表。next 返回值是下一项地址；-1 表示结束。
const BASE = 0x100;
const STRIDE = 8;
const Entry = struct('Entry', [
  i16('next'),
  u16('value'),
  u32('pad'),
]);

export default definePack({
  name: 'template-pool-list',
  endian: 'little',
  pointerSize: 4,
  constants: { BASE, STRIDE },
  types: { Entry },
  nodes: {
    entry: structNode(Entry, { label: 'Entry' }),
    chain: listNode(Entry, {
      label: 'Entry 链表',
      next: (e) => {
        const idx = Number(e.value.next);
        return Number.isInteger(idx) && idx >= 0 ? BASE + idx * STRIDE : null;
      },
      nulls: [-1],
      max: 256,
    }),
  },
});
