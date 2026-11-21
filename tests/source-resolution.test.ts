/**
 * 数据源解析：值与来源分开。
 * - 字符串/字节端口是**值依赖**（求值该端口，基址 0）；
 * - 其它端口是**来源依赖**（只沿图结构找文件，不求值）；
 * - 继承链自环报 SOURCE_CYCLE，不与值依赖的 CYCLE 混用。
 */
import { describe, expect, it } from 'vitest';
import demoSource from '../samples/demo.bp.ts?raw';
import { bytesToBase64 } from '../src/bp/doc';
import { evaluateGraph } from '../src/bp/eval';
import { loadBlueprintPack } from '../src/bp/load';
import type { BPEdge, BPNode, BlueprintPack } from '../src/bp/types';

function pack(): BlueprintPack {
  const r = loadBlueprintPack(demoSource);
  if (!r.pack) throw new Error(r.error);
  return r.pack;
}

function fileNode(id: string, bytes: number[], base = 0): BPNode {
  return {
    id, packId: '', nodeId: 'file', x: 0, y: 0, params: { name: `${id}.bin` },
    source: { name: `${id}.bin`, base, data: bytesToBase64(new Uint8Array(bytes)) },
  };
}

const header = (id: string, params: Record<string, string> = {}): BPNode =>
  ({ id, packId: 'p', nodeId: 'header', x: 0, y: 0, params: { address: '0', ...params } });

const wire = (id: string, from: [string, string], to: [string, string]): BPEdge =>
  ({ id, from: { node: from[0], port: from[1] }, to: { node: to[0], port: to[1] } });

const packs = new Map([['p', pack()]]);

describe('字符串作为数据源（值依赖）', () => {
  const nodes: BPNode[] = [
    { id: 's', packId: '', nodeId: 'string', x: 0, y: 0, params: { value: 'ABCDEFGH' } },
    header('h'),
  ];
  const edges: BPEdge[] = [wire('e', ['s', 'text'], ['h', 'buffer'])];
  const r = evaluateGraph(nodes, edges, packs);

  it('以基址 0 解析这段文本', () => {
    expect(r.sources.get('h')?.mode).toBe('explicit');
    expect(r.sources.get('h')?.buffer?.base).toBe(0);
    // 'AB' 小端 = 0x4241
    expect(r.outputs.get('h')?.magic).toBe(0x4241);
  });

  it('按内容登记为资产，且不报空连线', () => {
    expect(r.sources.get('h')?.assetId).toBeTruthy();
    expect(r.problems.some((p) => p.nodeKey === 'h' && p.code === 'NO_SOURCE')).toBe(false);
  });
});

describe('非字节端口作为数据源（来源依赖）', () => {
  it('来源线不引入值依赖环，调用方可反向提供计算值', () => {
    const loaded = loadBlueprintPack(`const Dummy = struct('Dummy', [u8('value')]);
    export default definePack({
      name: 'two-way',
      types: { Dummy },
      nodes: {
        producer: calcNode({ inputs: { n: 'number' }, outputs: { buffer: 'buffer', value: 'number' },
          run: ({n}) => ({ value: n }) }),
        consumer: calcNode({ inputs: {}, outputs: { value: 'number' }, run: () => ({ value: 42 }) })
      }
    });`);
    expect(loaded.error).toBeUndefined();
    const a = { ...header('a'), nodeId: 'producer' };
    const b = { ...header('b'), nodeId: 'consumer' };
    const result = evaluateGraph([fileNode('f', [1]), a, b], [
      wire('fa', ['f', 'buffer'], ['a', 'buffer']),
      wire('ab', ['a', 'buffer'], ['b', 'buffer']),
      wire('ba', ['b', 'value'], ['a', 'n']),
    ], new Map([['p', loaded.pack!]]));
    expect(result.outputs.get('a')?.value).toBe(42);
    expect(result.sources.get('b')?.fileId).toBe('f');
    expect(result.problems.some(p => p.code === 'CYCLE')).toBe(false);
  });
  it('数字端口接数据源时不算"文本镜像"', () => {
    const nodes: BPNode[] = [
      { id: 'n', packId: '', nodeId: 'number', x: 0, y: 0, params: { value: '305419896' } },
      header('h'),
    ];
    const edges: BPEdge[] = [wire('e', ['n', 'value'], ['h', 'buffer'])];
    const r = evaluateGraph(nodes, edges, packs);
    expect(r.problems.some((p) => p.nodeKey === 'h' && p.code === 'NO_SOURCE')).toBe(true);
    expect(r.outputs.get('h')?.magic).toBeUndefined();
  });
});

describe('继承链自环', () => {
  it('两个 File 互相作为数据源 → SOURCE_CYCLE，且不出现 CYCLE', () => {
    const nodes = [fileNode('f1', [1, 2, 3, 4]), fileNode('f2', [5, 6, 7, 8])];
    const edges = [
      wire('e1', ['f1', 'buffer'], ['f2', 'buffer']),
      wire('e2', ['f2', 'buffer'], ['f1', 'buffer']),
    ];
    const r = evaluateGraph(nodes, edges, packs);
    expect(r.problems.filter((p) => p.code === 'SOURCE_CYCLE').length).toBeGreaterThan(0);
    expect(r.problems.some((p) => p.code === 'CYCLE')).toBe(false);
    // 两个 File 仍按自己的内容求值
    expect(r.outputs.get('f1')?.size).toBe(4);
    expect(r.outputs.get('f2')?.size).toBe(4);
  });
});

describe('数据源优先级', () => {
  it('直连连线 > 检查器指定', () => {
    const nodes = [fileNode('f1', [1]), fileNode('f2', [2]), header('h', { sourceId: 'f1' })];
    const edges = [wire('e', ['f2', 'buffer'], ['h', 'buffer'])];
    const r = evaluateGraph(nodes, edges, packs);
    expect(r.sources.get('h')?.mode).toBe('explicit');
    expect(r.sources.get('h')?.fileId).toBe('f2');
  });

  it('检查器指定 > 继承', () => {
    const nodes = [fileNode('f1', [1]), fileNode('f2', [2]), header('h1'), header('h2', { sourceId: 'f2' })];
    const edges = [
      wire('e1', ['f1', 'buffer'], ['h1', 'buffer']),
      wire('e2', ['h1', 'head'], ['h2', 'address']),
    ];
    const r = evaluateGraph(nodes, edges, packs);
    expect(r.sources.get('h2')?.mode).toBe('override');
    expect(r.sources.get('h2')?.fileId).toBe('f2');
  });

  it('File 自己就是来源；孤立解析节点落到默认文件', () => {
    const nodes = [fileNode('f1', [1]), header('h')];
    const r = evaluateGraph(nodes, [], packs);
    expect(r.sources.get('f1')?.mode).toBe('file');
    expect(r.sources.get('h')?.mode).toBe('default');
    expect(r.sources.get('h')?.fileId).toBe('f1');
  });
});
