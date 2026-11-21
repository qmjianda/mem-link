/// <reference path="../../types/memlink-bp.d.ts" />

// 模板：pack 引用蓝图布局。布局 id 使用稳定的 layout/<id>。
const Header = layoutType('layout/header');

export default definePack({
  name: 'template-layout-ref',
  endian: 'little',
  pointerSize: 4,
  types: { Header },
  nodes: { header: structNode(Header, { label: 'Header（来自布局）' }) },
});
