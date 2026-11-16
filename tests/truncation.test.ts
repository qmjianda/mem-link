/**
 * 截断语义：区分"恰好等于上限且自然结束"与"因上限停止"。
 * 覆盖 spec `blueprint-evaluation` 的两条场景。
 */
import { describe, expect, it } from 'vitest';
import { bytesToBase64 } from '../src/bp/doc';
import { evaluateGraph } from '../src/bp/eval';
import { loadBlueprintPack } from '../src/bp/load';
import type { BPEdge, BPNode, BlueprintPack } from '../src/bp/types';

const CHAIN_PACK = `
const ChainNode = struct('Node', 4, [i32('next', 0)]);

export default definePack({
  name: 'chain-test',
  endian: 'little',
  pointerSize: 4,
  types: { Node: ChainNode },
  nodes: {
    chain: listNode(ChainNode, {
      label: '链',
      max: 256,
      next: (e) => {
        const v = e.value.next;
        return typeof v === 'number' && v >= 0 ? v : null;
      },
    }),
    array: arrayNode(ChainNode, { label: '数组' }),
  },
});
`;

function pack(): BlueprintPack {
  const r = loadBlueprintPack(CHAIN_PACK);
  if (!r.pack) throw new Error(r.error);
  return r.pack;
}

/** 连续 4 字节一项，最后一项 next = -1 */
function chainBytes(items: number): Uint8Array {
  const bytes = new Uint8Array(items * 4);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < items; i++) {
    view.setInt32(i * 4, i === items - 1 ? -1 : (i + 1) * 4, true);
  }
  return bytes;
}

function graph(items: number, nodeId: string, count?: number): { nodes: BPNode[]; edges: BPEdge[] } {
  const bytes = chainBytes(items);
  const nodes: BPNode[] = [
    {
      id: 'f', packId: '', nodeId: 'file', x: 0, y: 0, params: { name: 'chain.bin' },
      source: { name: 'chain.bin', base: 0, data: bytesToBase64(bytes) },
    },
    { id: 'n', packId: 'p1', nodeId, x: 0, y: 0, params: { address: '0' } },
  ];
  const edges: BPEdge[] = [
    { id: 'e', from: { node: 'f', port: 'buffer' }, to: { node: 'n', port: 'buffer' } },
  ];
  if (count != null) {
    nodes.push({ id: 'c', packId: '', nodeId: 'number', x: 0, y: 0, params: { value: String(count) } });
    edges.push({ id: 'ec', from: { node: 'c', port: 'value' }, to: { node: 'n', port: 'count' } });
  }
  return { nodes, edges };
}

function run(items: number, nodeId = 'chain', count?: number) {
  const { nodes, edges } = graph(items, nodeId, count);
  return evaluateGraph(nodes, edges, new Map([['p1', pack()]]));
}

describe('列表截断', () => {
  it('恰好 256 项且末项 next 为空 → 不报截断', () => {
    const r = run(256);
    const view = r.views.get('n');
    expect(view?.kind).toBe('list');
    expect(view && 'count' in view ? view.count : 0).toBe(256);
    expect(view && 'truncated' in view ? view.truncated : undefined).toBe(false);
    expect(view && 'trunc' in view ? view.trunc : undefined).toBeUndefined();
    expect(r.problems.some((p) => p.code === 'TRUNCATED')).toBe(false);
  });

  it('还有后续项 → 截断并给出可继续的地址', () => {
    const r = run(257);
    const view = r.views.get('n');
    expect(view && 'count' in view ? view.count : 0).toBe(256);
    expect(view && 'truncated' in view ? view.truncated : undefined).toBe(true);
    expect(view && 'trunc' in view ? view.trunc : undefined).toEqual({
      limit: 256, at: 1024, unit: 'address', canContinue: true,
    });
    const p = r.problems.find((x) => x.code === 'TRUNCATED');
    expect(p?.nodeKey).toBe('n');
    expect(p?.message).toContain('256');
  });
});

describe('数组截断', () => {
  it('请求数超过上限 → 因上限停止，unit 为下标', () => {
    const r = run(4096, 'array', 4097);
    const view = r.views.get('n');
    expect(view && 'count' in view ? view.count : 0).toBe(4096);
    expect(view && 'trunc' in view ? view.trunc : undefined).toEqual({
      limit: 4096, at: 4096, unit: 'index', canContinue: true,
    });
  });

  it('请求数正好等于上限 → 不报截断', () => {
    const r = run(4096, 'array', 4096);
    const view = r.views.get('n');
    expect(view && 'count' in view ? view.count : 0).toBe(4096);
    expect(view && 'truncated' in view ? view.truncated : undefined).toBe(false);
    expect(view && 'trunc' in view ? view.trunc : undefined).toBeUndefined();
  });
});
