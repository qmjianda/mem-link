/// <reference path="../../types/memlink-bp.d.ts" />

// 模板：自动排布。字段按声明顺序落位；需要固定位置时加 at。
const Header = struct('Header', [
  u16('magic', { format: 'hex' }),
  u16('head'),
  u16('tail'),
  u16('count'),
]);

export default definePack({
  name: 'template-auto-layout',
  endian: 'little',
  pointerSize: 4,
  types: { Header },
  nodes: { header: structNode(Header, { label: 'Header' }) },
});
