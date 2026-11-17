import { describe, expect, it } from 'vitest';
import demoSource from '../samples/demo.bp.ts?raw';
import { loadBlueprintPack } from '../src/bp/load';
import { findRowPathByAddr, focusFromTruncation, StructTree } from '../src/bp/tree';
import type { BlueprintPack, ListNodeDef } from '../src/bp/types';
import { Memory } from '../src/core/mem';
import { array, record, struct, u16, u32, u8 } from '../src/core/pack';
import { demoBinary } from './demo-bin';

function loadDemo(): BlueprintPack {
  const r = loadBlueprintPack(demoSource);
  expect(r.error).toBeUndefined();
  return r.pack!;
}

const demoPack = loadDemo();

function listTree(base = 0x130, memSize = 0x400) {
  const bytes = new Uint8Array(memSize);
  bytes.set(demoBinary());
  const mem = new Memory(bytes, 0);
  const def = demoPack.nodes.entryList as ListNodeDef;
  return new StructTree({
    kind: 'list', pack: demoPack, type: def.type, mem, addr: base,
    next: def.next, nulls: def.nulls, max: def.max,
  });
}

describe('struct tree model', () => {
  it('根行默认收起，展开后给出字段', () => {
    const tree = new StructTree({
      kind: 'struct', pack: demoPack, type: demoPack.types.Header,
      mem: new Memory(demoBinary(), 0), addr: 0,
    });
    expect(tree.rows(new Set(), '')).toHaveLength(1);
    const rows = tree.rows(new Set([tree.rootPath]), '');
    expect(rows[0].label).toBe('Header');
    expect(rows.slice(1).map((r) => r.label)).toEqual(['magic', 'head', 'tail', 'count']);
    expect(rows.find((r) => r.label === 'magic')?.valueText).toBe('0xBEEF');
    // transform 的值以转换后为准，原始值留在 rawText
    const head = rows.find((r) => r.label === 'head');
    expect(head?.valueText.startsWith('0x')).toBe(true);
    expect(head?.rawText).toBeTruthy();
  });

  it('链表按 next 走完整条链，路径与地址正确', () => {
    const tree = listTree();
    const rows = tree.rows(new Set([tree.rootPath]), '');
    const elements = rows.filter((r) => r.tone === 'element');
    expect(elements.map((r) => r.label)).toEqual(['[0]', '[1]', '[2]', '[3]']);
    expect(elements.map((r) => r.addr)).toEqual([0x130, 0x178, 0x118, 0x1a8]);
    expect(tree.summary()).toBe('4 项');
    expect(rows.some((r) => r.tone === 'more')).toBe(false);
  });

  it('展开链表元素后能看到字段', () => {
    const tree = listTree();
    const rows = tree.rows(new Set([tree.rootPath, 'Entry[0]']), '');
    const name = rows.find((r) => r.path === 'Entry[0].name');
    expect(name?.valueText).toBe('"alpha"');
    expect(name?.depth).toBe(2);
  });

  it('链表下标跳转会把目标行加载出来', () => {
    const tree = listTree();
    expect(tree.locateIndex(2)).toEqual({ path: 'Entry[2]' });
    expect(tree.locateIndex(9).error).toContain('链表只有 4 项');
    expect(tree.locateIndex(-1).error).toBeTruthy();
  });

  it('数组按下标定位，越界时报错', () => {
    const tree = new StructTree({
      kind: 'array', pack: demoPack, type: demoPack.types.Entry,
      mem: new Memory(demoBinary(), 0), addr: 0x100, count: 8, stride: 24,
    });
    const rows = tree.rows(new Set([tree.rootPath]), '');
    expect(rows.filter((r) => r.tone === 'element')).toHaveLength(8);
    expect(tree.locateIndex(7)).toEqual({ path: 'Entry[7]' });
    expect(tree.locateIndex(8).error).toContain('越界');
    expect(tree.summary()).toBe('8 项');
  });

  it('大数组分页，加载更多会追加一页', () => {
    const tree = new StructTree({
      kind: 'array', pack: demoPack, type: demoPack.types.Entry,
      mem: new Memory(new Uint8Array(0x8000), 0), addr: 0, count: 500, stride: 24,
    });
    const opened = tree.rows(new Set([tree.rootPath]), '');
    expect(opened.filter((r) => r.tone === 'element')).toHaveLength(200);
    const more = opened.find((r) => r.tone === 'more');
    expect(more?.valueText).toContain('200 / 500');
    tree.loadMore(more!.moreOf!);
    const next = tree.rows(new Set([tree.rootPath]), '');
    expect(next.filter((r) => r.tone === 'element')).toHaveLength(400);
  });

  it('搜索只过滤已展开的行，并保留命中行的祖先', () => {
    const tree = listTree();
    const collapsed = tree.rows(new Set([tree.rootPath]), 'name');
    expect(collapsed).toHaveLength(0);
    const expanded = tree.rows(new Set([tree.rootPath, 'Entry[0]']), 'name');
    expect(expanded.map((r) => r.path)).toEqual(['Entry', 'Entry[0]', 'Entry[0].name']);
  });

  it('地址能在已加载的行里定位', () => {
    const rows = listTree().rows(new Set(['Entry']), '');
    expect(findRowPathByAddr(rows, 0x178)).toBe('Entry[1]');
    expect(findRowPathByAddr(rows, 0x999)).toBeUndefined();
  });

  it('搜索状态下仍保留「加载更多」行', () => {
    const tree = new StructTree({
      kind: 'array', pack: demoPack, type: demoPack.types.Entry,
      mem: new Memory(new Uint8Array(0x8000), 0), addr: 0, count: 500, stride: 24,
    });
    const rows = tree.rows(new Set([tree.rootPath]), '0x');
    expect(rows.filter((r) => r.tone === 'element')).toHaveLength(200);
    expect(rows.find((r) => r.tone === 'more')?.moreOf).toBe(tree.rootPath);
  });
});

