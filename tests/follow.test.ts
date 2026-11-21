import { describe, expect, it } from 'vitest';
import demoSource from '../samples/demo.bp.ts?raw';
import { loadBlueprintPack } from '../src/bp/load';
import type { BPNode, BufferValue, InstanceView, NodeView } from '../src/bp/types';
import { brandInstance } from '../src/bp/types';
import { assetIdOf, uniqueBuffers } from '../src/bp/assets';
import {
  bufferIssue, buildFollowItems, elementFollowItem, followAddress, followHint, followTypeIssue,
  inferFollowType, knownTypesAt,
} from '../src/bp/follow';

/** 实例必须带品牌，形状相同也不等于真实元素（见 types.ts 的 WeakSet 登记） */
function inst(addr: number, typeName = 'Sqe', size = 64): InstanceView {
  return brandInstance({ addr, typeName, size, fields: [] });
}

function buf(name: string, base: number, size: number): BufferValue {
  const bytes = new Uint8Array(size);
  return { assetId: assetIdOf(bytes), name, base, bytes };
}

describe('followAddress', () => {
  it('只接受精确的整数地址', () => {
    expect(followAddress(0x1000)).toBe(0x1000);
    expect(followAddress(12.9)).toBeNull();
    expect(followAddress(-4)).toBe(-4);
  });

  it('元素/实例端口取实例自己的地址（回归：双击 elem 端口曾报 NaN）', () => {
    expect(followAddress(inst(0x1200))).toBe(0x1200);
  });

  it('列表、缓冲区、字符串、布尔、空值都没有单一地址', () => {
    expect(followAddress([inst(0x1000)])).toBeNull();
    expect(followAddress(buf('a.bin', 0x1000, 16))).toBeNull();
    expect(followAddress('0x1000')).toBeNull();
    expect(followAddress(true)).toBeNull();
    expect(followAddress(undefined)).toBeNull();
    expect(followAddress(Number.NaN)).toBeNull();
  });
});

describe('followHint', () => {
  it('已声明的偏移和下标不会被当成绝对地址跳转', () => {
    expect(followTypeIssue('offset')).toContain('字节偏移不是地址');
    expect(followTypeIssue('index')).toContain('元素下标不是地址');
    expect(followTypeIssue('address')).toBeUndefined();
  });
  it('列表端口提示展开后双击单个元素', () => {
    expect(followHint([inst(0x1000)])).toContain('展开后双击单个元素');
  });

  it('缓冲区端口提示双击 base', () => {
    expect(followHint(buf('a.bin', 0, 8))).toContain('base 端口');
  });

  it('字符串/布尔/空值给出各自的拒绝原因', () => {
    expect(followHint('x')).toContain('字符串');
    expect(followHint(false)).toContain('布尔');
    expect(followHint(undefined)).toContain('没有输出地址');
  });
});

describe('bufferIssue', () => {
  it('没有缓冲区时引导先载入文件', () => {
    expect(bufferIssue(0x1000, [])).toContain('载入 .bin/.hex');
  });

  it('单个缓冲区给出文件名与实际范围', () => {
    const msg = bufferIssue(0x9000, [buf('nvme.bin', 0x1000, 0x100)]);
    expect(msg).toContain('nvme.bin');
    expect(msg).toContain('0x1000');
    expect(msg).toContain('0x10ff');
  });

  it('多个缓冲区只说不在任何缓冲区内', () => {
    const msg = bufferIssue(0x9000, [buf('a', 0, 16), buf('b', 0x100, 16)]);
    expect(msg).toContain('2 个文件');
  });

  it('负数地址单独说明', () => {
    expect(bufferIssue(-1, [buf('a', 0, 16)])).toContain('地址为负');
  });
});

/* ------------------------------------------------------- 跟随候选与类型推断 */

function demo() {
  const pack = loadBlueprintPack(demoSource).pack!;
  return { packs: new Map([['p', pack]]), packNames: new Map([['p', 'demo-index-list']]) };
}

