import { describe, expect, it } from 'vitest';
import demoSource from '../samples/demo.bp.ts?raw';
import { loadBlueprintPack } from '../src/bp/load';
import { evaluateGraph } from '../src/bp/eval';
import { bytesToBase64 } from '../src/bp/doc';
import type { BPEdge, BPNode } from '../src/bp/types';
import { demoBinary } from '../src/core/project';

const CODES = [
  'CYCLE', 'NO_SOURCE', 'BAD_INPUT', 'NO_INSTANCE', 'INDEX_OUT_OF_RANGE', 'UNKNOWN_NODE',
  'NODE_MISSING', 'PACK_DISABLED', 'EVAL_FAILED', 'OUT_OF_BOUNDS', 'SOURCE_CONFLICT', 'PORT_MISSING',
];

function pack() {
  const r = loadBlueprintPack(demoSource);
  if (!r.pack) throw new Error(r.error);
  return r.pack;
}

function node(id: string, packId: string, nodeId: string, params: Record<string, string> = {}): BPNode {
  return { id, packId, nodeId, x: 0, y: 0, params };
}

function fileNode(id = 'f'): BPNode {
  return {
    ...node(id, '', 'file', { name: 'demo.bin' }),
    source: { name: 'demo.bin', base: 0, data: bytesToBase64(demoBinary()) },
  };
}

function edge(id: string, from: [string, string], to: [string, string]): BPEdge {
  return { id, from: { node: from[0], port: from[1] }, to: { node: to[0], port: to[1] } };
}

const codeOf = (p: { detail?: string }) => (p.detail ?? '').split(' · ')[0];

describe('问题原因码与文案格式', () => {
  it('缺少缓冲区 → NO_SOURCE，消息仍含「需要缓冲区」', () => {
    const r = evaluateGraph([node('h', 'p', 'header', { address: '0x0' })], [], new Map([['p', pack()]]));
    const p = r.problems.find((x) => x.message.includes('需要缓冲区'));
    expect(p).toBeTruthy();
    expect(codeOf(p!)).toBe('NO_SOURCE');
    // 建议被移到 detail，消息本身只讲事实
    expect(p!.message).not.toContain('File 节点连到');
    expect(p!.detail).toContain('数据源');
  });

  it('地址越界 → OUT_OF_BOUNDS，消息仍含「求值失败」', () => {
    const r = evaluateGraph(
      [fileNode(), node('b', 'p', 'header', { address: '0x400' })],
      [edge('e0', ['f', 'buffer'], ['b', 'buffer'])],
      new Map([['p', pack()]]),
    );
    const p = r.problems.find((x) => x.message.includes('求值失败'));
    expect(p).toBeTruthy();
    expect(codeOf(p!)).toBe('OUT_OF_BOUNDS');
  });

  it('数据源冲突 → SOURCE_CONFLICT，消息仍含「不同的输入文件」', () => {
    const loaded = loadBlueprintPack(demoSource).pack!;
    const r = evaluateGraph(
      [
        fileNode('f1'),
        { ...fileNode('f2'), source: { name: 'other.bin', base: 0, data: bytesToBase64(demoBinary()) } },
        node('h1', 'p', 'header', { address: '0x0' }),
        node('h2', 'q', 'header', { address: '0x0' }),
        node('both', 'p', 'header', { address: '0x0' }),
      ],
      [
        edge('a1', ['f1', 'buffer'], ['h1', 'buffer']),
        edge('a2', ['h1', 'head'], ['both', 'a']),
        edge('a3', ['h2', 'head'], ['both', 'b']),
        edge('a4', ['f2', 'buffer'], ['h2', 'buffer']),
      ],
      new Map([['p', loaded], ['q', loaded]]),
    );
    const p = r.problems.find((x) => x.message.includes('不同的输入文件'));
    expect(p).toBeTruthy();
    expect(codeOf(p!)).toBe('SOURCE_CONFLICT');
  });

  it('pack 缺失 → NODE_MISSING', () => {
    const r = evaluateGraph([node('n', 'gone', 'header', { address: '0x0' })], [], new Map());
    const p = r.problems.find((x) => x.message.includes('找不到节点定义'));
    expect(p).toBeTruthy();
    expect(codeOf(p!)).toBe('NODE_MISSING');
  });

  it('端口消失的连线 → PORT_MISSING，且不再出现「重新连一次即可」', () => {
    const r = evaluateGraph(
      [fileNode(), node('h', 'p', 'header', { address: '0x0' })],
      [
        edge('e0', ['f', 'buffer'], ['h', 'buffer']),
        edge('dead', ['h', 'no-such-port'], ['h', 'address']),
      ],
      new Map([['p', pack()]]),
    );
    const p = r.problems.find((x) => codeOf(x) === 'PORT_MISSING');
    expect(p).toBeTruthy();
    expect(p!.message).toContain('端口');
    expect(JSON.stringify(r.problems)).not.toContain('即可');
  });

  it('所有 problem 的 detail 都以已知原因码开头，消息不含禁用词', () => {
    const r = evaluateGraph(
      [node('h', 'p', 'header', { address: '0x0' }), node('x', 'gone', 'header', {})],
      [edge('e9', ['x', 'head'], ['h', 'address'])],
      new Map([['p', pack()]]),
    );
    expect(r.problems.length).toBeGreaterThan(0);
    for (const p of r.problems) {
      expect(CODES).toContain(codeOf(p));
      for (const banned of ['即可', '只需', '会自动', '不必', '！']) {
        expect(p.message).not.toContain(banned);
      }
    }
  });
});