describe('struct tree nested decode', () => {
  const Inner = struct('Inner', 4, [u16('a', 0), u16('b', 2)]);
  const Outer = struct('Outer', 16, [
    u8('kind', 0),
    array('items', 4, 'Inner', 2),
    record('one', 12, 'Inner'),
  ]);
  const pack: BlueprintPack = {
    name: 'nested', endian: 'little', pointerSize: 4, constants: {},
    types: { Inner, Outer }, nodes: {},
  };

  function mem(): Memory {
    const bytes = new Uint8Array(64);
    bytes[0] = 7;
    // items[0] = {a:1,b:2}
    bytes[4] = 1; bytes[6] = 2;
    // items[1] = {a:3,b:4}
    bytes[8] = 3; bytes[10] = 4;
    // one = {a:5,b:6}
    bytes[12] = 5; bytes[14] = 6;
    return new Memory(bytes, 0x100);
  }

  it('嵌套数组按元素展开，元素再展开成字段', () => {
    const tree = new StructTree({ kind: 'struct', pack, type: Outer, mem: mem(), addr: 0x100 });
    const level1 = tree.rows(new Set([tree.rootPath]), '');
    const items = level1.find((r) => r.path === 'Outer.items');
    expect(items?.valueText).toBe('[2]');
    expect(items?.expandable).toBe(true);

    const level2 = tree.rows(new Set([tree.rootPath, 'Outer.items']), '');
    const elems = level2.filter((r) => r.path.startsWith('Outer.items['));
    expect(elems.map((r) => r.label)).toEqual(['[0]', '[1]']);

    const level3 = tree.rows(new Set([tree.rootPath, 'Outer.items', 'Outer.items[1]']), '');
    expect(level3.find((r) => r.path === 'Outer.items[1].a')?.valueText).toBe('3');
    expect(level3.find((r) => r.path === 'Outer.items[1].b')?.valueText).toBe('4');
  });

  it('嵌套 record 直接展开成字段', () => {
    const tree = new StructTree({ kind: 'struct', pack, type: Outer, mem: mem(), addr: 0x100 });
    const rows = tree.rows(new Set([tree.rootPath, 'Outer.one']), '');
    expect(rows.find((r) => r.path === 'Outer.one.a')?.valueText).toBe('5');
    expect(rows.find((r) => r.path === 'Outer.one.b')?.valueText).toBe('6');
  });

  it('越界地址给出错误行而不是抛异常', () => {
    const tree = new StructTree({ kind: 'struct', pack, type: Outer, mem: mem(), addr: 0x9000 });
    const rows = tree.rows(new Set([tree.rootPath]), '');
    expect(rows.some((r) => r.tone === 'error' && r.label.includes('不在缓冲区'))).toBe(true);
  });

  it('结构体里的嵌套数组也能按下标跳转', () => {
    const tree = new StructTree({ kind: 'struct', pack, type: Outer, mem: mem(), addr: 0x100 });
    tree.rows(new Set([tree.rootPath]), '');
    expect(tree.hasContainer()).toBe(true);
    expect(tree.defaultIndexPath()).toBe('Outer.items');
    expect(tree.locateIndex(1)).toEqual({ path: 'Outer.items[1]' });
    expect(tree.locateIndex(1, 'Outer.items')).toEqual({ path: 'Outer.items[1]' });
    expect(tree.locateIndex(2, 'Outer.items').error).toContain('越界');
    expect(tree.locateIndex(0, 'Outer.kind').error).toBeTruthy();
    expect(tree.rows(new Set([tree.rootPath, 'Outer.items', 'Outer.items[1]']), '')
      .some((r) => r.path === 'Outer.items[1].a')).toBe(true);
  });
});