describe('在此地址解析：候选清单', () => {
  const { packs, packNames } = demo();

  it('列出全部按地址工作的内置解析节点，且不重复元素解析', () => {
    const items = buildFollowItems({ packs, packNames });
    const builtins = items.filter((i) => i.packId === '' && !i.structureId).map((i) => i.nodeId);
    expect(builtins.sort()).toEqual(['arrayread', 'listread', 'ptrwalk', 'readint', 'slice', 'structread', 'text']);
    expect(items.find((item) => item.nodeId === 'ptrwalk')?.inputPort).toBe('address');
    expect(items.find((item) => item.nodeId === 'readint')?.inputPort).toBe('address');
  });

  it('包含 pack 里的结构体 / 链表 / 数组节点并保留分组', () => {
    const items = buildFollowItems({ packs, packNames });
    const groups = new Map(items.map((i) => [i.nodeId, i.group]));
    expect(groups.get('header')).toBe('结构体');
    expect(groups.get('meta')).toBe('结构体');
    expect(groups.get('entryList')).toBe('链表');
    expect(groups.get('entryArray')).toBe('数组');
    // calc 节点不是解析入口
    expect(groups.has('indexToAddr')).toBe(false);
  });

  it('禁用的 pack 不进入候选', () => {
    const items = buildFollowItems({ packs, packNames, isEnabled: () => false });
    expect(items.filter((i) => i.packId !== '')).toEqual([]);
    expect(items.length).toBeGreaterThan(0); // 内置节点仍在
  });

  it('元素解析只在类型可推断时提供', () => {
    expect(elementFollowItem(null)).toBeNull();
    expect(elementFollowItem(undefined)).toBeNull();
    const item = elementFollowItem({
      packId: 'p', typeName: 'Entry', reason: '沿用来源元素类型 Entry',
    });
    expect(item?.recommended).toBe(true);
    expect(item?.nodeId).toBe('element');
    expect(item?.typePackId).toBe('p');
    expect(item?.typeName).toBe('Entry');
    expect(item?.detail).toContain('Entry');
    expect(item?.detail).toContain('自适应');
  });
});

describe('在此地址解析：类型推断', () => {
  const { packs } = demo();

  it('来源是元素时沿用它的类型', () => {
    const hint = inferFollowType({
      value: inst(0x130, 'Entry', 24),
      address: 0x130,
      packs,
      sourcePackId: 'p',
    });
    expect(hint).toMatchObject({ packId: 'p', typeName: 'Entry' });
    expect(hint?.reason).toContain('Entry');
  });

  it('地址上已有同类型实例时给出推荐', () => {
    const knownAt = new Map([[0x130, { packId: 'p', typeName: 'Entry' }]]);
    const hint = inferFollowType({ value: 0x130, address: 0x130, packs, knownAt });
    expect(hint?.typeName).toBe('Entry');
    expect(hint?.reason).toContain('已按');
  });

  it('普通数字不做来源类型推断（Header.head 通常指向另一种结构）', () => {
    expect(inferFollowType({ value: 0x130, address: 0x130, packs })).toBeNull();
  });

  it('同一地址出现多种类型时不替用户猜', () => {
    const nodes = [
      { id: 'a', packId: 'p', nodeId: 'header', x: 0, y: 0, params: {} },
      { id: 'b', packId: 'p', nodeId: 'header', x: 0, y: 0, params: {} },
    ] as BPNode[];
    const views = new Map<string, NodeView>([
      ['a', { kind: 'struct', inst: inst(0x1000, 'Header', 8) }],
      ['b', { kind: 'struct', inst: inst(0x1000, 'Entry', 24) }],
    ]);
    const at = knownTypesAt(nodes, views);
    expect(at.get(0x1000)?.ambiguous).toBe(true);
    expect(inferFollowType({ value: 0x1000, address: 0x1000, packs, knownAt: at })).toBeNull();
  });

  it('从求值视图收集地址上的已知类型', () => {
    const nodes = [
      { id: 'h', packId: 'p', nodeId: 'header', x: 0, y: 0, params: {} },
      { id: 'l', packId: 'p', nodeId: 'entryList', x: 0, y: 0, params: {} },
      { id: 'e', packId: '', nodeId: 'element', x: 0, y: 0, params: { packId: 'p' } },
    ] as BPNode[];
    const views = new Map<string, NodeView>([
      ['h', { kind: 'struct', inst: inst(0, 'Header', 8) }],
      ['l', { kind: 'list', items: [inst(0x130, 'Entry', 24)], count: 1 }],
      ['e', { kind: 'element', inst: inst(0x1a8, 'Entry', 24) }],
    ]);
    const at = knownTypesAt(nodes, views);
    expect(at.get(0)).toMatchObject({ packId: 'p', typeName: 'Header' });
    expect(at.get(0x130)).toMatchObject({ packId: 'p', typeName: 'Entry' });
    expect(at.get(0x1a8)).toMatchObject({ packId: 'p', typeName: 'Entry' });
  });
});

describe('跟随地址的缓冲区去重', () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const id = assetIdOf(bytes);
  const info = (base: number, name = 'a.bin') => ({
    mode: 'file' as const,
    chain: ['f'],
    buffer: { assetId: id, name, base, bytes },
  });

  it('同内容同基址合并为一条（重命名不影响身份）', () => {
    expect(uniqueBuffers([info(0), info(0, 'b.bin')])).toHaveLength(1);
  });

  it('同内容不同基址各留一条', () => {
    const out = uniqueBuffers([info(0), info(0x1000)]);
    expect(out.map((b) => b.base)).toEqual([0, 0x1000]);
  });

  it('同名同长不同内容不互相顶替', () => {
    const other = new Uint8Array([3, 2, 1]);
    const out = uniqueBuffers([
      info(0),
      { mode: 'file', chain: ['g'], buffer: { assetId: assetIdOf(other), name: 'a.bin', base: 0, bytes: other } },
    ]);
    expect(out).toHaveLength(2);
  });
});
