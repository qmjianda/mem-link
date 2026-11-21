/// <reference path="../../types/memlink-bp.d.ts" />

// 模板：嵌套类型与定长数组。直接传类型对象，嵌套类型自动登记。
const Entry = struct('Entry', [u16('id'), u16('value')]);
const Table = struct('Table', [
  u16('count'),
  array('entries', Entry, 4),
  array('raw', 'u8', 8),
]);

export default definePack({
  name: 'template-nested-array',
  endian: 'little',
  pointerSize: 4,
  types: { Table },
  nodes: { table: structNode(Table, { label: 'Table' }) },
});