describe('struct tree pointer follow', () => {
  const Node = struct('Node', 8, [
    u32('next', 0, { follow: 'self' }),
    u32('value', 4),
  ]);
  const pack: BlueprintPack = {
    name: 'chain', endian: 'little', pointerSize: 4, constants: {},
    types: { Node }, nodes: {},
  };
  const bytes = new Uint8Array(64);
  const at = (addr: number) => addr - 0x100;
  const put32 = (addr: number, v: number) => {
    const o = at(addr);
    bytes[o] = v & 0xff;
    bytes[o + 1] = (v >> 8) & 0xff;
    bytes[o + 2] = (v >> 16) & 0xff;
    bytes[o + 3] = (v >> 24) & 0xff;
  };
  put32(0x100, 0x110);
  put32(0x104, 11);
  put32(0x110, 0);
  put32(0x114, 22);
  const mem = new Memory(bytes, 0x100);

  it('follow 字段可以就地在树里展开目标结构', () => {
    const tree = new StructTree({ kind: 'struct', pack, type: Node, mem, addr: 0x100 });
    const rows = tree.rows(new Set([tree.rootPath]), '');
    const next = rows.find((r) => r.label === 'next');
    expect(next?.expandable).toBe(true);
    expect(next?.ref?.addr).toBe(0x110);

    const deeper = tree.rows(new Set([tree.rootPath, 'Node.next']), '');
    expect(deeper.find((r) => r.path === 'Node.next>Node.value')?.valueText).toBe('22');
  });

  it('没有 follow 的指针只提供图上解析，不展开', () => {
    const Plain = struct('Plain', 4, [{ name: 'p', offset: 0, kind: 'ptr' as const }]);
    const p: BlueprintPack = { ...pack, types: { Plain } };
    const tree = new StructTree({ kind: 'struct', pack: p, type: Plain, mem, addr: 0x100 });
    const rows = tree.rows(new Set([tree.rootPath]), '');
    const row = rows.find((r) => r.label === 'p');
    expect(row?.expandable).toBe(false);
    expect(row?.ref?.addr).toBe(0x110);
  });
});

describe('结构树从截断处进入', () => {
  it('图上截断信息转换成树里的下标 / 地址焦点', () => {
    expect(focusFromTruncation({ limit: 4096, at: 4096, unit: 'index', canContinue: true }))
      .toMatchObject({ index: 4096 });
    expect(focusFromTruncation({ limit: 4096, at: 0x1a8, unit: 'address', canContinue: true }))
      .toMatchObject({ addr: 0x1a8 });
  });

  it('链表按地址找到下标，不存在的地址返回 undefined', () => {
    const tree = listTree();
    expect(tree.indexOfAddress(0x1a8)).toBe(3);
    expect(tree.indexOfAddress(0x130)).toBe(0);
    expect(tree.indexOfAddress(0x999)).toBeUndefined();
  });

  it('数组按步长换算地址，并能跳到 4096 之后的下标', () => {
    const tree = new StructTree({
      kind: 'array', pack: demoPack, type: demoPack.types.Entry,
      mem: new Memory(new Uint8Array(0x40000), 0), addr: 0x100, count: 5000, stride: 24,
    });
    const at4096 = 0x100 + 4096 * 24;
    expect(tree.indexOfAddress(at4096)).toBe(4096);
    expect(tree.indexOfAddress(at4096 + 1)).toBeUndefined();
    expect(tree.locateIndex(4096)).toEqual({ path: 'Entry[4096]' });
    expect(tree.rows(new Set([tree.rootPath]), '').some((r) => r.path === 'Entry[4096]')).toBe(true);
  });

  it('未声明 max 的链表不再被图上 4096 上限挡住', () => {
    const def = demoPack.nodes.entryList as ListNodeDef;
    const bytes = new Uint8Array(0x400);
    bytes.set(demoBinary());
    const tree = new StructTree({
      kind: 'list', pack: demoPack, type: def.type,
      mem: new Memory(bytes, 0), addr: 0x130, next: def.next, nulls: def.nulls,
    });
    expect(tree.locateIndex(5000).error).not.toContain('超过链表上限');
  });
});
