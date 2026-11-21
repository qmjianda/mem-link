/// <reference path="../../types/memlink-bp.d.ts" />

// 模板：位域。相邻 bits 自动并入最小存储单元；unit / bit 可显式控制。
const Flags = struct('Flags', [
  bits('kind', 2),
  bits('active', 1),
  bits('mode', 3),
  u8('reserved'),
]);

export default definePack({
  name: 'template-bitfields',
  endian: 'little',
  pointerSize: 4,
  types: { Flags },
  nodes: { flags: structNode(Flags, { label: 'Flags' }) },
});
