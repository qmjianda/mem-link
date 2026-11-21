import { describe, expect, it } from 'vitest';
import { initialParseParams } from '../src/bp/add-defaults';
import { bytesToBase64 } from '../src/bp/doc';
import { definePack, structNode } from '../src/bp/dsl';
import { evaluateGraph } from '../src/bp/eval';
import { emptySelection, selectOnlyNode } from '../src/bp/selection';
import type { BPEdge, BPNode } from '../src/bp/types';
import { struct, u8 } from '../src/core/pack';

function node(id: string, packId: string, nodeId: string, params: BPNode['params'] = {}): BPNode {
  return { id, packId, nodeId, x: 0, y: 0, params };
}

function file(id: string, base: number, value: number): BPNode {
  return {
    ...node(id, '', 'file'),
    source: { name: `${id}.bin`, base, data: bytesToBase64(Uint8Array.of(value, value)) },
  };
}

const Entry = struct('Entry', [u8('value')]);
const packs = new Map([['p', definePack({ types: { Entry }, nodes: { entry: structNode(Entry) } })]]);
const first = file('first', 0x1000, 1);
const second = file('second', 0x1000, 2);

describe('新增解析节点的上下文默认值', () => {
  it('同地址的两份 dump：选中第二份时，新节点确实读取第二份的字节', () => {
    const nodes = [first, second];
    const params = initialParseParams(nodes, selectOnlyNode('second'), evaluateGraph(nodes, [], packs));
    expect(params).toEqual({ address: '0x1000', sourceId: 'second' });
    const result = evaluateGraph([...nodes, node('new', 'p', 'entry', params)], [], packs);
    expect(result.outputs.get('new')?.value).toBe(2);
  });

  it('复用连线求得的地址，而非断线后才使用的手填值', () => {
    const selected = node('parse', 'p', 'entry', { address: '0x1000', sourceId: 'second' });
    const nodes = [first, second, selected, node('addr', '', 'number', { value: '0x1001' })];
    const edges: BPEdge[] = [
      { id: 'e', from: { node: 'addr', port: 'value' }, to: { node: 'parse', port: 'address' } },
    ];
    expect(initialParseParams(nodes, selectOnlyNode('parse'), evaluateGraph(nodes, edges, packs)))
      .toEqual({ address: '0x1001', sourceId: 'second' });
  });

  it('保留有效的零地址', () => {
    const nodes = [first, file('zero', 0, 3), node('parse', 'p', 'entry', { address: '0', sourceId: 'zero' })];
    expect(initialParseParams(nodes, selectOnlyNode('parse'), evaluateGraph(nodes, [], packs)))
      .toEqual({ address: '0x0', sourceId: 'zero' });
  });

  it('地址越界时使用同一份文件的基址', () => {
    const nodes = [first, second, node('parse', 'p', 'entry', { address: '0x2000', sourceId: 'second' })];
    expect(initialParseParams(nodes, selectOnlyNode('parse'), evaluateGraph(nodes, [], packs)))
      .toEqual({ address: '0x1000', sourceId: 'second' });
  });

  it('单文件无选中时预填基址，不锁定数据源；多文件无选中时保留原默认值', () => {
    expect(initialParseParams([first], emptySelection(), evaluateGraph([first], [], packs)))
      .toEqual({ address: '0x1000' });
    expect(initialParseParams([first, second], emptySelection(), evaluateGraph([first, second], [], packs)))
      .toEqual({ address: '0x0' });
  });

  it('缓存中缺失字节的文件记录不会被当作已载入的唯一来源', () => {
    const nodes = [{ ...first, source: { ...first.source!, data: '' } }, second];
    expect(initialParseParams(nodes, emptySelection(), evaluateGraph(nodes, [], packs)))
      .toEqual({ address: '0x0' });
  });
});
